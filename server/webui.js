'use strict'
const http = require('http')

// NOTE: state must expose:
//   - state.pendingApprovals (Map)
//   - state.pendingApprovalDetails (Map)  — requestId -> { tool_name, tool_input, session_id, time }
//   - state.autoApproveSessions (Set)
//   - state.getApprovalMode() -> string

const WEB_UI_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude — Approbations</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px }
  h1 { font-size: 1.4rem; font-weight: 600; color: #90cdf4; margin-bottom: 6px }
  .sub { color: #718096; font-size: .85rem; margin-bottom: 24px }
  .mode { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: .75rem; font-weight: 600; margin-left: 8px }
  .mode-all { background: #2d3748; color: #fc8181 }
  .mode-telegram { background: #2d3748; color: #68d391 }
  .mode-off { background: #2d3748; color: #90cdf4 }
  #list { display: flex; flex-direction: column; gap: 16px }
  .card { background: #1a202c; border: 1px solid #2d3748; border-radius: 12px; padding: 20px }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px }
  .tool-icon { font-size: 1.4rem }
  .tool-name { font-weight: 600; font-size: 1rem; color: #90cdf4 }
  .tool-time { color: #718096; font-size: .78rem; margin-left: auto }
  .tool-input { background: #0f1117; border: 1px solid #2d3748; border-radius: 8px; padding: 12px; font-family: 'JetBrains Mono', monospace; font-size: .82rem; white-space: pre-wrap; word-break: break-all; max-height: 220px; overflow-y: auto; color: #e2e8f0; margin-bottom: 16px }
  .actions { display: flex; gap: 10px; flex-wrap: wrap }
  button { padding: 9px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: .88rem; transition: opacity .15s }
  button:hover { opacity: .85 }
  button:active { opacity: .7 }
  .btn-approve { background: #276749; color: #9ae6b4 }
  .btn-deny { background: #742a2a; color: #feb2b2 }
  .btn-all { background: #1a365d; color: #90cdf4 }
  .empty { text-align: center; padding: 60px 20px; color: #4a5568 }
  .empty-icon { font-size: 3rem; margin-bottom: 12px }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #276749; color: #9ae6b4; padding: 10px 18px; border-radius: 8px; font-weight: 600; display: none }
</style>
</head>
<body>
<h1>🤖 Claude — Approbations <span id="mode-badge" class="mode"></span></h1>
<p class="sub" id="subtitle">Chargement...</p>
<div id="list"></div>
<div class="toast" id="toast"></div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || ''
let lastCount = -1

function toolIcon(name) {
  if (!name) return '⚙️'
  if (name === 'Bash') return '🖥️'
  if (name === 'Edit') return '✏️'
  if (name === 'Write') return '📝'
  if (name === 'Read') return '📄'
  if (name.includes('token-savior')) return '🔍'
  if (name.includes('github')) return '🐙'
  return '⚙️'
}

function formatInput(name, input) {
  if (name === 'Bash') return '$ ' + (input.command || '').slice(0, 1500)
  if (name === 'Edit') {
    const f = input.file_path || '?'
    const o = (input.old_string || '').slice(0, 300)
    const n = (input.new_string || '').slice(0, 300)
    return f + '\\n\\n- ' + o + (o.length >= 300 ? '…' : '') + '\\n+ ' + n + (n.length >= 300 ? '…' : '')
  }
  if (name === 'Write') return (input.file_path || '?') + '  (' + ((input.content || '').split('\\n').length) + ' lignes)'
  return JSON.stringify(input, null, 2).slice(0, 800)
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return s + 's'
  return Math.round(s/60) + 'min'
}

function showToast(msg, ok = true) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.style.background = ok ? '#276749' : '#742a2a'
  t.style.color = ok ? '#9ae6b4' : '#feb2b2'
  t.style.display = 'block'
  setTimeout(() => t.style.display = 'none', 2500)
}

async function action(id, decision) {
  try {
    const r = await fetch('/action?token=' + TOKEN + '&id=' + id + '&decision=' + decision)
    const d = await r.json()
    if (d.ok) showToast(decision === 'deny' ? '❌ Refusé' : decision === 'approve_all' ? '✅✅ Tout approuvé' : '✅ Approuvé')
    else showToast('Erreur: ' + (d.error || '?'), false)
  } catch(e) { showToast('Erreur réseau', false) }
}

async function poll() {
  try {
    const r = await fetch('/pending?token=' + TOKEN)
    if (r.status === 401) { document.getElementById('subtitle').textContent = '⛔ Token invalide'; return }
    const d = await r.json()

    const badge = document.getElementById('mode-badge')
    badge.textContent = d.mode
    badge.className = 'mode mode-' + d.mode

    const list = document.getElementById('list')
    if (!d.pending || d.pending.length === 0) {
      if (lastCount !== 0) {
        list.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><p>Aucune approbation en attente</p></div>'
        lastCount = 0
      }
      document.getElementById('subtitle').textContent = 'Mise à jour: ' + new Date().toLocaleTimeString()
      return
    }

    lastCount = d.pending.length
    document.getElementById('subtitle').textContent = d.pending.length + ' demande(s) en attente — ' + new Date().toLocaleTimeString()

    list.innerHTML = d.pending.map(p => \`
      <div class="card">
        <div class="card-header">
          <span class="tool-icon">\${toolIcon(p.tool_name)}</span>
          <span class="tool-name">\${p.tool_name || 'Outil inconnu'}</span>
          <span class="tool-time">\${ago(p.time)}</span>
        </div>
        <div class="tool-input">\${formatInput(p.tool_name, p.tool_input || {})}</div>
        <div class="actions">
          <button class="btn-approve" onclick="action('\${p.id}','approve')">✅ Approuver</button>
          <button class="btn-deny" onclick="action('\${p.id}','deny')">❌ Refuser</button>
          <button class="btn-all" onclick="action('\${p.id}','approve_all')">✅✅ Tout approuver</button>
        </div>
      </div>
    \`).join('')
  } catch(e) {
    document.getElementById('subtitle').textContent = 'Erreur: ' + e.message
  }
}

poll()
setInterval(poll, 2000)
</script>
</body>
</html>`

/**
 * Creates the web approval UI HTTP server.
 *
 * @param {object} state  - State module (pendingApprovals, pendingApprovalDetails, autoApproveSessions, getApprovalMode)
 * @param {object} config - { port, token }
 * @returns {http.Server}
 */
function createWebUIServer(state, config) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`)
    const token = url.searchParams.get('token') || ''
    const path = url.pathname

    // POST /data — hook sends details (fire-and-forget, no token required internally)
    if (req.method === 'POST' && path === '/data') {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', () => {
        try {
          const d = JSON.parse(body)
          if (d.id) {
            state.pendingApprovalDetails.set(d.id, {
              tool_name: d.tool_name || '?',
              tool_input: d.tool_input || {},
              session_id: d.session_id || '',
              time: Date.now()
            })
          }
        } catch {}
        res.writeHead(200); res.end()
      })
      return
    }

    // Auth token required for all following routes
    if (token !== config.token) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      return res.end('401 Unauthorized — ajoute ?token=xxx à l\'URL')
    }

    // GET / — UI
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(WEB_UI_HTML)
    }

    // GET /pending — JSON list of pending approvals
    if (req.method === 'GET' && path === '/pending') {
      const list = []
      for (const [id, details] of state.pendingApprovalDetails) {
        if (state.pendingApprovals.has(id)) {
          list.push({ id, ...details })
        } else {
          state.pendingApprovalDetails.delete(id)  // cleanup
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ pending: list, mode: state.getApprovalMode() }))
    }

    // GET /action — resolve an approval
    if (req.method === 'GET' && path === '/action') {
      const id = url.searchParams.get('id')
      const decision = url.searchParams.get('decision')  // approve | deny | approve_all
      const pending = state.pendingApprovals.get(id)
      if (!pending) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Approbation introuvable ou déjà résolue' }))
      }
      if (decision === 'approve_all') {
        const details = state.pendingApprovalDetails.get(id)
        if (details?.session_id) state.autoApproveSessions.add(details.session_id)
      }
      clearTimeout(pending.timer)
      state.pendingApprovals.delete(id)
      state.pendingApprovalDetails.delete(id)
      const result = decision === 'deny'
        ? { decision: 'deny', reason: 'Refusé depuis le web' }
        : { decision: 'approve' }
      pending.resolve(result)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, decision }))
    }

    res.writeHead(404); res.end()
  })

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Web approval UI on :${config.port} — token: ${config.token}`)
  })

  return server
}

module.exports = { createWebUIServer }
