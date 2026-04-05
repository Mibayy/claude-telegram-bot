'use strict'

module.exports = function registerCallbacks(bot, deps) {
  const { state, processMessage, agents, fmt } = deps
  // fmt has: escHtml, mdToHtml, stripHtmlTags

  // SINGLE callback_query handler that routes all callbacks
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id
    const msgId = query.message.message_id
    const data = query.data || ''
    const parts = data.split(':')
    const action = parts[0]

    // Helper
    function isAllowed() {
      return !state.ALLOWED_USER_ID || query.from.id === state.ALLOWED_USER_ID
    }
    if (!isAllowed()) return

    // ── action:stop — stop button on status message ─────────────────────────
    if (data === 'action:stop') {
      const session = state.activeSessions.get(chatId)
      if (!session) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Aucune session active' })
      }
      await bot.answerCallbackQuery(query.id, { text: '⏹ Arrêt en cours...' })
      clearTimeout(session.timer)
      clearTimeout(session.longRunTimer)
      session.proc.kill('SIGTERM')
      setTimeout(() => { try { session.proc.kill('SIGKILL') } catch {} }, 3000)
      state.activeSessions.delete(chatId)
      try {
        await bot.editMessageText('⏹ Arrêté.', {
          chat_id: chatId,
          message_id: session.statusMsgId
        })
      } catch {}
      return
    }

    // ── action:retry/continue/new — post-response buttons ───────────────────
    if (action === 'action') {
      const subAction = parts[1]
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})

      if (subAction === 'retry') {
        const last = state.lastPrompts.get(chatId)
        if (!last) return bot.answerCallbackQuery(query.id, { text: 'Rien à relancer' })
        if (state.activeSessions.has(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Déjà en cours' })
        await bot.answerCallbackQuery(query.id, { text: '🔄 Relance...' })
        processMessage(chatId, last.prompt, last.filePaths || [])
      }
      else if (subAction === 'continue') {
        if (state.activeSessions.has(chatId)) return bot.answerCallbackQuery(query.id, { text: 'Déjà en cours' })
        await bot.answerCallbackQuery(query.id, { text: '➡️ Suite...' })
        processMessage(chatId, 'Continue.', [])
      }
      else if (subAction === 'new') {
        const oldSid = state.conversationIds.get(chatId)
        if (oldSid) state.autoApproveSessions.delete(oldSid)
        state.conversationIds.delete(chatId)
        state.saveState()
        await bot.answerCallbackQuery(query.id, { text: '🆕 Nouvelle conversation' })
        await bot.sendMessage(chatId, '🆕 Nouvelle conversation.')
      }
      return
    }

    // ── approve/deny/approveall — approval buttons ──────────────────────────
    if (['approve', 'deny', 'approveall'].includes(action)) {
      const requestId = parts[1]
      const sessionId = parts[2] || ''

      const pending = state.pendingApprovals.get(requestId)
      if (!pending) {
        return bot.answerCallbackQuery(query.id, { text: '⏰ Expiré' })
      }

      if (action === 'approve') {
        pending.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
        await bot.answerCallbackQuery(query.id, { text: '✅' })
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      }
      else if (action === 'deny') {
        pending.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refusé par Louis' } })
        await bot.answerCallbackQuery(query.id, { text: '❌' })
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
        await bot.editMessageText(query.message.text + '\n\n❌ Refusé', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(() => {})
      }
      else if (action === 'approveall') {
        if (sessionId) state.autoApproveSessions.add(sessionId)
        pending.resolve({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
        await bot.answerCallbackQuery(query.id, { text: '⚡ Tout approuvé' })
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
        await bot.sendMessage(chatId, '⚡ Tout approuvé pour cette session.')
      }
      return
    }

    // ── media:* — PDF/audio mode picker ─────────────────────────────────────
    if (data.startsWith('media:')) {
      const media = state.pendingMedia.get(chatId)
      if (!media) return bot.answerCallbackQuery(query.id, { text: '⏱ Expiré — renvoie le fichier' })

      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: '▶️' })

      // PDF Q&A mode: ask for question, keep media stored
      if (data === 'media:pdf:qa') {
        state.pendingPdfQA.set(chatId, media.content)
        state.pendingMedia.delete(chatId)
        return bot.sendMessage(chatId, '❓ Pose ta question sur le document :')
      }

      state.pendingMedia.delete(chatId)
      const fn = media.fileName || 'document'

      const mediaPrompts = {
        'media:pdf:sum':    `Voici un PDF (${fn}):\n\n${media.content}\n\n---\nRésumé exécutif en 5-7 points clés. Structure: contexte → points principaux → conclusion/actions.`,
        'media:pdf:data':   `Voici un PDF (${fn}):\n\n${media.content}\n\n---\nExtrais les données structurées: tableaux en Markdown, chiffres clés, dates, montants. Si contrat: parties, durée, conditions. Si rapport: KPIs et métriques.`,
        'media:pdf:full':   `Voici un PDF (${fn}):\n\n${media.content}\n\n---\nAnalyse complète:\n1. Type de document détecté\n2. Résumé exécutif (3-5 lignes)\n3. Points clés structurés\n4. Données/chiffres importants\n5. Actions ou décisions à prendre\n6. Points d'attention ou risques`,
        'media:audio:raw':  media.content,
        'media:audio:sum':  `Voici la transcription d'un message vocal:\n\n"${media.content}"\n\n---\nRésume en 3-5 points essentiels. Sois concis.`,
        'media:audio:todo': `Voici la transcription d'un message vocal:\n\n"${media.content}"\n\n---\nExtrais toutes les actions/tâches mentionnées. Format: checklist avec priorité (🔴 urgent, 🟡 normal, 🟢 plus tard). Ajoute les deadlines si mentionnées.`,
        'media:audio:meet': `Voici la transcription d'un message vocal (notes de réunion):\n\n"${media.content}"\n\n---\nStructure en notes de réunion:\n• Sujets abordés\n• Décisions prises\n• Actions à mener (qui fait quoi)\n• Points en suspens`,
        'media:audio:msg':  `Voici la transcription d'un message vocal:\n\n"${media.content}"\n\n---\nTransforme en message professionnel écrit. Garde le sens, améliore la forme. Propose 2 versions: formelle et directe.`,
      }

      const prompt = mediaPrompts[data]
      if (prompt) {
        if (state.activeSessions.has(chatId)) {
          if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
          state.messageQueues.get(chatId).push({ prompt, filePaths: [] })
          return bot.sendMessage(chatId, '📋 En file.').catch(() => {})
        }
        processMessage(chatId, prompt, [])
      }
      return
    }

    // ── agent:* — agent picker ──────────────────────────────────────────────
    if (data.startsWith('agent:')) {
      const key = data.slice(6)
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      if (key === 'off') {
        agents.clearAgent(chatId)
        await bot.answerCallbackQuery(query.id, { text: '↩️ Aucun agent' })
        bot.sendMessage(chatId, '↩️ Aucun agent actif').catch(() => {})
      } else if (agents.setAgent(chatId, key)) {
        const a = agents.getAgent(chatId)
        await bot.answerCallbackQuery(query.id, { text: `${a.icon} ${a.name} activé` })
        bot.sendMessage(chatId, `${a.icon} Agent <b>${a.name}</b> activé`, { parse_mode: 'HTML' }).catch(() => {})
      } else {
        await bot.answerCallbackQuery(query.id, { text: '❌ Agent inconnu' })
      }
      return
    }

    // ── sugg:* — post-response suggestions ──────────────────────────────────
    if (data.startsWith('sugg:')) {
      const sugg = data.slice(5)
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      if (state.activeSessions.has(chatId)) {
        return bot.answerCallbackQuery(query.id, { text: '⏳ Session en cours' })
      }
      await bot.answerCallbackQuery(query.id, { text: '▶️ Lancement...' })
      const prompts = {
        diff:      'Montre-moi un git diff des fichiers modifiés. Format: fichier par fichier, changements clés seulement.',
        test:      'Lance les tests du projet actif et donne-moi un résumé des résultats.',
        explain:   'Explique en 3-5 points ce qui vient d\'être fait et pourquoi.',
        fix:       'Analyse les erreurs ci-dessus et corrige-les.',
        reformulate: 'Reformule le dernier texte produit différemment, même sens, autre angle.',
        shorten:   'Raccourcis le dernier texte produit à l\'essentiel, maximum 50% de la longueur.',
        variant:   'Propose une variante du dernier texte avec un ton différent.',
        actions:   'Extrait les actions concrètes prioritaires à mener suite à cette analyse.',
        risks:     'Identifie les risques et points de vigilance principaux.',
        challenge: 'Challenge mes hypothèses : qu\'est-ce qui pourrait être faux ou incomplet dans mon raisonnement ?',
        pros_cons: 'Fais un tableau Pour / Contre sur les options évoquées.',
        next_steps:'Liste les next steps concrets dans l\'ordre de priorité.',
        status:    'Donne-moi un status complet du VPS et des services.',
        logs:      'Montre-moi les logs récents des services actifs.',
      }
      const prompt = prompts[sugg]
      if (!prompt) return
      processMessage(chatId, prompt, [])
      return
    }

    // ── hist:* — history replay ─────────────────────────────────────────────
    if (data.startsWith('hist:')) {
      const idx = parseInt(data.slice(5))
      const hist = state.promptHistory.get(chatId) || []
      const entry = hist[idx]
      if (!entry) return bot.answerCallbackQuery(query.id, { text: '⚠️ Introuvable' })
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: '▶️ Relance...' })
      if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Déjà en cours.')
      processMessage(chatId, entry.prompt, [])
      return
    }

    // ── proj:* — project picker ─────────────────────────────────────────────
    if (data.startsWith('proj:')) {
      const proj = data.slice(5)
      state.currentProjects.set(chatId, proj)
      state.saveState()
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {})
      await bot.answerCallbackQuery(query.id, { text: `📂 ${proj}` })
      bot.sendMessage(chatId, `📂 Projet actif : <code>${fmt.escHtml(proj)}</code>`, { parse_mode: 'HTML' })
      return
    }

    // ── page:next — pagination ──────────────────────────────────────────────
    if (data === 'page:next') {
      const store = state.pageStore.get(chatId)
      if (!store) return bot.answerCallbackQuery(query.id, { text: '⏱️ Expiré' })
      const { chunks, parseMode, idx } = store
      if (idx >= chunks.length) return bot.answerCallbackQuery(query.id, { text: 'Fin' })
      const chunk = chunks[idx]
      const newIdx = idx + 1
      store.idx = newIdx
      const hasMore = newIdx < chunks.length
      if (!hasMore) state.pageStore.delete(chatId)
      await bot.answerCallbackQuery(query.id)
      const pageOpts = parseMode ? { parse_mode: parseMode } : {}
      if (hasMore) pageOpts.reply_markup = { inline_keyboard: [[{ text: `📄 ${newIdx}/${chunks.length} — Suite →`, callback_data: 'page:next' }]] }
      try { await bot.sendMessage(chatId, chunk, pageOpts) }
      catch { try { await bot.sendMessage(chatId, fmt.stripHtmlTags(chunk), hasMore ? { reply_markup: pageOpts.reply_markup } : {}) } catch {} }
      return
    }
  })
}
