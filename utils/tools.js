'use strict'
const { spawn } = require('child_process')
const https = require('https')
const fs = require('fs')
const path = require('path')

const TOOLS_DIR = path.join(__dirname, '..', 'tools')
const PYTHON = process.env.BOT_TOOLS_PYTHON || 'python3'
const WHISPER_PYTHON = process.env.WHISPER_PYTHON_BIN || 'python3'

function extractUrlText(url) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON, [path.join(TOOLS_DIR, 'extract_url.py'), url], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    py.stdout.on('data', d => out += d)
    py.stderr.on('data', d => err += d)
    py.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())))
  })
}

function extractPdfText(filePath) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON, [path.join(TOOLS_DIR, 'extract_pdf.py'), filePath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    py.stdout.on('data', d => out += d)
    py.stderr.on('data', d => err += d)
    py.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim())))
  })
}

function extractYoutubeTranscript(url) {
  return new Promise((resolve, reject) => {
    const py = spawn(PYTHON, [path.join(TOOLS_DIR, 'extract_youtube.py'), url], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })
    let out = '', err = ''
    py.stdout.on('data', d => out += d)
    py.stderr.on('data', d => err += d)
    py.on('close', code => code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err.trim() || 'Pas de transcript')))
  })
}

function downloadTelegramFile(bot, fileId) {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN
  return new Promise(async (resolve, reject) => {
    try {
      const file = await bot.getFile(fileId)
      const url = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const ext = path.extname(file.file_path) || '.tmp'
      const tmpPath = `/tmp/tg_${Date.now()}${ext}`
      const out = fs.createWriteStream(tmpPath)
      https.get(url, (res) => {
        res.pipe(out)
        out.on('finish', () => { out.close(); resolve(tmpPath) })
      }).on('error', reject)
    } catch (err) { reject(err) }
  })
}

async function transcribeVoice(bot, fileId) {
  const raw = await downloadTelegramFile(bot, fileId)
  const wav = raw.replace(/\.\w+$/, '.wav')
  await new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-i', raw, '-ar', '16000', '-ac', '1', '-y', wav], { stdio: 'ignore' })
    p.on('close', code => { try { fs.unlinkSync(raw) } catch {}; code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`)) })
  })
  return new Promise((resolve, reject) => {
    const py = spawn(WHISPER_PYTHON, ['-c',
      `import whisper; m=whisper.load_model('base'); r=m.transcribe(${JSON.stringify(wav)}); print(r['text'].strip())`
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    py.stdout.on('data', d => out += d.toString())
    py.on('close', code => {
      try { fs.unlinkSync(wav) } catch {}
      code === 0 ? resolve(out.trim()) : reject(new Error(`whisper exit ${code}`))
    })
  })
}

module.exports = { extractUrlText, extractPdfText, extractYoutubeTranscript, downloadTelegramFile, transcribeVoice }
