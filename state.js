'use strict'

const fs = require('fs')
const path = require('path')

// ─── Config Constants ──────────────────────────────────────────────────────

const MAX_MSG = 4096
const CLAUDE_TIMEOUT_MS = 600000       // 10 min
const APPROVAL_TIMEOUT_TG = 120000     // 2 min for Telegram sessions
const APPROVAL_TIMEOUT_TERM = 60000    // 1 min for terminal sessions
const APPROVAL_PORT = parseInt(process.env.APPROVAL_PORT || '3456')
const STREAM_INTERVAL = 4000           // 4s between streaming updates
const STATE_FILE = path.join(__dirname, '.state.json')
const MAX_HISTORY = 8
const KNOWN_PROJECTS = [
  'hermes-agent', 'claude-telegram-bot', 'improvence', 'estalle',
  'mapetiteasso', 'vps-monitor', 'eclatauto', 'token-savior'
]

// ─── State Maps & Sets ─────────────────────────────────────────────────────

const activeSessions      = new Map()  // chatId -> { proc, timer, longRunTimer, statusMsgId }
const conversationIds     = new Map()  // chatId -> sessionId
const pendingApprovals    = new Map()  // requestId -> { resolve, timer }
const autoApproveSessions = new Set()  // session IDs with "approve all"
const messageQueues       = new Map()  // chatId -> [{ prompt, filePaths }]
const currentProjects     = new Map()  // chatId -> projectName
const lastPrompts         = new Map()  // chatId -> { prompt, filePaths }
const verboseLevels       = new Map()  // chatId -> 0|1|2
const pendingMedia        = new Map()  // chatId -> { type, content, fileName, time }
const pendingPdfQA        = new Map()  // chatId -> pdfText (waiting for user question)
const albumBuffers        = new Map()  // media_group_id -> { chatId, photos, caption, timer }
const pageStore           = new Map()  // chatId -> { chunks, parseMode, idx }
const processedMsgs       = new Set()  // cleared when > 200
const fastModeUsers       = new Set()  // chatIds
const userTimeouts        = new Map()  // chatId -> ms
const lastBotMessages     = new Map()  // chatId -> messageId
const promptHistory       = new Map()  // chatId -> [{prompt, label, time}]
const pendingApprovalDetails = new Map() // requestId -> { tool_name, tool_input, session_id, time }

// ─── Env config ────────────────────────────────────────────────────────────
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_USER_ID || '0')
const WEB_APPROVAL_TOKEN = process.env.WEB_APPROVAL_TOKEN || ''
const WEB_APPROVAL_PORT = parseInt(process.env.WEB_APPROVAL_PORT || '3457')

// ─── Private state (accessed via getters/setters) ──────────────────────────

let _approvalMode = 'all'              // 'all' | 'telegram' | 'off'
const processStartTime = Date.now()
let _pollingErrors = 0
let _lastPollingError = 0

// ─── Bot reference (for zombie cleanup alerts) ─────────────────────────────

let _botRef = null

function setBotRef(bot) {
  _botRef = bot
}

// ─── Approval mode getter/setter ───────────────────────────────────────────

function getApprovalMode() {
  return _approvalMode
}

function setApprovalMode(mode) {
  _approvalMode = mode
}

// ─── Polling error helpers ─────────────────────────────────────────────────

function incrPollingErrors() {
  _pollingErrors++
  return _pollingErrors
}

function getPollingErrors() {
  return _pollingErrors
}

function resetPollingErrors() {
  _pollingErrors = 0
}

function getLastPollingError() {
  return _lastPollingError
}

function setLastPollingError(t) {
  _lastPollingError = t
}

// ─── Persist / Restore State ───────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      if (data.conversationIds) {
        for (const [k, v] of Object.entries(data.conversationIds)) {
          conversationIds.set(parseInt(k), v)
        }
      }
      if (data.currentProjects) {
        for (const [k, v] of Object.entries(data.currentProjects)) {
          currentProjects.set(parseInt(k), v)
        }
      }
      if (data.approvalMode) _approvalMode = data.approvalMode
      if (data.promptHistory) {
        for (const [k, v] of Object.entries(data.promptHistory)) {
          if (Array.isArray(v) && v.length > 0) promptHistory.set(parseInt(k), v)
        }
      }
      console.log(`State restored: ${conversationIds.size} conversations, ${currentProjects.size} projects, ${promptHistory.size} histories`)
    }
  } catch (err) {
    console.error('[STATE] Load error:', err.message)
  }
}

