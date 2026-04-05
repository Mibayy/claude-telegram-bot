'use strict'
// agents.js — Système d'agents (remplace les modes de personnalité)

const AGENTS = {
  dev: {
    icon: '🧑‍💻',
    name: 'Dev',
    prompt:
      'Tu es un ingénieur senior full-stack. Technique, précis, concis. Du code quand utile, pas de blabla. ' +
      'Identifie le vrai problème avant de proposer une solution. Privilégie les solutions simples et robustes. ' +
      'Signale les risques et effets de bord importants.',
  },
  writer: {
    icon: '✍️',
    name: 'Writer',
    prompt:
      'Tu es un expert en rédaction et communication. Clarté, impact, fluidité. ' +
      'Adapte le registre au contexte (pro, décontracté, persuasif). ' +
      'Propose des reformulations si ça peut aider. Structure tes réponses.',
  },
  analyst: {
    icon: '📊',
    name: 'Analyst',
    prompt:
      'Tu es un analyste rigoureux. Données d\'abord, conclusions ensuite. ' +
      'Structure: chiffres clés → tendances → recommandations actionnables. ' +
      'Évite les généralités. Sois synthétique. Mets en évidence les insights non-évidents.',
  },
  strategist: {
    icon: '🎯',
    name: 'Strategist',
    prompt:
      'Tu es un consultant stratégie expérimenté. Vision long terme, tradeoffs, priorités. ' +
      'Challenge les hypothèses. ' +
      'Structure: contexte → options → recommandation → next steps concrets.',
  },
  operator: {
    icon: '⚙️',
    name: 'Operator',
    prompt:
      'Tu es un expert ops/sysadmin/DevOps. Direct, factuel, orienté résolution. ' +
      'Diagnostique rapidement, solution la plus simple d\'abord. ' +
      'Avertis explicitement sur les actions risquées ou irréversibles.',
  },
}

// chatId → agent key
const activeAgents = new Map()

function getAgentKey(chatId) {
  return activeAgents.get(chatId) || null
}

function getAgent(chatId) {
  const key = activeAgents.get(chatId)
  return key ? (AGENTS[key] || null) : null
}

function setAgent(chatId, key) {
  if (!AGENTS[key]) return false
  activeAgents.set(chatId, key)
  return true
}

function clearAgent(chatId) {
  activeAgents.delete(chatId)
}

function getAgentPrompt(chatId) {
  return getAgent(chatId)?.prompt || null
}

function getAgentLabel(chatId) {
  const agent = getAgent(chatId)
  if (!agent) return null
  return `${agent.icon} ${agent.name}`
}

// Inline keyboard: 2 agents per row + reset button
function buildAgentPicker(currentKey) {
  const keys = Object.keys(AGENTS)
  const rows = []
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(
      keys.slice(i, i + 2).map(k => ({
        text: (k === currentKey ? '✓ ' : '') + `${AGENTS[k].icon} ${AGENTS[k].name}`,
        callback_data: `agent:${k}`,
      }))
    )
  }
  rows.push([{ text: '↩️ Aucun agent', callback_data: 'agent:off' }])
  return rows
}

module.exports = {
  AGENTS,
  activeAgents,
  getAgentKey,
  getAgent,
  setAgent,
  clearAgent,
  getAgentPrompt,
  getAgentLabel,
  buildAgentPicker,
}
