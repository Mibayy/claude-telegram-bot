'use strict'
// memory.js — Mémoire utilisateur persistante (faits, préférences)

const fs = require('fs')
const path = require('path')

const MEMORY_DIR = path.join(__dirname, 'memory')
const MAX_FACTS = 20

// Ensure directory exists at module load
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true })
}

function filePath(chatId) {
  return path.join(MEMORY_DIR, `${chatId}.json`)
}

function load(chatId) {
  try {
    const fp = filePath(chatId)
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf8'))
    }
  } catch {}
  return { facts: [] }
}

function save(chatId, data) {
  try {
    data.updatedAt = new Date().toISOString()
    fs.writeFileSync(filePath(chatId), JSON.stringify(data, null, 2))
  } catch (err) {
    console.error('[MEMORY] Save error:', err.message)
  }
}

// Add a fact to user memory. Returns false if duplicate or limit reached.
function addFact(chatId, fact) {
  fact = fact.trim()
  if (!fact) return false
  const data = load(chatId)
  if (!Array.isArray(data.facts)) data.facts = []
  if (data.facts.some(f => f.toLowerCase() === fact.toLowerCase())) return false
  data.facts.push(fact)
  if (data.facts.length > MAX_FACTS) data.facts.shift()
  save(chatId, data)
  return true
}

// Remove fact by 1-based index. Returns removed fact or null.
function removeFact(chatId, oneBasedIdx) {
  const data = load(chatId)
  if (!Array.isArray(data.facts)) return null
  const idx = oneBasedIdx - 1
  if (idx < 0 || idx >= data.facts.length) return null
  const [removed] = data.facts.splice(idx, 1)
  save(chatId, data)
  return removed
}

// Returns a brief string for injection into system prompt, or null if empty.
function getSystemContext(chatId) {
  const data = load(chatId)
  if (!Array.isArray(data.facts) || data.facts.length === 0) return null
  return `Contexte utilisateur mémorisé :\n${data.facts.map(f => `- ${f}`).join('\n')}`
}

// Returns a formatted Telegram-ready string showing current memory.
function format(chatId) {
  const data = load(chatId)
  if (!Array.isArray(data.facts) || data.facts.length === 0) {
    return '🧠 Mémoire vide.\n\n<i>Utilise /remember [info] pour mémoriser quelque chose.</i>'
  }
  const lines = data.facts.map((f, i) => `${i + 1}. ${f}`)
  const updatedStr = data.updatedAt
    ? `\n\n<i>Mis à jour le ${new Date(data.updatedAt).toLocaleDateString('fr-FR')}</i>`
    : ''
  return (
    `🧠 <b>Mémoire</b> (${data.facts.length}/${MAX_FACTS})\n\n` +
    lines.join('\n') +
    updatedStr +
    '\n\n/forget [numéro] pour supprimer'
  )
}

module.exports = { load, save, addFact, removeFact, getSystemContext, format }
