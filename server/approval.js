'use strict'
const http = require('http')

// NOTE: state must expose:
//   - state.pendingApprovals (Map)
//   - state.autoApproveSessions (Set)
//   - state.pendingApprovalDetails (Map)  — shared with webui.js
//   - state.getApprovalMode() -> string

function formatApproval(data, escHtml) {
  const tool = data.tool_name || 'Unknown'
  const input = data.tool_input || {}

  if (tool === 'Bash') {
    const cmd = (input.command || '(vide)').slice(0, 800)
    return `💻 <b>Commande terminal</b>\n\n<pre>$ ${escHtml(cmd)}</pre>`
  }
  if (tool === 'Edit') {
    const file = escHtml(input.file_path || '?')
    const old = escHtml((input.old_string || '').slice(0, 250))
    const nw = escHtml((input.new_string || '').slice(0, 250))
    return `🔧 <b>Modification</b>\n📄 <code>${file}</code>\n\n<pre>- ${old}${old.length >= 250 ? '…' : ''}\n+ ${nw}${nw.length >= 250 ? '…' : ''}</pre>`
  }
  if (tool === 'Write') {
    const file = escHtml(input.file_path || '?')
    const lines = (input.content || '').split('\n').length
    return `📝 <b>Création fichier</b>\n📄 <code>${file}</code>\n(${lines} lignes)`
  }
  const inputStr = escHtml(JSON.stringify(input, null, 2).slice(0, 400))
  return `🔧 <b>Outil: ${escHtml(tool)}</b>\n\n<pre>${inputStr}</pre>`
}

/**
 * Creates the approval HTTP server.
 *
 * @param {object} bot       - Telegram bot instance
 * @param {object} state     - State module (pendingApprovals, autoApproveSessions, pendingApprovalDetails, getApprovalMode)
 * @param {function} escHtml - HTML escape function
 * @param {object} config    - { port, allowedUserId, timeoutTg, timeoutTerm }
 * @returns {http.Server}
 */
function createApprovalServer(bot, state, escHtml, config) {
  const server = http.createServer((req, res) => {
    // GET /mode — hook checks current mode
    if (req.method === 'GET' && req.url === '/mode') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ mode: state.getApprovalMode() }))
    }

    if (req.method !== 'POST' || req.url !== '/approval') {
      res.writeHead(404)
      return res.end()
    }

    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const data = JSON.parse(body)
        const sessionId = data.session_id || ''
        const fromTelegram = data.from_telegram === true
        const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

        // Notify-only: terminal session informing Telegram, Claude Code handles natively
        if (data.notify_only === true) {
          const msg = formatApproval(data, escHtml)
          bot.sendMessage(config.allowedUserId, `🖥 <i>Terminal — approbation sur PC</i>\n\n${msg}`, { parse_mode: 'HTML' }).catch(() => {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
        }

        // Mode check
        const approvalMode = state.getApprovalMode()
        if (approvalMode === 'off') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
        }
        if (approvalMode === 'telegram' && !fromTelegram) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
        }

        // Auto-approve session
        if (state.autoApproveSessions.has(sessionId)) {
          const msg = formatApproval(data, escHtml)
          bot.sendMessage(config.allowedUserId, `⚡ Auto\n\n${msg}`, { parse_mode: 'HTML' }).catch(() => {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
        }

        // Send Telegram buttons
        const msg = formatApproval(data, escHtml)
        const source = fromTelegram ? '' : '\n🖥 <i>depuis terminal</i>'
        await bot.sendMessage(config.allowedUserId, `${msg}${source}`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ OK', callback_data: `approve:${requestId}` },
              { text: '❌ Non', callback_data: `deny:${requestId}` },
              { text: '⚡ Tout OK', callback_data: `approveall:${requestId}:${sessionId}` }
            ]]
          }
        })

        // Timeout: terminal auto-approves, Telegram denies
        const timeoutMs = fromTelegram ? config.timeoutTg : config.timeoutTerm
        const timer = setTimeout(() => {
          state.pendingApprovals.delete(requestId)
          const decision = fromTelegram ? 'deny' : 'allow' // terminal: auto-approve on timeout
          const reason = fromTelegram ? 'Timeout — pas de réponse en 2 min' : 'Auto-approve terminal (timeout 1 min)'
          if (!fromTelegram) {
            bot.sendMessage(config.allowedUserId, '⏱ Auto-approuvé (timeout terminal)').catch(() => {})
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason }
          }))
        }, timeoutMs)

        state.pendingApprovals.set(requestId, {
          resolve: (decision) => {
            clearTimeout(timer)
            state.pendingApprovals.delete(requestId)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(decision))
          },
          timer
        })

      } catch (err) {
        console.error('[APPROVAL]', err.message)
        res.writeHead(400)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
  })

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Approval server listening on :${config.port}`)
  })

  return server
}

module.exports = { createApprovalServer, formatApproval }
