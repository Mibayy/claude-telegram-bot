'use strict'
const { execSync, spawn } = require('child_process')

module.exports = function registerCommands(bot, deps) {
  const { state, processMessage, fmt, agents, memory, notes, reminders, monitor } = deps

  function isAllowed(msg) {
    if (!state.ALLOWED_USER_ID || msg.from.id !== state.ALLOWED_USER_ID) {
      bot.sendMessage(msg.chat.id, `Non autorisé. ID: ${msg.from.id}`)
      return false
    }
    return true
  }

  // ─── /start, /help ─────────────────────────────────────────────────────────
  bot.onText(/\/(start|help)/, (msg) => {
    if (!isAllowed(msg)) return
    const proj = state.currentProjects.get(msg.chat.id)
    const agentLabel = agents.getAgentLabel(msg.chat.id)
    bot.sendMessage(msg.chat.id, [
      '<b>🤖 Claude VPS Bot</b>',
      '',
      '<b>Sessions</b>',
      '/new — nouvelle conversation',
      '/login — lien OAuth pour connecter Claude Code',
      '/clear — reset conversation',
      '/stop — arrêter · /retry — relancer',
      '/compact — reset + résumé contexte',
      '',
      '<b>Agents</b>',
      '/agent — choisir (dev/writer/analyst/strategist/operator)',
      '/reset — désactiver l\'agent',
      '',
      '<b>Outils</b>',
      '/web [q] — recherche web',
      '/tr [texte] — traduction FR↔EN',
      '/compare [A] vs [B] — comparatif',
      '/pr [repo#num] — résumé PR GitHub',
      '/brainstorm [sujet] — 3 questions',
      '/pin — épingler le résultat',
      '',
      '<b>Notes & Rappels</b>',
      '/note [texte] · /notes [search|clear]',
      '/rappel [durée] [texte] · /rappels',
      '',
      '<b>Mémoire & Projet</b>',
      '/memory · /remember · /forget',
      '/p [nom] · /diff · /undo',
      '/settings — réglages · /cron — cron jobs',
      '',
      '<b>Système</b>',
      '/status · /logs · /history',
      '/mode · /fast · /verbose · /timeout',
      '',
      `📂 ${proj || 'aucun'} · 🤖 ${agentLabel || 'aucun'} · 🔐 ${state.getApprovalMode()}`,
      '📎 Images/PDF/audio/vidéo/fichiers/albums',
    ].join('\n'), {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{ text: '/agent' }, { text: '/p' }, { text: '/settings' }],
          [{ text: '/web' }, { text: '/note' }, { text: '/rappel' }],
          [{ text: '/new' }, { text: '/stop' }, { text: '/status' }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      }
    })
  })

  // ─── /new ──────────────────────────────────────────────────────────────────
  bot.onText(/\/new/, (msg) => {
    if (!isAllowed(msg)) return
    const oldSessionId = state.conversationIds.get(msg.chat.id)
    if (oldSessionId) state.autoApproveSessions.delete(oldSessionId)
    state.conversationIds.delete(msg.chat.id)
    state.messageQueues.delete(msg.chat.id)
    state.saveState()
    bot.sendMessage(msg.chat.id, '🆕 Nouvelle conversation.')
  })

  // ─── /login — get OAuth URL to connect Claude Code to your account ─────────
  bot.onText(/^\/login(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim()
    const args = ['auth', 'login']
    if (arg === 'console') args.push('--console')

    const waitMsg = await bot.sendMessage(chatId, '🔑 Génération du lien de connexion...')

    const proc = spawn('claude', args, {
      env: { ...process.env, BROWSER: 'echo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    proc.stdout.on('data', d => { output += d.toString() })
    proc.stderr.on('data', d => { output += d.toString() })

    const timer = setTimeout(() => proc.kill('SIGTERM'), 15000)

    proc.on('close', async () => {
      clearTimeout(timer)
      // Extract URL from output
      const urlMatch = output.match(/(https:\/\/claude\.com\/[^\s]+)/)
      try { await bot.deleteMessage(chatId, waitMsg.message_id) } catch {}

      if (urlMatch) {
        const url = urlMatch[1]
        // Send clickable link alone (easy to tap or copy)
        await bot.sendMessage(chatId, `🔑 <b>Connexion Claude Code</b>\n\nOuvre ce lien :`, { parse_mode: 'HTML' })
        await bot.sendMessage(chatId, url, { disable_web_page_preview: true })
        await bot.sendMessage(chatId, `Une fois connecté, copie le code qu'on te donne et colle-le ici avec :\n<code>/login COLLE_LE_CODE_ICI</code>`, { parse_mode: 'HTML' })
      } else {
        bot.sendMessage(chatId, '❌ Pas de lien obtenu.\n<pre>' + fmt.escHtml(output.slice(0, 500)) + '</pre>', { parse_mode: 'HTML' })
      }
    })

    proc.on('error', async (err) => {
      clearTimeout(timer)
      try { await bot.deleteMessage(chatId, waitMsg.message_id) } catch {}
      bot.sendMessage(chatId, `❌ Erreur: ${err.message}`)
    })
  })

  // ─── /stop ─────────────────────────────────────────────────────────────────
  bot.onText(/\/stop/, (msg) => {
    if (!isAllowed(msg)) return
    const session = state.activeSessions.get(msg.chat.id)
    if (session) {
      session.proc.kill('SIGTERM')
      clearTimeout(session.timer)
      state.activeSessions.delete(msg.chat.id)
      state.messageQueues.delete(msg.chat.id)
      bot.sendMessage(msg.chat.id, '⏹ Arrêté.')
    } else {
      bot.sendMessage(msg.chat.id, 'Rien en cours.')
    }
  })

  // ─── /retry ────────────────────────────────────────────────────────────────
  bot.onText(/\/retry/, (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const last = state.lastPrompts.get(chatId)
    if (!last) {
      return bot.sendMessage(chatId, 'Rien à relancer.')
    }
    if (state.activeSessions.has(chatId)) {
      return bot.sendMessage(chatId, '⏳ Une commande est déjà en cours. /stop d\'abord.')
    }
    bot.sendMessage(chatId, `🔄 Relance: <i>${fmt.escHtml(last.prompt.slice(0, 100))}${last.prompt.length > 100 ? '…' : ''}</i>`, { parse_mode: 'HTML' })
    processMessage(chatId, last.prompt, last.filePaths || [])
  })

  // ─── /status ───────────────────────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    if (!isAllowed(msg)) return
    try {
      const uptime = execSync('uptime -p').toString().trim()
      const disk = execSync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\")\"}'").toString().trim()
      const mem = execSync("free -h | awk '/Mem:/{print $3\"/\"$2}'").toString().trim()
      const services = ['claude-telegram', 'hermes-gateway', 'eclatauto-api', 'vps-monitor', 'nginx', 'docker'].map(s => {
        try {
          const st = execSync(`systemctl is-active ${s}.service 2>/dev/null`).toString().trim()
          return `${st === 'active' ? '✅' : '❌'} ${s}`
        } catch { return `❌ ${s}` }
      }).join('\n')

      // Bot-specific stats
      const botUptimeSec = Math.floor((Date.now() - state.processStartTime) / 1000)
      const botUptimeH = Math.floor(botUptimeSec / 3600)
      const botUptimeM = Math.floor((botUptimeSec % 3600) / 60)
      const botUptime = botUptimeH > 0 ? `${botUptimeH}h${botUptimeM}m` : `${botUptimeM}m`
      const rss = (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
      const activeCount = state.activeSessions.size
      const queueCount = Array.from(state.messageQueues.values()).reduce((s, q) => s + q.length, 0)
      const convCount = state.conversationIds.size
      const projCount = state.currentProjects.size

      const botStats = [
        `\n🤖 <b>Bot Claude</b>`,
        `├ Uptime: ${botUptime}`,
        `├ RAM: ${rss} MB`,
        `├ Sessions actives: ${activeCount}`,
        `├ File d'attente: ${queueCount}`,
        `├ Conversations: ${convCount}`,
        `├ Projets liés: ${projCount}`,
        `├ Polling errors: ${state.getPollingErrors()}`,
        `└ Approbation: ${state.getApprovalMode()}`
      ].join('\n')

      bot.sendMessage(msg.chat.id, `⏱ ${uptime}\n💾 ${disk} | 🧠 ${mem}\n\n${services}${botStats}`, { parse_mode: 'HTML' })
    } catch (err) {
      bot.sendMessage(msg.chat.id, `Erreur: ${err.message}`)
    }
  })

  // ─── /logs ─────────────────────────────────────────────────────────────────
  bot.onText(/\/logs\s*(.*)/, (msg, match) => {
    if (!isAllowed(msg)) return
    const svcMap = { sirius: 'sirius', ai: 'sirius-ai', bot: 'claude-telegram', web: 'web_monitor' }
    const name = (match[1] || '').trim().toLowerCase()
    const svc = svcMap[name]

    if (!svc && name) {
      return bot.sendMessage(msg.chat.id, `Service inconnu. Dispo: ${Object.keys(svcMap).join(', ')}`)
    }

    try {
      const cmd = svc
        ? `journalctl -u ${svc}.service --no-pager --since "30 min ago" | tail -40`
        : ['sirius', 'sirius-ai', 'web_monitor', 'claude-telegram'].map(s =>
          `echo "── ${s} ──" && journalctl -u ${s}.service --no-pager --since "10 min ago" | tail -5`
        ).join(' && ')
      const output = execSync(cmd, { timeout: 10000 }).toString().trim()
      fmt.sendLong(bot, msg.chat.id, output || '(vide)', null, state)
    } catch (err) {
      bot.sendMessage(msg.chat.id, `Erreur: ${err.message.slice(0, 200)}`)
    }
  })

  // ─── /project ──────────────────────────────────────────────────────────────
  bot.onText(/\/project\s*(.*)/, (msg, match) => {
    if (!isAllowed(msg)) return
    const name = (match[1] || '').trim()
    if (!name) {
      const current = state.currentProjects.get(msg.chat.id)
      return bot.sendMessage(msg.chat.id, current ? `Projet actif: <code>${current}</code>` : 'Aucun projet. Usage: /project nom', { parse_mode: 'HTML' })
    }
    state.currentProjects.set(msg.chat.id, name)
    state.saveState()
    bot.sendMessage(msg.chat.id, `✅ Projet: <code>${name}</code>\nLe prochain message fera switch_project("${name}") automatiquement.`, { parse_mode: 'HTML' })
  })

  // ─── /mode ─────────────────────────────────────────────────────────────────
  bot.onText(/\/mode\s*(.*)/, (msg, match) => {
    if (!isAllowed(msg)) return
    const mode = (match[1] || '').trim().toLowerCase()
    if (['all', 'telegram', 'off'].includes(mode)) {
      state.setApprovalMode(mode)
      state.saveState()
      const desc = { all: 'Toutes les sessions (terminal + Telegram)', telegram: 'Sessions Telegram uniquement', off: 'Désactivé' }
      bot.sendMessage(msg.chat.id, `🔐 Mode approbation: <b>${mode}</b>\n${desc[mode]}`, { parse_mode: 'HTML' })
    } else {
      bot.sendMessage(msg.chat.id, `Mode actuel: <b>${state.getApprovalMode()}</b>\n\nUsage: /mode [all|telegram|off]`, { parse_mode: 'HTML' })
    }
  })

  // ─── /usage ────────────────────────────────────────────────────────────────
  bot.onText(/\/usage/, async (msg) => {
    if (!isAllowed(msg)) return
    try {
      const result = execSync(`curl -s http://127.0.0.1:${state.APPROVAL_PORT}/mode`, { timeout: 3000 }).toString()
      const sessionCount = state.activeSessions.size
      const queueCount = Array.from(state.messageQueues.values()).reduce((s, q) => s + q.length, 0)
      const convCount = state.conversationIds.size
      bot.sendMessage(msg.chat.id, [
        '<b>📊 Stats Bot</b>',
        '',
        `🔄 Sessions actives: ${sessionCount}`,
        `📋 Messages en file: ${queueCount}`,
        `💬 Conversations: ${convCount}`,
        `🔐 Mode approbation: ${state.getApprovalMode()}`,
        `⏱ Streaming interval: ${state.STREAM_INTERVAL / 1000}s`,
      ].join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      bot.sendMessage(msg.chat.id, `Erreur: ${err.message}`)
    }
  })

  // ─── /p with argument — shortcut for /project ─────────────────────────────
  bot.onText(/\/p\s+(.+)/, (msg, match) => {
    if (!isAllowed(msg)) return
    const name = match[1].trim()
    state.currentProjects.set(msg.chat.id, name)
    state.saveState()
    bot.sendMessage(msg.chat.id, `📂 <code>${fmt.escHtml(name)}</code>`, { parse_mode: 'HTML' })
  })

  // ─── /diff — show git changes in current project ──────────────────────────
  bot.onText(/\/diff/, (msg) => {
    if (!isAllowed(msg)) return
    const proj = state.currentProjects.get(msg.chat.id)
    if (!proj) return bot.sendMessage(msg.chat.id, 'Aucun projet actif. /p nom-projet d\'abord.')

    if (state.activeSessions.has(msg.chat.id)) return bot.sendMessage(msg.chat.id, '⏳ Attends la fin de la commande en cours.')
    processMessage(msg.chat.id, `Montre-moi un résumé des changements git récents (git status + git diff --stat). Sois bref.`, [])
  })

  // ─── /undo — restore last Token Savior checkpoint ─────────────────────────
  bot.onText(/\/undo/, (msg) => {
    if (!isAllowed(msg)) return
    const proj = state.currentProjects.get(msg.chat.id)
    if (!proj) return bot.sendMessage(msg.chat.id, 'Aucun projet actif. /p nom-projet d\'abord.')

    if (state.activeSessions.has(msg.chat.id)) return bot.sendMessage(msg.chat.id, '⏳ Attends la fin de la commande en cours.')
    processMessage(msg.chat.id, `Liste les checkpoints disponibles avec list_checkpoints(). Si il y en a, restaure le dernier avec restore_checkpoint(). Confirme ce qui a été restauré.`, [])
  })

  // ─── /compact — new session with context summary ──────────────────────────
  bot.onText(/\/compact/, (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Attends la fin de la commande en cours.')

    // Reset conversation but ask Claude to summarize context
    const proj = state.currentProjects.get(chatId)
    const oldSessionId = state.conversationIds.get(chatId)
    if (oldSessionId) state.autoApproveSessions.delete(oldSessionId)
    state.conversationIds.delete(chatId)
    state.saveState()

    const resumePrompt = proj
      ? `Tu reprends le travail sur le projet "${proj}". Fais switch_project("${proj}") et donne un bref résumé de l'état du projet (git status, fichiers récents). Sois prêt pour les prochaines instructions.`
      : 'Nouvelle session. Résume brièvement les projets disponibles avec list_projects().'

    bot.sendMessage(chatId, '🔄 Conversation compactée — nouveau contexte.')
    processMessage(chatId, resumePrompt, [])
  })

  // ─── Agent shortcuts: /code /coach /check /reset ───────────────────────────
  bot.onText(/^\/code$/, (msg) => {
    if (!isAllowed(msg)) return
    agents.setAgent(msg.chat.id, 'dev')
    bot.sendMessage(msg.chat.id, '🧑‍💻 Agent <b>Dev</b> activé\n/agent pour changer · /reset pour désactiver', { parse_mode: 'HTML' })
  })
  bot.onText(/^\/coach$/, (msg) => {
    if (!isAllowed(msg)) return
    agents.setAgent(msg.chat.id, 'strategist')
    bot.sendMessage(msg.chat.id, '🎯 Agent <b>Strategist</b> activé\n/agent pour changer · /reset pour désactiver', { parse_mode: 'HTML' })
  })
  bot.onText(/^\/check$/, (msg) => {
    if (!isAllowed(msg)) return
    agents.setAgent(msg.chat.id, 'writer')
    bot.sendMessage(msg.chat.id, '✍️ Agent <b>Writer</b> activé\n/agent pour changer · /reset pour désactiver', { parse_mode: 'HTML' })
  })
  bot.onText(/^\/reset$/, (msg) => {
    if (!isAllowed(msg)) return
    agents.clearAgent(msg.chat.id)
    bot.sendMessage(msg.chat.id, '↩️ Aucun agent actif')
  })

  // ─── /agent — sélecteur d'agent ────────────────────────────────────────────
  bot.onText(/^\/agent(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim().toLowerCase()

    if (!arg) {
      // Show picker
      const currentKey = agents.getAgentKey(chatId)
      const rows = agents.buildAgentPicker(currentKey)
      const label = agents.getAgentLabel(chatId)
      bot.sendMessage(chatId,
        `🤖 <b>Agents disponibles</b>\nActif : <code>${label || 'aucun'}</code>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
      )
      return
    }

    if (arg === 'off' || arg === 'none' || arg === 'reset') {
      agents.clearAgent(chatId)
      return bot.sendMessage(chatId, '↩️ Aucun agent actif')
    }

    if (agents.setAgent(chatId, arg)) {
      const a = agents.getAgent(chatId)
      bot.sendMessage(chatId, `${a.icon} Agent <b>${a.name}</b> activé`, { parse_mode: 'HTML' })
    } else {
      const list = Object.entries(agents.AGENTS).map(([k, v]) => `  /agent ${k} — ${v.icon} ${v.name}`).join('\n')
      bot.sendMessage(chatId, `❌ Agent inconnu : <code>${fmt.escHtml(arg)}</code>\n\nAgents disponibles :\n${list}`, { parse_mode: 'HTML' })
    }
  })

  // ─── /verbose — niveau de verbosité ────────────────────────────────────────
  bot.onText(/^\/verbose(?:\s+(\d))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = match[1]
    if (arg === undefined) {
      const current = state.verboseLevels.get(chatId) ?? 1
      return bot.sendMessage(chatId, `📢 Verbosité actuelle : <b>${current}</b>\n\n0 = silencieux · 1 = normal (défaut) · 2 = détaillé\n\nUsage : /verbose 0|1|2`, { parse_mode: 'HTML' })
    }
    const level = parseInt(arg)
    if (![0, 1, 2].includes(level)) return bot.sendMessage(chatId, '❌ Valeur : 0, 1 ou 2')
    state.verboseLevels.set(chatId, level)
    const labels = { 0: '🔇 Silencieux — pas d\'affichage outils', 1: '📢 Normal — affichage outils standard', 2: '🔍 Détaillé — toutes les infos' }
    bot.sendMessage(chatId, `${labels[level]}`)
  })

  // ─── /settings — vue unique de tous les réglages ───────────────────────────
  bot.onText(/^\/settings$/, (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const agentLabel = agents.getAgentLabel(chatId) || 'aucun'
    const proj = state.currentProjects.get(chatId) || 'aucun'
    const verbose = state.verboseLevels.get(chatId) ?? 1
    const fast = state.fastModeUsers.has(chatId) ? 'ON ⚡' : 'OFF'
    const timeout = (state.userTimeouts.get(chatId) || state.CLAUDE_TIMEOUT_MS) / 60000
    const memCount = memory.load(chatId).facts?.length || 0
    const conv = state.conversationIds.has(chatId) ? '✅ active' : '❌ aucune'
    bot.sendMessage(chatId, [
      '⚙️ <b>Réglages</b>',
      '',
      `🤖 Agent : <code>${agentLabel}</code>  →  /agent`,
      `📂 Projet : <code>${proj}</code>  →  /p`,
      `🔐 Approbation : <code>${state.getApprovalMode()}</code>  →  /mode`,
      `📢 Verbose : <code>${verbose}</code>  →  /verbose`,
      `⚡ Fast : <code>${fast}</code>  →  /fast`,
      `⏱ Timeout : <code>${timeout}min</code>  →  /timeout`,
      `🧠 Mémoire : <code>${memCount} faits</code>  →  /memory`,
      `💬 Session : ${conv}`,
    ].join('\n'), { parse_mode: 'HTML' })
  })

  // ─── /memory ───────────────────────────────────────────────────────────────
  bot.onText(/^\/memory$/, (msg) => {
    if (!isAllowed(msg)) return
    bot.sendMessage(msg.chat.id, memory.format(msg.chat.id), { parse_mode: 'HTML' })
  })

  // ─── /remember ─────────────────────────────────────────────────────────────
  bot.onText(/^\/remember(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const fact = (match[1] || '').trim()
    if (!fact) return bot.sendMessage(msg.chat.id, 'Usage : /remember [information à mémoriser]')
    const added = memory.addFact(msg.chat.id, fact)
    if (added) {
      bot.sendMessage(msg.chat.id, `🧠 Mémorisé : <i>${fmt.escHtml(fact)}</i>`, { parse_mode: 'HTML' })
    } else {
      bot.sendMessage(msg.chat.id, '⚠️ Déjà mémorisé ou mémoire pleine.')
    }
  })

  // ─── /forget ───────────────────────────────────────────────────────────────
  bot.onText(/^\/forget(?:\s+(\d+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = match[1]
    if (!arg) return bot.sendMessage(chatId, memory.format(chatId), { parse_mode: 'HTML' })
    const removed = memory.removeFact(chatId, parseInt(arg))
    if (removed) {
      bot.sendMessage(chatId, `🗑 Supprimé : <i>${fmt.escHtml(removed)}</i>`, { parse_mode: 'HTML' })
    } else {
      bot.sendMessage(chatId, '❌ Numéro invalide. /memory pour voir la liste.')
    }
  })

  // ─── /note ─────────────────────────────────────────────────────────────────
  bot.onText(/^\/note(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const text = (match[1] || '').trim()
    if (!text) return bot.sendMessage(chatId, notes.format(chatId), { parse_mode: 'HTML' })
    const note = notes.addNote(chatId, text)
    if (note) {
      bot.sendMessage(chatId, `📝 Note ajoutée : <i>${fmt.escHtml(text)}</i>`, { parse_mode: 'HTML' })
    } else {
      bot.sendMessage(chatId, '⚠️ Limite atteinte (50 notes max). /notes clear pour vider.')
    }
  })

  // ─── /notes ────────────────────────────────────────────────────────────────
  bot.onText(/^\/notes(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim()
    if (arg === 'clear') {
      notes.clearAll(chatId)
      return bot.sendMessage(chatId, '🗑 Toutes les notes supprimées.')
    }
    if (arg && /^\d+$/.test(arg)) {
      const removed = notes.removeNote(chatId, parseInt(arg))
      if (removed) return bot.sendMessage(chatId, `🗑 Supprimé : <i>${fmt.escHtml(removed)}</i>`, { parse_mode: 'HTML' })
      return bot.sendMessage(chatId, '❌ Numéro invalide.')
    }
    if (arg) {
      // Search
      const results = notes.searchNotes(chatId, arg)
      if (results.length === 0) return bot.sendMessage(chatId, `🔍 Aucune note contenant "${arg}".`)
      const formatted = results.map((n, i) => `${i + 1}. ${n.text}`).join('\n')
      return bot.sendMessage(chatId, `🔍 <b>Résultats pour "${fmt.escHtml(arg)}"</b>\n\n${formatted}`, { parse_mode: 'HTML' })
    }
    bot.sendMessage(chatId, notes.format(chatId), { parse_mode: 'HTML' })
  })

  // ─── /rappel — rappels avec timer ──────────────────────────────────────────
  bot.onText(/^\/rappel(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim()

    if (!arg) return bot.sendMessage(chatId, reminders.format(chatId), { parse_mode: 'HTML' })

    // Parse: /rappel 30m faire les courses
    const parts = arg.match(/^(\d+[smhj](?:\d+[smh])?)\s+(.+)$/i)
    if (!parts) {
      return bot.sendMessage(chatId, 'Usage : /rappel [durée] [texte]\nExemples : /rappel 30m vérifier le deploy · /rappel 2h appeler Louis · /rappel 1j renouveler le SSL')
    }

    const delayMs = reminders.parseDelay(parts[1])
    if (!delayMs) return bot.sendMessage(chatId, '❌ Durée invalide. Formats : 30s, 10m, 2h, 1j, 1h30m')

    const text = parts[2]
    const id = reminders.schedule(chatId, delayMs, text, (cid, txt) => {
      bot.sendMessage(cid, `⏰ <b>Rappel !</b>\n\n${fmt.escHtml(txt)}`, { parse_mode: 'HTML' })
    })

    if (id === null) return bot.sendMessage(chatId, '⚠️ Maximum 10 rappels actifs.')

    const durLabel = parts[1].toLowerCase()
    bot.sendMessage(chatId, `⏰ Rappel programmé dans <b>${durLabel}</b> : <i>${fmt.escHtml(text)}</i>`, { parse_mode: 'HTML' })
  })

  // ─── /rappels ──────────────────────────────────────────────────────────────
  bot.onText(/^\/rappels$/, (msg) => {
    if (!isAllowed(msg)) return
    bot.sendMessage(msg.chat.id, reminders.format(msg.chat.id), { parse_mode: 'HTML' })
  })

  // ─── /cron — voir/gérer les cron jobs ──────────────────────────────────────
  bot.onText(/^\/cron$/, (msg) => {
    if (!isAllowed(msg)) return
    try {
      const userCron = execSync('crontab -l 2>/dev/null || echo "(vide)"', { timeout: 5000 }).toString().trim()
      const lines = userCron.split('\n').filter(l => l.trim() && !l.startsWith('#'))
      if (lines.length === 0 || userCron === '(vide)') {
        return bot.sendMessage(msg.chat.id, '📋 Aucun cron job actif.')
      }
      const formatted = lines.map((l, i) => `${i + 1}. <code>${fmt.escHtml(l)}</code>`).join('\n')
      bot.sendMessage(msg.chat.id, `📋 <b>Cron jobs</b> (${lines.length})\n\n${formatted}`, { parse_mode: 'HTML' })
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Erreur: ${err.message}`)
    }
  })

  // ─── /compare — tableau comparatif ─────────────────────────────────────────
  bot.onText(/^\/compare(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const args = (match[1] || '').trim()
    if (!args) return bot.sendMessage(chatId, 'Usage : /compare [A] vs [B]\nExemple : /compare React vs Vue')
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const prompt = `Fais un tableau comparatif détaillé : ${args}\n\nStructure :\n1. Tableau Markdown avec les critères clés\n2. Pour chaque critère : avantage clair\n3. Verdict final avec recommandation selon le cas d'usage\n\nSois factuel et objectif.`
    state.lastPrompts.set(chatId, { prompt, filePaths: [] })
    processMessage(chatId, prompt, [])
  })

  // ─── /pr — résumé de pull request GitHub ───────────────────────────────────
  bot.onText(/^\/pr(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim()
    if (!arg) return bot.sendMessage(chatId, 'Usage : /pr [repo#num] ou /pr [url]\nExemple : /pr anthropics/claude-code#100')
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const prompt = `Analyse cette pull request : ${arg}\n\nUtilise la commande gh pour récupérer les infos (gh pr view, gh pr diff). Donne-moi :\n1. Résumé des changements (2-3 lignes)\n2. Fichiers modifiés clés\n3. Points d'attention / risques\n4. Verdict : prêt à merger ou non`
    state.lastPrompts.set(chatId, { prompt, filePaths: [] })
    processMessage(chatId, prompt, [])
  })

  // ─── /web — forcer recherche web ───────────────────────────────────────────
  bot.onText(/^\/web(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const query = (match[1] || '').trim()
    if (!query) return bot.sendMessage(chatId, 'Usage : /web [question]\nForce Claude à chercher sur le web avant de répondre.')
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const prompt = `Utilise WebSearch pour chercher sur le web à propos de : "${query}"\n\nDonne-moi une réponse synthétique basée sur les résultats récents. Cite tes sources.`
    state.lastPrompts.set(chatId, { prompt, filePaths: [] })
    processMessage(chatId, prompt, [])
  })

  // ─── /tr — traduction rapide FR↔EN ─────────────────────────────────────────
  bot.onText(/^\/tr(?:\s+(.+))?$/, (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const text = (match[1] || '').trim()
    if (!text) return bot.sendMessage(chatId, 'Usage : /tr [texte à traduire]\nDétecte la langue et traduit FR↔EN.')
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const prompt = `Traduis ce texte. Si c'est en français, traduis en anglais. Si c'est en anglais, traduis en français. Si c'est une autre langue, traduis en français.\n\nDonne UNIQUEMENT la traduction, rien d'autre.\n\nTexte : "${text}"`
    state.lastPrompts.set(chatId, { prompt, filePaths: [] })
    processMessage(chatId, prompt, [])
  })

  // ─── /pin — épingler le dernier résultat ───────────────────────────────────
  bot.onText(/^\/pin$/, async (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const targetId = state.lastBotMessages.get(chatId)
    if (!targetId) return bot.sendMessage(chatId, '📌 Rien à épingler — envoie d\'abord un message à Claude.')
    try {
      await bot.pinChatMessage(chatId, targetId)
      bot.sendMessage(chatId, '📌 Épinglé.')
    } catch (err) {
      bot.sendMessage(chatId, `❌ Impossible d'épingler : ${err.message}`)
    }
  })

  // ─── /brainstorm ───────────────────────────────────────────────────────────
  bot.onText(/^\/brainstorm(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const topic = (match[1] || '').trim()
    const prompt = topic
      ? `En mode BRAINSTORM sur : "${topic}". Ne donne pas de solution. Pose-moi exactement 3 questions critiques, provocantes et ouvertes pour m'aider à approfondir ou challenger mon idée.`
      : `En mode BRAINSTORM. Ne donne pas de solution ni de réponse. Pose-moi exactement 3 questions critiques, provocantes et ouvertes pour m'aider à approfondir mon idée ou résoudre mon problème.`
    processMessage(chatId, prompt, [])
  })

  // ─── /fast toggle ──────────────────────────────────────────────────────────
  bot.onText(/^\/fast$/, async (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    if (state.fastModeUsers.has(chatId)) {
      state.fastModeUsers.delete(chatId)
      bot.sendMessage(chatId, '🐢 Mode normal activé.')
    } else {
      state.fastModeUsers.add(chatId)
      bot.sendMessage(chatId, '⚡ Mode fast activé — réponses plus rapides (moins de détails).')
    }
  })

  // ─── /clear ────────────────────────────────────────────────────────────────
  bot.onText(/^\/clear$/, async (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const oldSid = state.conversationIds.get(chatId)
    if (oldSid) state.autoApproveSessions.delete(oldSid)
    state.conversationIds.delete(chatId)
    state.saveState()
    const proj = state.currentProjects.get(chatId)
    bot.sendMessage(chatId, `🆕 Conversation réinitialisée${proj ? ` | 📂 ${proj}` : ''}.`)
  })

  // ─── /timeout ──────────────────────────────────────────────────────────────
  bot.onText(/^\/timeout(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const arg = (match[1] || '').trim().toLowerCase()
    if (!arg) {
      const current = state.getTimeout(chatId)
      return bot.sendMessage(chatId, `⏱ Timeout actuel : ${current / 60000}min\nExemples : /timeout 5m · /timeout 15m · /timeout 30m`)
    }
    const m = arg.match(/^(\d+)m?$/)
    if (!m) return bot.sendMessage(chatId, '❌ Format : /timeout 10m')
    const minutes = parseInt(m[1])
    if (minutes < 1 || minutes > 60) return bot.sendMessage(chatId, '❌ Entre 1 et 60 minutes.')
    state.userTimeouts.set(chatId, minutes * 60000)
    bot.sendMessage(chatId, `⏱ Timeout : ${minutes}min`)
  })

  // ─── /history ──────────────────────────────────────────────────────────────
  bot.onText(/\/history/, (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const hist = state.promptHistory.get(chatId) || []
    if (hist.length === 0) return bot.sendMessage(chatId, '📋 Aucun historique pour cette session.')
    const buttons = hist.slice().reverse().map((h, i) => ([{
      text: `${hist.length - i}. ${h.label}`,
      callback_data: `hist:${hist.length - 1 - i}`
    }]))
    bot.sendMessage(chatId, '📋 <b>Historique</b> — clique pour relancer :', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons }
    })
  })

  // ─── /p sans argument → project picker ─────────────────────────────────────
  bot.onText(/^\/p$/, (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const current = state.currentProjects.get(chatId)
    const rows = []
    for (let i = 0; i < state.KNOWN_PROJECTS.length; i += 3) {
      rows.push(state.KNOWN_PROJECTS.slice(i, i + 3).map(p => ({
        text: p === current ? `✓ ${p}` : p,
        callback_data: `proj:${p}`
      })))
    }
    bot.sendMessage(chatId, `📂 <b>Choisir un projet</b>\nActuel : <code>${current ? fmt.escHtml(current) : 'aucun'}</code>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: rows }
    })
  })

  // ─── Edited message → re-submit ────────────────────────────────────────────
  bot.on('edited_message', async (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const text = (msg.text || msg.caption || '').trim()
    if (!text || text.startsWith('/')) return
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    bot.sendMessage(chatId, '🔄 Message édité — relance...')
    processMessage(chatId, text, [])
  })
}