function saveState() {
  try {
    const histObj = {}
    for (const [k, v] of promptHistory) {
      if (v.length > 0) histObj[String(k)] = v.slice(-MAX_HISTORY)
    }
    const data = {
      conversationIds: Object.fromEntries(conversationIds),
      currentProjects: Object.fromEntries(currentProjects),
      approvalMode: _approvalMode,
      promptHistory: histObj
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[STATE] Save error:', err.message)
  }
}

// ─── Prompt History ────────────────────────────────────────────────────────

function addToHistory(chatId, prompt) {
  if (!prompt || prompt.trim().length < 3) return
  if (!promptHistory.has(chatId)) promptHistory.set(chatId, [])
  const hist = promptHistory.get(chatId)
  if (hist.length > 0 && hist[hist.length - 1].prompt === prompt) return
  const label = prompt.length > 55 ? prompt.slice(0, 52) + '\u2026' : prompt
  hist.push({ prompt, label, time: Date.now() })
  if (hist.length > MAX_HISTORY) hist.shift()
}

// ─── Timeout helper ────────────────────────────────────────────────────────

function getTimeout(chatId) {
  return userTimeouts.get(chatId) || CLAUDE_TIMEOUT_MS
}

// ─── Periodic Cleanup Intervals ────────────────────────────────────────────

// Every 30 min: prune lastPrompts, conversationIds, detect zombie sessions
setInterval(() => {
  const MAX_CONVERSATIONS = 50
  const MAX_PROMPTS = 20

  // Cap lastPrompts (least recently used)
  if (lastPrompts.size > MAX_PROMPTS) {
    const keys = [...lastPrompts.keys()]
    for (let i = 0; i < keys.length - MAX_PROMPTS; i++) {
      lastPrompts.delete(keys[i])
    }
    console.log(`[CLEANUP] Pruned lastPrompts to ${lastPrompts.size}`)
  }

  // Cap conversationIds
  if (conversationIds.size > MAX_CONVERSATIONS) {
    const keys = [...conversationIds.keys()]
    for (let i = 0; i < keys.length - MAX_CONVERSATIONS; i++) {
      conversationIds.delete(keys[i])
    }
    saveState()
    console.log(`[CLEANUP] Pruned conversationIds to ${conversationIds.size}`)
  }

  // Detect zombie processes — check if PID still exists
  for (const [chatId, session] of activeSessions) {
    try {
      process.kill(session.proc.pid, 0)
    } catch {
      console.log(`[CLEANUP] Zombie session detected for chat ${chatId}, cleaning up`)
      clearTimeout(session.timer)
      activeSessions.delete(chatId)
      if (_botRef) {
        _botRef.sendMessage(chatId, '\u26a0\ufe0f Session pr\u00e9c\u00e9dente termin\u00e9e (process disparu). Tu peux renvoyer ton message.').catch(() => {})
      }
    }
  }
}, 30 * 60 * 1000)

// Every 5 min: clear processedMsgs if > 200, clear stale pendingMedia & pendingPdfQA
setInterval(() => {
  if (processedMsgs.size > 200) {
    processedMsgs.clear()
    console.log('[CLEANUP] Cleared processedMsgs (was > 200)')
  }

  // Clear stale pendingMedia (> 5 min old)
  const fiveMinAgo = Date.now() - 5 * 60 * 1000
  for (const [chatId, media] of pendingMedia) {
    if (media.time && media.time < fiveMinAgo) {
      pendingMedia.delete(chatId)
      console.log(`[CLEANUP] Cleared stale pendingMedia for chat ${chatId}`)
    }
  }

  // Clear stale pendingPdfQA (> 5 min — no timestamp stored, just clear all)
  if (pendingPdfQA.size > 0) {
    // pendingPdfQA entries don't have timestamps, so we clear if any exist after 5 min
    // To be more precise, we'd need timestamps — for now just log count
    // They get cleared naturally when user sends a follow-up message
  }
}, 5 * 60 * 1000)

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  // Config constants
  MAX_MSG,
  CLAUDE_TIMEOUT_MS,
  APPROVAL_TIMEOUT_TG,
  APPROVAL_TIMEOUT_TERM,
  APPROVAL_PORT,
  STREAM_INTERVAL,
  STATE_FILE,
  MAX_HISTORY,
  KNOWN_PROJECTS,

  // State Maps & Sets
  activeSessions,
  conversationIds,
  pendingApprovals,
  autoApproveSessions,
  messageQueues,
  currentProjects,
  lastPrompts,
  verboseLevels,
  pendingMedia,
  pendingPdfQA,
  albumBuffers,
  pageStore,
  processedMsgs,
  fastModeUsers,
  userTimeouts,
  lastBotMessages,
  promptHistory,
  pendingApprovalDetails,
  processStartTime,
  ALLOWED_USER_ID,
  WEB_APPROVAL_TOKEN,
  WEB_APPROVAL_PORT,

  // Functions
  loadState,
  saveState,
  addToHistory,
  getTimeout,
  setBotRef,
  getApprovalMode,
  setApprovalMode,
  incrPollingErrors,
  getPollingErrors,
  resetPollingErrors,
  getLastPollingError,
  setLastPollingError
}
