'use strict'
const { spawn } = require('child_process')
const fs = require('fs')

module.exports = function registerMedia(bot, deps) {
  const { state, processMessage, fmt, tools } = deps
  // tools has: extractUrlText, extractPdfText, extractYoutubeTranscript, downloadTelegramFile, transcribeVoice
  // fmt has: escHtml, mdToHtml, stripHtmlTags

  function isAllowed(msg) {
    if (!state.ALLOWED_USER_ID || msg.from.id !== state.ALLOWED_USER_ID) {
      bot.sendMessage(msg.chat.id, `Non autorisé. ID: ${msg.from.id}`)
      return false
    }
    return true
  }

  const URL_RE = /https?:\/\/[^\s<>"]+/i
  const GHOSTWRITE_RE = /\b(écris?|rédige|draft|compose|prépare|formule|réponds?)\b.{0,80}\b(email|mail|message|courriel|texto|sms|lettre|réponse|relance|refus|excuse|candidature|dm|annonce)\b/i

  // ─── PDF handler (mode picker si pas de légende) ─────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return
    if (!msg.document) return
    if (msg.document.mime_type !== 'application/pdf') return
    state.processedMsgs.add(msg.message_id)
    const chatId = msg.chat.id
    if (state.activeSessions.has(chatId)) return bot.sendMessage(chatId, '⏳ Session en cours.')
    const statusMsg = await bot.sendMessage(chatId, '📄 Extraction du PDF...')
    try {
      const filePath = await tools.downloadTelegramFile(bot, msg.document.file_id)
      const pdfText = await tools.extractPdfText(filePath)
      try { fs.unlinkSync(filePath) } catch {}
      const fileName = msg.document.file_name || 'document.pdf'
      const pageMatch = pdfText.match(/\[PDF: (\d+) pages\]/)
      const pageCount = pageMatch ? pageMatch[1] : '?'
      const userQ = (msg.caption || '').trim()
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})

      if (userQ) {
        // Légende présente → Q&A direct
        processMessage(chatId, `Voici le contenu d'un PDF (${fileName}):\n\n${pdfText}\n\n---\nQuestion : ${userQ}`, [])
      } else {
        // Pas de légende → mode picker
        state.pendingMedia.set(chatId, { type: 'pdf', content: pdfText, fileName, time: Date.now() })
        bot.sendMessage(chatId,
          `📄 <b>${fmt.escHtml(fileName)}</b> — ${pageCount} pages extraites\n\nQue veux-tu en faire ?`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [
              { text: '📋 Résumé', callback_data: 'media:pdf:sum' },
              { text: '❓ Question', callback_data: 'media:pdf:qa' },
            ],
            [
              { text: '📊 Données / Tableaux', callback_data: 'media:pdf:data' },
              { text: '📑 Analyse complète', callback_data: 'media:pdf:full' },
            ],
          ]}
        })
      }
    } catch (err) {
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
      bot.sendMessage(chatId, `❌ Erreur PDF: ${err.message}`)
    }
  })

  // ─── Handler médias spéciaux : voix, audio, vidéo ────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return
    const chatId = msg.chat.id
    const isVoice = !!(msg.voice || msg.audio)
    const isVideo = !!(msg.video || msg.video_note)
    if (!isVoice && !isVideo) return  // handled by main message handler

    if (state.activeSessions.has(chatId)) {
      return bot.sendMessage(chatId, '⏳ Une commande est déjà en cours. /stop d\'abord.')
    }

    // ─── Voix / audio → transcription + mode picker ─────────────────────────
    if (isVoice) {
      const fileId = (msg.voice || msg.audio).file_id
      const thinking = await bot.sendMessage(chatId, '🎤 Transcription en cours...')
      try {
        const text = await tools.transcribeVoice(bot, fileId)
        await bot.deleteMessage(chatId, thinking.message_id).catch(() => {})
        if (!text) return bot.sendMessage(chatId, '⚠️ Transcription vide, réessaie.')

        // Store transcription + show mode picker
        state.pendingMedia.set(chatId, { type: 'audio', content: text, time: Date.now() })
        state.lastPrompts.set(chatId, { prompt: text, filePaths: [] })
        const preview = text.length > 250 ? text.slice(0, 247) + '…' : text
        bot.sendMessage(chatId, `🎤 <i>${fmt.escHtml(preview)}</i>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [
            [
              { text: '💬 Envoyer à Claude', callback_data: 'media:audio:raw' },
              { text: '📋 Résumé', callback_data: 'media:audio:sum' },
            ],
            [
              { text: '✅ Todos', callback_data: 'media:audio:todo' },
              { text: '📊 Notes réunion', callback_data: 'media:audio:meet' },
            ],
            [
              { text: '✉️ Message pro', callback_data: 'media:audio:msg' },
            ],
          ]}
        })
      } catch (err) {
        await bot.deleteMessage(chatId, thinking.message_id).catch(() => {})
        bot.sendMessage(chatId, `❌ Transcription échouée: ${err.message}`)
      }
      return
    }

    // ─── Vidéo ─────────────────────────────────────────────────────────────
    if (isVideo) {
      const fileId = (msg.video || msg.video_note).file_id
      const thinking = await bot.sendMessage(chatId, '🎬 Extraction frame vidéo...')
      try {
        const raw = await tools.downloadTelegramFile(bot, fileId)
        const frame = raw.replace(/\.\w+$/, '_frame.jpg')
        await new Promise((res, rej) => {
          const p = spawn('ffmpeg', ['-i', raw, '-vframes', '1', '-q:v', '2', '-y', frame], { stdio: 'ignore' })
          p.on('close', code => { try { fs.unlinkSync(raw) } catch {}; code === 0 ? res() : rej(new Error(`ffmpeg ${code}`)) })
        })
        await bot.deleteMessage(chatId, thinking.message_id).catch(() => {})
        const caption = msg.caption || 'Analyse cette capture de vidéo.'
        state.lastPrompts.set(chatId, { prompt: caption, filePaths: [frame] })
        await processMessage(chatId, caption, [frame])
      } catch (err) {
        await bot.deleteMessage(chatId, thinking.message_id).catch(() => {})
        bot.sendMessage(chatId, `❌ Extraction vidéo échouée: ${err.message}`)
      }
      return
    }
  })

  // ─── Main Message Handler ───────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return
    if (!isAllowed(msg)) return
    if (state.processedMsgs.has(msg.message_id)) return  // handled by a dedicated handler

    const chatId = msg.chat.id
    const userText = (msg.text || msg.caption || '').trim()

    // ── Skip PDF (handled by dedicated handler) ──────────────────────────────
    if (msg.document && msg.document.mime_type === 'application/pdf') return

    // ── Forwarded message → analyse / résumé ────────────────────────────────
    if ((msg.forward_from || msg.forward_sender_name || msg.forward_date) && userText && !msg.photo && !msg.document) {
      state.processedMsgs.add(msg.message_id)
      const sender = msg.forward_from
        ? `${msg.forward_from.first_name || ''} ${msg.forward_from.last_name || ''}`.trim()
        : (msg.forward_sender_name || 'inconnu')
      const prompt = `Message transféré de ${sender} :\n\n"${userText}"\n\n---\nAnalyse ce message. Résume les points clés, identifie si une action est attendue de ma part, et propose une réponse si pertinent.`
      state.lastPrompts.set(chatId, { prompt, filePaths: [] })
      if (state.activeSessions.has(chatId)) {
        if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
        state.messageQueues.get(chatId).push({ prompt, filePaths: [] })
        return bot.sendMessage(chatId, '📋 En file.')
      }
      return processMessage(chatId, prompt, [])
    }

    // ── PDF Q&A follow-up (user typed a question after clicking ❓) ──────────
    if (userText && state.pendingPdfQA.has(chatId)) {
      const pdfContent = state.pendingPdfQA.get(chatId)
      state.pendingPdfQA.delete(chatId)
      state.processedMsgs.add(msg.message_id)
      const prompt = `Voici le contenu d'un PDF:\n\n${pdfContent}\n\n---\nQuestion : ${userText}`
      state.lastPrompts.set(chatId, { prompt, filePaths: [] })
      if (state.activeSessions.has(chatId)) {
        if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
        state.messageQueues.get(chatId).push({ prompt, filePaths: [] })
        return bot.sendMessage(chatId, '📋 En file.')
      }
      return processMessage(chatId, prompt, [])
    }

    // ── Contact partagé → extraction infos ──────────────────────────────────
    if (msg.contact) {
      state.processedMsgs.add(msg.message_id)
      const c = msg.contact
      const parts = [`Contact reçu :`]
      if (c.first_name) parts.push(`Prénom : ${c.first_name}`)
      if (c.last_name) parts.push(`Nom : ${c.last_name}`)
      if (c.phone_number) parts.push(`Tél : ${c.phone_number}`)
      if (c.vcard) parts.push(`\nVCard :\n${c.vcard}`)
      const prompt = `${parts.join('\n')}\n\n---\nRésume les infos de ce contact. Si une VCard est présente, extrais tous les champs. Propose un résumé structuré et un éventuel contexte professionnel si tu peux le déduire du nom/entreprise.`
      state.lastPrompts.set(chatId, { prompt, filePaths: [] })
      if (state.activeSessions.has(chatId)) {
        if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
        state.messageQueues.get(chatId).push({ prompt, filePaths: [] })
        return bot.sendMessage(chatId, '📋 En file.')
      }
      return processMessage(chatId, prompt, [])
    }

    // ── Location partagée → recherche à proximité ──────────────────────────
    if (msg.location) {
      state.processedMsgs.add(msg.message_id)
      const { latitude, longitude } = msg.location
      const prompt = `Ma position GPS : ${latitude}, ${longitude}\n\nUtilise WebSearch pour chercher ce qu'il y a autour de cette position. Donne-moi :\n1. Adresse approximative\n2. Restaurants/cafés à proximité (top 3-5)\n3. Points d'intérêt notables\n\nSois concis.`
      state.lastPrompts.set(chatId, { prompt, filePaths: [] })
      if (state.activeSessions.has(chatId)) {
        if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
        state.messageQueues.get(chatId).push({ prompt, filePaths: [] })
        return bot.sendMessage(chatId, '📋 En file.')
      }
      return processMessage(chatId, prompt, [])
    }

    // ── YouTube detection → transcript + résumé ─────────────────────────────
    const ytMatch = userText.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/)
    if (ytMatch && !msg.photo && !msg.document) {
      const videoId = ytMatch[1]
      const url = `https://www.youtube.com/watch?v=${videoId}`
      state.processedMsgs.add(msg.message_id)
      const statusMsg = await bot.sendMessage(chatId, '🎬 Extraction du transcript YouTube...')
      try {
        const transcript = await tools.extractYoutubeTranscript(url)
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
        const userQ = userText.replace(ytMatch[0], '').replace(/https?:\/\//, '').trim()
        const instruction = userQ
          ? `Transcript d'une vidéo YouTube (${url}) :\n\n${transcript}\n\n---\n${userQ}`
          : `Transcript d'une vidéo YouTube (${url}) :\n\n${transcript}\n\n---\nRésume cette vidéo en points clés. Extrais les idées principales, les conseils actionnables, et les citations marquantes.`
        processMessage(chatId, instruction, [])
      } catch {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
        // Fallback: send URL to Claude with web search
        processMessage(chatId, `Voici une vidéo YouTube : ${url}\n\n${userText.replace(ytMatch[0], '').trim() || 'Cherche des infos sur cette vidéo via WebSearch et donne-moi un résumé.'}`, [])
      }
      return
    }

    // ── URL detection → extract + analyse ───────────────────────────────────
    const urlMatch = userText.match(URL_RE)
    if (urlMatch && !msg.photo && !msg.document) {
      const url = urlMatch[0]
      state.processedMsgs.add(msg.message_id)
      const statusMsg = await bot.sendMessage(chatId, '🌐 Extraction du contenu...')
      try {
        const extracted = await tools.extractUrlText(url)
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
        const userQ = userText.replace(url, '').trim()
        const isProduct = /\b(prix|price|achat|buy|shop|amazon|fnac|leboncoin|cdiscount|product|article)\b/i.test(url + userQ)
        const instruction = userQ
          ? `Voici le contenu d'une page web (${url}) :\n\n${extracted}\n\n---\n${userQ}`
          : isProduct
            ? `Voici la page d'un produit (${url}) :\n\n${extracted}\n\n---\nAnalyse ce produit : prix, caractéristiques clés, points forts/faibles, et donne-moi un avis rapide d'achat.`
            : `Voici le contenu d'un article (${url}) :\n\n${extracted}\n\n---\nRésume cet article en 5 points essentiels.`
        processMessage(chatId, instruction, [])
      } catch {
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
        // Fallback: send URL as-is to Claude
        processMessage(chatId, userText, [])
      }
      return
    }

    // ── Build prompt ─────────────────────────────────────────────────────────
    let promptParts = []
    let filePaths = []

    // Ghost Writer detection
    const isGhostWrite = GHOSTWRITE_RE.test(userText)

    if (userText) {
      if (isGhostWrite) {
        // Detect specific ghost writer type for tailored templates
        const typeMatch = userText.match(/\b(relance|follow.?up|refus|déclin|excuse|candidature|négoci|annonce|dm)\b/i)
        const msgType = userText.match(/email|mail|message|courriel|texto|sms|lettre|réponse|dm|annonce/i)?.[0] || 'message'
        let ghostPrompt
        if (typeMatch) {
          const templates = {
            relance:     `GHOST WRITER — RELANCE\nGénère 3 variantes de relance (${msgType}) :\n1. **Polie** — rappel bienveillant, sans pression\n2. **Directe** — ferme mais professionnelle, deadline implicite\n3. **Persuasive** — valeur ajoutée, urgence subtile`,
            'follow':    `GHOST WRITER — FOLLOW-UP\nGénère 3 variantes de follow-up (${msgType}) :\n1. **Soft** — juste un rappel amical\n2. **Structuré** — rappel + contexte + next step\n3. **Assertif** — rappel + conséquence si pas de retour`,
            refus:       `GHOST WRITER — REFUS POLI\nGénère 3 variantes de refus (${msgType}) :\n1. **Diplomate** — refus enrobé, porte ouverte\n2. **Direct** — refus clair, justifié, sans ambiguïté\n3. **Alternatif** — refus + contre-proposition`,
            déclin:      `GHOST WRITER — REFUS POLI\nGénère 3 variantes de refus (${msgType}) :\n1. **Diplomate** — refus enrobé, porte ouverte\n2. **Direct** — refus clair, justifié, sans ambiguïté\n3. **Alternatif** — refus + contre-proposition`,
            excuse:      `GHOST WRITER — EXCUSES\nGénère 3 variantes d'excuses (${msgType}) :\n1. **Sobre** — excuses sincères, factuel\n2. **Empathique** — reconnaissance de l'impact + correction\n3. **Pro** — excuses + plan d'action pour éviter la récidive`,
            candidature: `GHOST WRITER — CANDIDATURE\nGénère 3 variantes de ${msgType} de candidature :\n1. **Classique** — structuré, professionnel\n2. **Impactant** — accroche forte, résultats chiffrés\n3. **Personnalisé** — storytelling, connexion avec l'entreprise`,
            négoci:      `GHOST WRITER — NÉGOCIATION\nGénère 3 variantes de ${msgType} de négociation :\n1. **Collaborative** — gagnant-gagnant, ouvert\n2. **Assertive** — position claire, arguments factuels\n3. **Stratégique** — ancrage haut, concession conditionnelle`,
            annonce:     `GHOST WRITER — ANNONCE\nGénère 3 variantes d'annonce (${msgType}) :\n1. **Sobre** — factuel, clair\n2. **Enthousiaste** — énergie, vision\n3. **Storytelling** — contexte, voyage, destination`,
            dm:          `GHOST WRITER — DM PRO\nGénère 3 variantes de DM (${msgType}) :\n1. **Intro courte** — accroche + proposition en 2 lignes\n2. **Value-first** — donner avant de demander\n3. **Décontracté** — ton humain, pas corporate`,
          }
          const tKey = Object.keys(templates).find(k => typeMatch[1].toLowerCase().startsWith(k))
          ghostPrompt = (templates[tKey] || templates.relance) + `\n\nInstructions : ${userText}`
        } else {
          ghostPrompt = `GHOST WRITER: À partir de ces instructions, génère 3 variantes de ${msgType} :\n1. **Formel** — professionnel et soigné\n2. **Direct** — concis, sans fioritures\n3. **Amical** — chaleureux et naturel\n\nInstructions : ${userText}`
        }
        promptParts.push(ghostPrompt)
      } else {
        promptParts.push(userText)
      }
    }

    // Photos — multi-photo album support via media_group_id buffering
    if (msg.photo && msg.photo.length > 0) {
      // Album? Buffer and process together after 1.5s
      if (msg.media_group_id) {
        state.processedMsgs.add(msg.message_id)
        const groupId = msg.media_group_id
        if (!state.albumBuffers.has(groupId)) {
          state.albumBuffers.set(groupId, { chatId, photos: [], caption: '', timer: null })
        }
        const album = state.albumBuffers.get(groupId)
        album.photos.push(msg.photo[msg.photo.length - 1].file_id)
        if (msg.caption) album.caption = msg.caption
        clearTimeout(album.timer)
        album.timer = setTimeout(async () => {
          state.albumBuffers.delete(groupId)
          const fps = []
          const statusMsg = await bot.sendMessage(chatId, `📸 Téléchargement de ${album.photos.length} photos...`).catch(() => null)
          for (const fid of album.photos) {
            try { fps.push(await tools.downloadTelegramFile(bot, fid)) } catch {}
          }
          if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
          if (fps.length === 0) return
          const cap = album.caption.trim()
          const pr = cap
            ? `${cap}\n\n${fps.map(f => `[Image jointe: ${f}]`).join('\n')}`
            : `${fps.map(f => `[Image jointe: ${f}]`).join('\n')}\n\nAnalyse ces ${fps.length} images ensemble. Décris ce que tu vois et identifie les liens entre elles.`
          state.lastPrompts.set(chatId, { prompt: pr, filePaths: [...fps] })
          if (state.activeSessions.has(chatId)) {
            if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
            state.messageQueues.get(chatId).push({ prompt: pr, filePaths: fps })
            return bot.sendMessage(chatId, '📋 En file.').catch(() => {})
          }
          processMessage(chatId, pr, fps)
        }, 1500)
        return
      }
      // Single photo
      try {
        const largest = msg.photo[msg.photo.length - 1]
        const p = await tools.downloadTelegramFile(bot, largest.file_id)
        filePaths.push(p)
        const hasCaption = (msg.caption || '').trim().length > 0
        if (!hasCaption) {
          promptParts.push(`[Image jointe: ${p}]\n\nAnalyse cette image. Détecte automatiquement le type :\n- Si carte de visite → extrais Nom, Poste, Téléphone, Email et génère un bloc VCF prêt à l'emploi\n- Si document, tableau ou formulaire → convertis en Markdown structuré et propre\n- Si autre → décris et analyse ce que tu vois`)
        } else {
          promptParts.push(`[Image jointe: ${p}]`)
        }
      } catch (err) {
        bot.sendMessage(chatId, `⚠️ Erreur image: ${err.message}`)
      }
    }

    // Generic documents (non-PDF)
    if (msg.document && msg.document.mime_type !== 'application/pdf') {
      try {
        const p = await tools.downloadTelegramFile(bot, msg.document.file_id)
        filePaths.push(p)
        promptParts.push(`[Fichier joint: ${p} (${msg.document.file_name || 'sans nom'})]`)
      } catch (err) {
        bot.sendMessage(chatId, `⚠️ Erreur fichier: ${err.message}`)
      }
    }

    const prompt = promptParts.join('\n')
    if (!prompt) return

    state.lastPrompts.set(chatId, { prompt, filePaths: [...filePaths] })

    if (state.activeSessions.has(chatId)) {
      if (!state.messageQueues.has(chatId)) state.messageQueues.set(chatId, [])
      const queue = state.messageQueues.get(chatId)
      queue.push({ prompt, filePaths })
      bot.sendMessage(chatId, `📋 En file (#${queue.length}).`)
      return
    }

    await processMessage(chatId, prompt, filePaths)
  })

  // ─── Edited message → re-submit ───────────────────────────────────────────────
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
