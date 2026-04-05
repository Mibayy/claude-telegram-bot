'use strict';

const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, 'notes');
const MAX_NOTES = 50;

// Ensure notes directory exists
if (!fs.existsSync(NOTES_DIR)) {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

function _filePath(chatId) {
  return path.join(NOTES_DIR, `${chatId}.json`);
}

function _load(chatId) {
  const fp = _filePath(chatId);
  if (!fs.existsSync(fp)) return { notes: [] };
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return { notes: [] };
  }
}

function _save(chatId, data) {
  fs.writeFileSync(_filePath(chatId), JSON.stringify(data, null, 2), 'utf8');
}

function addNote(chatId, text) {
  const data = _load(chatId);
  if (data.notes.length >= MAX_NOTES) {
    data.notes.shift(); // remove oldest
  }
  const note = { text, time: Date.now() };
  data.notes.push(note);
  _save(chatId, data);
  return note;
}

function removeNote(chatId, oneBasedIdx) {
  const data = _load(chatId);
  const idx = oneBasedIdx - 1;
  if (idx < 0 || idx >= data.notes.length) return null;
  const removed = data.notes.splice(idx, 1)[0];
  _save(chatId, data);
  return removed.text;
}

function listNotes(chatId) {
  return _load(chatId).notes;
}

function searchNotes(chatId, query) {
  const lower = query.toLowerCase();
  return _load(chatId).notes.filter(n => n.text.toLowerCase().includes(lower));
}

function _relativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'à l\'instant';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days}j`;
}

function format(chatId) {
  const notes = _load(chatId).notes;
  if (notes.length === 0) return '📝 Aucune note.';
  return notes
    .map((n, i) => `<b>${i + 1}.</b> ${n.text}\n   <i>${_relativeTime(n.time)}</i>`)
    .join('\n');
}

function clearAll(chatId) {
  const fp = _filePath(chatId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = { addNote, removeNote, listNotes, searchNotes, format, clearAll };
