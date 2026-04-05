'use strict'

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mdToHtml(text) {
  try {
    let result = text
    result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escHtml(code.trimEnd())}</code></pre>`
    })
    result = result.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escHtml(code)}</code>`)
    result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')
    result = result.replace(/(?<![<\w])\*([^*\n]+)\*(?![>\w])/g, '<i>$1</i>')
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    result = result.replace(/^#{1,6}\s+(.+)$/gm, '\n<b>$1</b>')
    result = result.replace(/^>\s?(.*)$/gm, '┃ <i>$1</i>')
    result = result.replace(/^[\s]*[-*]\s+(.+)$/gm, '  • $1')
    result = result.replace(/^[\s]*(\d+)\.\s+(.+)$/gm, '  $1. $2')
    result = result.replace(/^[-*]{3,}$/gm, '──────────────────')
    return result
  } catch {
    return escHtml(text)
  }
}

function stripHtmlTags(html) {
  return html
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + c.replace(/<[^>]+>/g, '').trim() + '\n```\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, (_, c) => '*' + c + '*')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, (_, c) => '*' + c + '*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, (_, c) => '_' + c + '_')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, (_, c) => '_' + c + '_')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Send a long message, splitting into pages if needed.
// bot: Telegram bot instance
// state: state module (needs pageStore, lastBotMessages)
async function sendLong(bot, chatId, text, parseMode, state) {
  const MAX_MSG = 4096
  if (!text || text.trim() === '') return bot.sendMessage(chatId, '(réponse vide)')

  const chunks = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG) { chunks.push(remaining); break }
    let splitAt = remaining.lastIndexOf('\n', MAX_MSG)
    if (splitAt < MAX_MSG * 0.5) splitAt = MAX_MSG
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }

  if (chunks.length === 1) {
    const opts = parseMode ? { parse_mode: parseMode } : {}
    try {
      const sent = await bot.sendMessage(chatId, chunks[0], opts)
      state.lastBotMessages.set(chatId, sent.message_id)
    } catch {
      try {
        const sent = await bot.sendMessage(chatId, stripHtmlTags(chunks[0]))
        state.lastBotMessages.set(chatId, sent.message_id)
      } catch {}
    }
    return
  }

  state.pageStore.set(chatId, { chunks, parseMode, idx: 1 })
  const navBtn = { inline_keyboard: [[{ text: `📄 1/${chunks.length} — Suite →`, callback_data: 'page:next' }]] }
  const opts = { ...(parseMode ? { parse_mode: parseMode } : {}), reply_markup: navBtn }
  try {
    const sent = await bot.sendMessage(chatId, chunks[0], opts)
    state.lastBotMessages.set(chatId, sent.message_id)
  } catch {
    try {
      const sent = await bot.sendMessage(chatId, stripHtmlTags(chunks[0]), { reply_markup: navBtn })
      state.lastBotMessages.set(chatId, sent.message_id)
    } catch (e) { console.error('[SEND] Failed:', e.message) }
  }
}

module.exports = { escHtml, mdToHtml, stripHtmlTags, sendLong }
