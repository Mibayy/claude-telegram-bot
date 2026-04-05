'use strict'
// ─── Claude Telegram Bot — Entry Point ─────────────────────────────────────
// Thin orchestrator: loads modules, creates bot, wires handlers, starts servers.

const TelegramBot = require('node-telegram-bot-api')

// ─── Modules ───────────────────────────────────────────────────────────────

const state   = require('./state')
const fmt     = require('./utils/format')
const tools   = require('./utils/tools')
const agents  = require('./agents')
const memory  = require('./memory')
const notes   = require('./notes')
const reminders = require('./reminders')
const monitor = require('./monitor')
const { createApprovalServer } = require('./server/approval')
const { createWebUIServer } = require('./server/webui')
const process_ = require('./process')

// ─── Handlers ──────────────────────────────────────────────────────────────

const registerCommands  = require('./handlers/commands')
const registerMedia     = require('./handlers/media')
const registerCallbacks = require('./handlers/callbacks')

// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN env var required')
  process.exit(1)
}

// ─── Load persisted state ──────────────────────────────────────────────────

state.loadState()

// ─── Bot Setup ─────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, {
  polling: { params: { timeout: 30 }, interval: 1000 }
})

bot.on('polling_error', (err) => {
  state.incrPollingErrors()
  const now = Date.now()
  if (now - state.getLastPollingError() > 30000) {
    console.error(`[POLLING] ${err.code} ${err.message} (total: ${state.getPollingErrors()})`)
    state.setLastPollingError(now)
  }
  if (state.getPollingErrors() > 10 && now - state.getLastPollingError() < 5000) {
    console.log('[POLLING] Too many errors, restarting in 10s...')
    bot.stopPolling()
    setTimeout(() => {
      state.resetPollingErrors()
      bot.startPolling()
      console.log('[POLLING] Polling restarted')
    }, 10000)
  }
})
bot.on('error', (err) => console.error('[BOT]', err.code, err.message))
console.log('Claude Telegram bot started — polling active')

// ─── Set bot reference for zombie cleanup ──────────────────────────────────

state.setBotRef(bot)

// ─── Initialize process module ─────────────────────────────────────────────

process_.init(bot, { state, fmt, agents, memory })
const { processMessage } = process_

// ─── Dependency bundle for handlers ────────────────────────────────────────

const deps = {
  state,
  processMessage,
  fmt,
  tools,
  agents,
  memory,
  notes,
  reminders,
  monitor,
}

// ─── Register handlers ─────────────────────────────────────────────────────

registerCommands(bot, deps)
registerMedia(bot, deps)
registerCallbacks(bot, deps)

// ─── Start servers ─────────────────────────────────────────────────────────

const approvalServer = createApprovalServer(bot, state, fmt.escHtml, {
  port: state.APPROVAL_PORT,
  allowedUserId: state.ALLOWED_USER_ID,
  timeoutTg: state.APPROVAL_TIMEOUT_TG,
  timeoutTerm: state.APPROVAL_TIMEOUT_TERM,
})

const webApprovalServer = createWebUIServer(state, {
  port: state.WEB_APPROVAL_PORT,
  token: state.WEB_APPROVAL_TOKEN,
})

// ─── Service monitoring ────────────────────────────────────────────────────

if (state.ALLOWED_USER_ID) {
  monitor.start((alertMsg) => {
    bot.sendMessage(state.ALLOWED_USER_ID, alertMsg, { parse_mode: 'HTML' }).catch(() => {})
  }, 60000)
  console.log('Service monitor started — checking every 60s')
}

// ─── Graceful Shutdown ─────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received — cleaning up...`)
  for (const [chatId, session] of state.activeSessions) {
    console.log(`[SHUTDOWN] Killing Claude process for chat ${chatId}`)
    clearTimeout(session.timer)
    try { session.proc.kill('SIGTERM') } catch {}
  }
  state.activeSessions.clear()
  for (const [id, pending] of state.pendingApprovals) {
    clearTimeout(pending.timer)
    pending.resolve({ decision: 'deny', reason: 'Bot shutting down' })
  }
  state.pendingApprovals.clear()
  monitor.stop()
  approvalServer.close()
  webApprovalServer.close()
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message, err.stack)
})
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION]', reason)
})
