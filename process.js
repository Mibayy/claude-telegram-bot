'use strict'
// process.js — processMessage + processQueue (le cœur du bot)

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')

let _bot, _state, _fmt, _agents, _memory

function init(bot, deps) {
  _bot = bot
  _state = deps.state
  _fmt = deps.fmt
  _agents = deps.agents
  _memory = deps.memory
}

function processQueue(chatId) {
  const queue = _state.messageQueues.get(chatId)
  if (!queue || queue.length === 0) return
  const next = queue.shift()
  if (queue.length === 0) _state.messageQueues.delete(chatId)
  _bot.sendMessage(chatId, '📋 Traitement du message en file...').catch(() => {})
  processMessage(chatId, next.prompt, next.filePaths || [])
}

async function processMessage(chatId, prompt, filePaths = [], retried = false) {
  if (prompt && prompt !== 'Continue.' && !prompt.startsWith('Commence par switch_project')) {
    _state.addToHistory(chatId, prompt)
  }

  const verbose = _state.verboseLevels.get(chatId) ?? 1

  const statusMsg = await _bot.sendMessage(chatId, '⏳ Démarrage...', {
    reply_markup: { inline_keyboard: [[{ text: '⏹ Stop', callback_data: 'action:stop' }]] }
  })
  const startTime = Date.now()

  let toolLog = []
  const toolEntries = new Map()
  let lastEditText = ''
  let lastEditTime = 0
  let streamText = ''
  let lastStreamUpdate = 0
  let isStreaming = false

  function getToolDisplay(toolName, toolInput) {
    const n = toolName || ''
    let icon = '⚙️'
    let label = n.replace('mcp__token-savior__', '').replace(/^mcp__\w+__/, '').replace('mcp__', '')

    if (n.includes('token-savior')) {
      icon = '🔍'
      if (toolInput) {
        if      (n.includes('switch_project'))          label = `switch_project(${toolInput.name || ''})`
        else if (n.includes('get_function_source'))     label = `get_function_source(${toolInput.name || ''})`
        else if (n.includes('get_class_source'))        label = `get_class_source(${toolInput.name || ''})`
        else if (n.includes('search_codebase'))         label = `search(${(toolInput.pattern || '').slice(0, verbose >= 2 ? 60 : 35)})`
        else if (n.includes('replace_symbol_source'))   label = `replace_symbol(${toolInput.symbol_name || ''})`
        else if (n.includes('apply_symbol_change'))     label = `apply_symbol(${toolInput.symbol_name || ''})`
        else if (n.includes('insert_near_symbol'))      label = `insert_near(${toolInput.symbol_name || ''})`
        else if (n.includes('get_git_status'))          label = 'git_status'
        else if (n.includes('get_changed_symbols'))     label = 'changed_symbols'
        else if (n.includes('build_commit_summary'))    label = 'commit_summary'
        else if (n.includes('find_symbol'))             label = `find_symbol(${toolInput.name || ''})`
        else if (n.includes('list_files'))              label = `list_files(${toolInput.glob || ''})`
        else if (n.includes('get_structure_summary'))   label = `structure(${(toolInput.file_path || '').split('/').pop()})`
        else if (n.includes('get_project_summary'))     label = 'project_summary'
        else if (n.includes('get_functions'))           label = 'get_functions'
        else if (n.includes('get_classes'))             label = 'get_classes'
        else if (n.includes('get_dependencies'))        label = `deps(${toolInput.name || ''})`
        else if (n.includes('get_dependents'))          label = `dependents(${toolInput.name || ''})`
        else if (n.includes('create_checkpoint'))       label = `checkpoint(${toolInput.name || ''})`
        else if (n.includes('restore_checkpoint'))      label = `restore(${toolInput.name || ''})`
        else if (n.includes('run_project_action'))      label = `run(${toolInput.action || ''})`
        else if (n.includes('run_impacted_tests'))      label = 'run_tests'
        else if (n.includes('list_projects'))           label = 'list_projects'
      }
    } else if (n === 'Bash') {
      icon = '🖥️'
      const cmd = (toolInput?.command || '').replace(/\s+/g, ' ')
      label = `Bash(${cmd.slice(0, verbose >= 2 ? 100 : 50)})`
    } else if (n === 'Read') {
      icon = '📄'; label = `Read(${(toolInput?.file_path || '').split('/').pop()})`
    } else if (n === 'Edit') {
      icon = '✏️'
      label = verbose >= 2
        ? `Edit(${(toolInput?.file_path || '').split('/').pop()}) — ${(toolInput?.old_string || '').slice(0, 40).replace(/\n/g, '↵')}`
        : `Edit(${(toolInput?.file_path || '').split('/').pop()})`
    } else if (n === 'Write') {
      icon = '📝'; label = `Write(${(toolInput?.file_path || '').split('/').pop()})`
    } else if (n === 'Glob') {
      icon = '🔎'; label = `Glob(${toolInput?.pattern || ''})`
    } else if (n === 'Grep') {
      icon = '🔎'; label = `Grep(${(toolInput?.pattern || '').slice(0, verbose >= 2 ? 60 : 35)})`
    } else if (n === 'WebSearch') {
      icon = '🌐'; label = `search("${(toolInput?.query || '').slice(0, 40)}")`
    } else if (n === 'WebFetch') {
      icon = '🌐'; label = `fetch(${(toolInput?.url || '').slice(0, 40)})`
    } else if (n.includes('github')) {
      icon = '🐙'
    } else if (n === 'TodoWrite' || n === 'TaskCreate' || n === 'TaskUpdate') {
      icon = '📋'
    }
    return { icon, label }
  }

  function buildActivityText() {
    const elapsed = Math.round((Date.now() - startTime) / 1000)
    const lines = [`⚙️ <i>en cours — ${elapsed}s</i>`]
    const maxTools = verbose >= 2 ? 8 : 6
    for (const t of toolLog.slice(-maxTools)) {
      lines.push(`${t.done ? '✓' : '⟳'} ${t.icon} <code>${_fmt.escHtml(t.label)}</code>`)
    }
    return lines.join('\n')
  }

  const STOP_BTN = { inline_keyboard: [[{ text: '⏹ Stop', callback_data: 'action:stop' }]] }

  async function editStatus(text, parseMode) {
    if (verbose === 0) return
    if (text === lastEditText) return
    const now = Date.now()
    if (now - lastEditTime < 2000) return
    lastEditText = text
    lastEditTime = now
    try {
      const opts = { chat_id: chatId, message_id: statusMsg.message_id, reply_markup: STOP_BTN }
      if (parseMode) opts.parse_mode = parseMode
      await _bot.editMessageText(text, opts)
    } catch {}
  }

  const tickerInterval = setInterval(() => {
    if (!isStreaming && toolLog.length > 0) editStatus(buildActivityText(), 'HTML')
  }, 3000)

  const typingInterval = setInterval(() => {
    _bot.sendChatAction(chatId, 'typing').catch(() => {})
  }, 5000)

  try {
    const project = _state.currentProjects.get(chatId)
    let fullPrompt = prompt
    if (project) fullPrompt = `Commence par switch_project("${project}"). Puis: ${prompt}`

    // Build system prompt: Token Savior rules + agent + memory
    const agentPrompt = _agents.getAgentPrompt(chatId)
    const memCtx = _memory.getSystemContext(chatId)
    const baseSystemPrompt =
      'OBLIGATION ABSOLUE — Token Savior:\n' +
      '1. TOUJOURS utiliser mcp__token-savior__* pour lire/naviguer du code\n' +
      '2. switch_project() AVANT toute action sur du code\n' +
      '3. JAMAIS Read/Grep/Glob sur du code source (.ts,.tsx,.py,.js,.jsx,.css,.html)\n' +
      '4. Terminal (Bash) UNIQUEMENT pour: builds, tests, git, installs, restarts, réseau\n' +
      '5. Read/Grep/Glob autorisé SEULEMENT pour: .env, .yml, .md, .json config\n' +
      '6. Utilise get_function_source/get_class_source pour lire du code, search_codebase pour chercher\n' +
      '7. Utilise replace_symbol_source pour éditer du code, insert_near_symbol pour ajouter\n' +
      '8. Sois concis dans tes réponses Telegram — pas de pavés inutiles.' +
      (agentPrompt ? `\n\n${agentPrompt}` : '') +
      (memCtx ? `\n\n${memCtx}` : '')

    const args = ['-p', '--verbose', '--output-format', 'stream-json',
      '--append-system-prompt', baseSystemPrompt
    ]
    if (_state.fastModeUsers.has(chatId)) args.push('--fast')

    for (const fp of filePaths) fullPrompt += `\nAnalyse ce fichier: ${fp}`

    const prevSessionId = _state.conversationIds.get(chatId)
    if (prevSessionId) args.push('--resume', prevSessionId)
    args.push(fullPrompt)

    const timeoutMs = _state.getTimeout(chatId)
    console.log(`[SPAWN] prompt="${fullPrompt.slice(0, 80)}..." timeout=${timeoutMs / 1000}s verbose=${verbose}${_agents.getAgentKey(chatId) ? ' agent=' + _agents.getAgentKey(chatId) : ''}`)
    const claude = spawn('claude', args, {
      cwd: process.env.CLAUDE_WORKDIR || os.homedir(),
      env: { ...process.env, HOME: process.env.CLAUDE_WORKDIR || os.homedir(), CLAUDE_FROM_TELEGRAM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      claude.kill('SIGTERM')
      setTimeout(() => claude.kill('SIGKILL'), 3000)
    }, timeoutMs)

    const longRunTimer = setTimeout(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0)
      _bot.sendMessage(chatId, `⏳ Claude travaille depuis ${elapsed}s... (timeout: ${timeoutMs / 1000}s)`).catch(() => {})
    }, 180000)

    _state.activeSessions.set(chatId, { proc: claude, timer, longRunTimer, statusMsgId: statusMsg.message_id })

    let rawOutput = '', finalResult = '', sessionId = ''

    claude.stdout.on('data', async (data) => {
      rawOutput += data.toString()
      for (const line of data.toString().split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line.trim())
          if (event.session_id && !sessionId) sessionId = event.session_id
          if (event.type === 'result') { finalResult = event.result || ''; if (event.session_id) sessionId = event.session_id }

          if (event.type === 'assistant' && event.subtype === 'tool_use') {
            isStreaming = false
            const { icon, label } = getToolDisplay(event.tool_name, event.tool_input)
            const entry = { icon, label, done: false, id: event.tool_use_id || null }
            const idx = toolLog.length
            toolLog.push(entry)
            if (entry.id) toolEntries.set(entry.id, idx)
            lastEditTime = 0
            await editStatus(buildActivityText(), 'HTML')
          }

          if (event.type === 'tool_result') {
            const id = event.tool_use_id
            if (id && toolEntries.has(id)) {
              toolLog[toolEntries.get(id)].done = true
            } else {
              for (let i = toolLog.length - 1; i >= 0; i--) { if (!toolLog[i].done) { toolLog[i].done = true; break } }
            }
            lastEditTime = 0
            await editStatus(buildActivityText(), 'HTML')
          }

          if (event.type === 'assistant' && event.subtype === 'text') {
            isStreaming = true
            streamText += (event.text || '')
            const now = Date.now()
            if (now - lastStreamUpdate >= _state.STREAM_INTERVAL && streamText.length > 30) {
              lastStreamUpdate = now
              const display = streamText.length > 3500 ? '…' + streamText.slice(-3500) : streamText
              try {
                const txt = `✍️ <i>en cours...</i>\n\n${_fmt.mdToHtml(display)}`
                await _bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: STOP_BTN })
                lastEditText = txt; lastEditTime = now
              } catch {
                try { await _bot.editMessageText(`✍️ en cours...\n\n${display.slice(0, 3800)}`, { chat_id: chatId, message_id: statusMsg.message_id, reply_markup: STOP_BTN }) } catch {}
              }
            }
          }
        } catch {}
      }
    })

    let stderr = ''
    claude.stderr.on('data', (data) => { stderr += data.toString(); console.log(`[STDERR] ${data.toString().slice(0, 200)}`) })

    claude.on('close', async (code) => {
      clearTimeout(timer); clearTimeout(longRunTimer); clearInterval(tickerInterval); clearInterval(typingInterval)
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      const toolCount = toolLog.length
      console.log(`[CLOSE] code=${code} result=${finalResult.length}c elapsed=${elapsed}s tools=${toolCount}`)
      _state.activeSessions.delete(chatId)
      try { await _bot.deleteMessage(chatId, statusMsg.message_id) } catch {}

      if (code === null) { processQueue(chatId); return }

      // Session expiry retry
      if (!retried && prevSessionId && !finalResult && code !== 0) {
        _state.conversationIds.delete(chatId)
        _state.saveState()
        console.log('[RETRY] Session expired, retrying fresh')
        await _bot.sendMessage(chatId, '🔄 Session expirée — relance...')
        return processMessage(chatId, prompt, filePaths, true)
      }

      if (sessionId) { _state.conversationIds.set(chatId, sessionId); _state.saveState() }

      let result = finalResult
      if (!result) { for (const l of rawOutput.split('\n')) { try { const p = JSON.parse(l.trim()); if (p.type === 'result') { result = p.result || ''; break } } catch {} } }
      if (!result) result = stderr.trim() || '(pas de réponse)'

      await _fmt.sendLong(_bot, chatId, _fmt.mdToHtml(result), 'HTML', _state)

      const editedFiles = [...new Set(toolLog.filter(t => t.label.startsWith('Edit(') || t.label.startsWith('Write(')).map(t => t.label.replace(/^(?:Edit|Write)\((.+)\)$/, '$1')))]
      const bashCmds = toolLog.filter(t => t.label.startsWith('Bash(')).map(t => t.label.slice(5, -1).slice(0, 35)).slice(0, 3)
      const summaryParts = []
      if (editedFiles.length) summaryParts.push(`✏️ ${editedFiles.slice(0, 4).join(', ')}`)
      if (bashCmds.length) summaryParts.push(`🖥️ ${bashCmds.join(' · ')}`)
      if (summaryParts.length) await _bot.sendMessage(chatId, summaryParts.join('\n')).catch(() => {})

      const hasEdit = toolLog.some(t => t.label.startsWith('Edit(') || t.label.startsWith('Write('))
      const hasBash = toolLog.some(t => t.label.startsWith('Bash('))
      const hasError = /\berror\b|\berreur\b|\bfailed\b|\béchec\b/i.test(result)
      const suggRow = []
      if (hasEdit) suggRow.push({ text: '🔍 Diff', callback_data: 'sugg:diff' })
      if (hasEdit) suggRow.push({ text: '▶️ Tests', callback_data: 'sugg:test' })
      if (hasBash) suggRow.push({ text: '💬 Expliquer', callback_data: 'sugg:explain' })
      if (hasError) suggRow.push({ text: '🐛 Corriger', callback_data: 'sugg:fix' })

      const proj = _state.currentProjects.get(chatId)
      const modeLabel = _agents.getAgentLabel(chatId) ? ` | ${_agents.getAgentLabel(chatId)}` : ''
      const fastLabel = _state.fastModeUsers.has(chatId) ? ' ⚡' : ''
      const projLabel = proj ? ` | 📂 ${proj}` : ''
      const actionRows = [[
        { text: '🔄 Retry', callback_data: 'action:retry' },
        { text: '➡️ Continuer', callback_data: 'action:continue' },
        { text: '🆕 Nouveau', callback_data: 'action:new' }
      ]]
      if (suggRow.length) actionRows.push(suggRow)

      await _bot.sendMessage(chatId, `✅ Terminé en ${elapsed}s${toolCount ? ` (${toolCount} outils)` : ''}${fastLabel}${modeLabel}${projLabel}`, {
        reply_markup: { inline_keyboard: actionRows }
      })

      for (const fp of filePaths) { try { fs.unlinkSync(fp) } catch {} }
      processQueue(chatId)
    })

    claude.on('error', async (err) => {
      clearTimeout(timer); clearTimeout(longRunTimer); clearInterval(tickerInterval); clearInterval(typingInterval)
      _state.activeSessions.delete(chatId)
      try { await _bot.deleteMessage(chatId, statusMsg.message_id) } catch {}
      _bot.sendMessage(chatId, `❌ Erreur: ${err.message}`)
      processQueue(chatId)
    })

  } catch (err) {
    clearInterval(tickerInterval); clearInterval(typingInterval)
    _state.activeSessions.delete(chatId)
    try { await _bot.deleteMessage(chatId, statusMsg.message_id) } catch {}
    _bot.sendMessage(chatId, `❌ Erreur: ${err.message}`)
    processQueue(chatId)
  }
}

module.exports = { init, processMessage, processQueue }
