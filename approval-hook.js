#!/usr/bin/env node
//
// Claude Code PreToolUse hook
// - Telegram sessions → full blocking approval on Telegram
// - Terminal sessions → Telegram buttons + local file signal (race: first wins)
//

const http = require('http')
const fs = require('fs')

const APPROVAL_REQUIRED = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])
const LOCAL_APPROVE_FILE = '/tmp/ca'

let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input)

    if (!APPROVAL_REQUIRED.has(data.tool_name)) {
      process.exit(0)
    }

    const modeReq = http.request({
      hostname: '127.0.0.1', port: parseInt(process.env.APPROVAL_PORT || '3456'), path: '/mode',
      method: 'GET', timeout: 2000
    }, (modeRes) => {
      let modeBody = ''
      modeRes.on('data', d => modeBody += d)
      modeRes.on('end', () => {
        try {
          const { mode } = JSON.parse(modeBody)
          const fromTelegram = !!process.env.CLAUDE_FROM_TELEGRAM

          if (mode === 'off') return process.exit(0)
          if (mode === 'telegram' && !fromTelegram) return process.exit(0)

          if (fromTelegram) {
            sendBlockingApproval(data, true)
          } else {
            sendDualApproval(data)
          }
        } catch { process.exit(0) }
      })
    })
    modeReq.on('error', () => process.exit(0))
    modeReq.on('timeout', () => { modeReq.destroy(); process.exit(0) })
    modeReq.end()

  } catch (err) {
    process.stderr.write(`Hook error: ${err.message}\n`)
    process.exit(0)
  }
})

// ── Terminal: race between Telegram buttons AND local file signal ──────────
function sendDualApproval(data) {
  const tool = data.tool_name || '?'
  const cmd = data.tool_input?.command || data.tool_input?.file_path || ''

  // Clean up any stale signal file
  try { fs.unlinkSync(LOCAL_APPROVE_FILE) } catch {}

  process.stderr.write(`\n⏳ ${tool}${cmd ? ` — ${cmd.slice(0, 80)}` : ''}\n`)
  process.stderr.write(`   📱 Approuve sur Telegram\n`)
  process.stderr.write(`   💻 Ou: touch ${LOCAL_APPROVE_FILE}\n`)
  process.stderr.write(`   ⏱  Auto-approve 60s\n\n`)

  let resolved = false

  function finish(output) {
    if (resolved) return
    resolved = true
    clearInterval(fileWatcher)
    try { fs.unlinkSync(LOCAL_APPROVE_FILE) } catch {}
    if (output) process.stdout.write(output)
    process.exit(0)
  }

  // Watch for local file signal (check every 500ms)
  const fileWatcher = setInterval(() => {
    try {
      if (fs.existsSync(LOCAL_APPROVE_FILE)) {
        finish(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
        }))
      }
    } catch {}
  }, 500)

  // Send to Telegram (blocking — will resolve when user clicks button or timeout)
  sendBlockingApproval(data, false, (body) => {
    finish(body)
  })

  // Safety timeout: auto-approve after 60s
  setTimeout(() => {
    if (!resolved) {
      process.stderr.write('⏱ Auto-approve (60s)\n')
      finish(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
      }))
    }
  }, 60000)
}

// ── Telegram: full blocking approval ──────────────────────────────────────
function sendBlockingApproval(data, fromTelegram, callback) {
  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_SESSION_ID || ''
  const payload = JSON.stringify({ ...data, from_telegram: fromTelegram, session_id: sessionId })
  const req = http.request({
    hostname: '127.0.0.1', port: parseInt(process.env.APPROVAL_PORT || '3456'), path: '/approval',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 180000
  }, (res) => {
    let body = ''
    res.on('data', d => body += d)
    res.on('end', () => {
      if (callback) {
        callback(body)
      } else {
        try { process.stdout.write(body) } catch {}
        process.exit(0)
      }
    })
  })
  req.on('error', () => {
    if (callback) callback(null)
    else process.exit(0)
  })
  req.on('timeout', () => {
    req.destroy()
    if (callback) callback(null)
    else process.exit(0)
  })
  req.write(payload)
  req.end()
}
