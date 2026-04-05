'use strict';

const MAX_PER_USER = 10;

let _nextId = 1;
// Map<id, { id, chatId, text, fireAt, timer }>
const _reminders = new Map();

function schedule(chatId, delayMs, text, callback) {
  // Count active reminders for this user
  let count = 0;
  for (const r of _reminders.values()) {
    if (r.chatId === chatId) count++;
  }
  if (count >= MAX_PER_USER) return null;

  const id = _nextId++;
  const fireAt = Date.now() + delayMs;
  const timer = setTimeout(() => {
    _reminders.delete(id);
    callback(chatId, text);
  }, delayMs);

  _reminders.set(id, { id, chatId, text, fireAt, timer });
  return id;
}

function cancel(id) {
  const r = _reminders.get(id);
  if (!r) return false;
  clearTimeout(r.timer);
  _reminders.delete(id);
  return true;
}

function listActive(chatId) {
  const result = [];
  for (const r of _reminders.values()) {
    if (r.chatId === chatId) {
      result.push({ id: r.id, text: r.text, fireAt: r.fireAt });
    }
  }
  return result.sort((a, b) => a.fireAt - b.fireAt);
}

function _formatCountdown(fireAt) {
  const diff = fireAt - Date.now();
  if (diff <= 0) return 'imminent';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) {
    return remainMin > 0 ? `${hours}h${remainMin}min` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainH = hours % 24;
  return remainH > 0 ? `${days}j ${remainH}h` : `${days}j`;
}

function format(chatId) {
  const active = listActive(chatId);
  if (active.length === 0) return '⏰ Aucun rappel actif.';
  return active
    .map(r => `<b>#${r.id}</b> — ${r.text}\n   <i>dans ${_formatCountdown(r.fireAt)}</i>`)
    .join('\n');
}

function parseDelay(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  if (!s) return null;

  // Try compound format like "1h30", "1h30m", "2h15min"
  const compound = s.match(/^(\d+)h(\d+)(?:m(?:in)?)?$/);
  if (compound) {
    const hours = parseInt(compound[1], 10);
    const mins = parseInt(compound[2], 10);
    return (hours * 3600 + mins * 60) * 1000;
  }

  // Simple format: number + unit
  const simple = s.match(/^(\d+)\s*(s|sec|m|min|h|j|d)$/);
  if (!simple) return null;

  const val = parseInt(simple[1], 10);
  const unit = simple[2];

  switch (unit) {
    case 's':
    case 'sec':
      return val * 1000;
    case 'm':
    case 'min':
      return val * 60 * 1000;
    case 'h':
      return val * 3600 * 1000;
    case 'j':
    case 'd':
      return val * 86400 * 1000;
    default:
      return null;
  }
}

module.exports = { schedule, cancel, listActive, format, parseDelay };
