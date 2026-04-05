# Claude Telegram Bot

A full-featured Telegram bot that gives you mobile access to [Claude Code](https://claude.ai/code) — Anthropic's AI coding assistant — from anywhere.

Send messages from your phone, get live streaming responses, approve tool calls, manage your projects, and let Claude edit code on your server — all through Telegram.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![License](https://img.shields.io/badge/license-ISC-blue)

---

## Features

### Core
- **Full Claude Code integration** — spawns `claude` CLI with your prompts, streams responses back in real time
- **Live tool call display** — see every tool Claude uses (Edit, Bash, Read, etc.) as it happens
- **Conversation continuity** — resumes sessions across messages, auto-retries on session expiry
- **Per-user project switching** — tell the bot which project to work on, it injects `switch_project()` automatically
- **Fast mode** — toggle `--fast` flag on Claude for quicker responses (`/fast`)

### Approval system
- **Interactive tool approval** — Claude asks before running Bash/Edit/Write; you approve or deny from Telegram buttons
- **"Approve all" for session** — one tap to auto-approve the rest of a session
- **Dual-mode approvals** — works for both Telegram-launched and terminal-launched Claude sessions
- **Web UI** — optional browser interface for approvals (useful on desktop)
- **Approval modes** — `all` (default), `telegram-only`, or `off`

### Media & file handling
- **Voice messages** — transcribed via Whisper and sent to Claude
- **Photos** — downloaded and passed as context
- **PDFs** — extracted and summarized, or used as context for Q&A
- **URLs** — content extracted via `trafilatura` and passed to Claude
- **YouTube** — transcript extracted and passed to Claude
- **Photo albums** — grouped and sent together

### Productivity
- **Memory system** — persist facts about yourself per chat (`/remember`, `/forget`, `/memory`)
- **Notes** — quick note-taking with search (`/note`, `/notes`, `/search`)
- **Reminders** — set timed reminders (`/remind 30m Check the deploy`)
- **Prompt history** — navigate previous prompts with arrow buttons
- **Agents** — switch between specialized Claude personas (coder, analyst, etc.)
- **Verbose levels** — control how much tool detail you see (`/verbose 0/1/2`)

### System monitoring
- **Service monitor** — watch systemd services, alerts on state changes (`/monitor`)
- **Usage stats** — bot uptime, active sessions, approval mode (`/usage`)
- **Stop** — kill a running Claude session at any time with the ⏹ button

---

## Requirements

- **Node.js** 18+
- **Claude Code CLI** installed and authenticated (`claude` in PATH)
- A **Telegram bot token** (from [@BotFather](https://t.me/BotFather))
- Your **Telegram user ID** (from [@userinfobot](https://t.me/userinfobot))

### Optional (for media features)
- **Python 3** with `trafilatura` (URL extraction), `pymupdf` (PDF extraction), `youtube-transcript-api` (YouTube)
- **Whisper** (`openai-whisper`) for voice transcription

---

## Installation

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/claude-telegram-bot.git
cd claude-telegram-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in at minimum:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_USER_ID=your_telegram_user_id
```

### 3. (Optional) Set up Python tools

For URL/PDF/YouTube/voice features, create a virtualenv and install dependencies:

```bash
python3 -m venv bot-tools-venv
source bot-tools-venv/bin/activate
pip install trafilatura pymupdf youtube-transcript-api

python3 -m venv whisper-venv
source whisper-venv/bin/activate
pip install openai-whisper
```

Then update `.env`:
```env
BOT_TOOLS_PYTHON=/path/to/bot-tools-venv/bin/python3
WHISPER_PYTHON_BIN=/path/to/whisper-venv/bin/python3
```

### 4. Run

```bash
node bot.js
```

---

## Running as a systemd service

Create `/etc/systemd/system/claude-telegram.service`:

```ini
[Unit]
Description=Claude Telegram Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/claude-telegram-bot
EnvironmentFile=/path/to/claude-telegram-bot/.env
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable claude-telegram
sudo systemctl start claude-telegram
```

---

## Setting up the approval hook

The approval system requires Claude Code to call the bot's HTTP server before executing tools. Add this to your Claude Code hooks configuration (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/claude-telegram-bot/approval-hook.js"
          }
        ]
      }
    ]
  }
}
```

When Claude runs from Telegram, the hook sends approval requests back to your Telegram chat. When Claude runs from a terminal, the hook shows approval options in the terminal AND sends a notification to Telegram.

---

## Commands reference

### Claude interaction
| Command | Description |
|---------|-------------|
| _(any text)_ | Send a message to Claude |
| `/new` | Start a new conversation (clear session) |
| `/stop` | Kill the current Claude session |
| `/retry` | Retry the last prompt |
| `/continue` | Ask Claude to continue its last response |

### Project management
| Command | Description |
|---------|-------------|
| `/project <name>` | Set the active project for this chat |
| `/project` | Show current project |
| `/projects` | List available projects |

### Approval control
| Command | Description |
|---------|-------------|
| `/approval all` | Approve all tool uses (default) |
| `/approval telegram` | Only approve when launched from Telegram |
| `/approval off` | Auto-approve everything (no prompts) |

### Memory & notes
| Command | Description |
|---------|-------------|
| `/remember <fact>` | Save a fact to memory |
| `/forget <n>` | Remove memory entry #n |
| `/memory` | Show all saved memories |
| `/note <text>` | Save a note |
| `/notes` | List all notes |
| `/search <query>` | Search notes |
| `/clearnotes` | Delete all notes |

### Reminders
| Command | Description |
|---------|-------------|
| `/remind <delay> <text>` | Set a reminder (e.g. `/remind 30m Deploy check`) |
| `/reminders` | List active reminders |
| `/cancelreminder <id>` | Cancel a reminder |

Delay formats: `30s`, `5m`, `2h`, `1d`

### Settings
| Command | Description |
|---------|-------------|
| `/fast` | Toggle fast mode (`--fast` flag) |
| `/verbose 0\|1\|2` | Set tool display verbosity |
| `/timeout <seconds>` | Set Claude timeout (default: 600s) |
| `/agent` | Open agent picker |

### System
| Command | Description |
|---------|-------------|
| `/monitor` | Show systemd service status |
| `/usage` | Bot stats (uptime, sessions, mode) |
| `/help` | Show all commands |

---

## Architecture

```
bot.js                  — Entry point, TelegramBot setup, server init
process.js              — Core: spawns Claude CLI, streams JSON output to Telegram
state.js                — Shared state (sessions, projects, queues, config)
agents.js               — Agent personas (prompt variants for Claude)
memory.js               — Per-chat persistent memory (JSON files)
notes.js                — Per-chat note storage
reminders.js            — In-memory reminder scheduler
monitor.js              — systemd service status watcher

handlers/
  commands.js           — All /command handlers
  callbacks.js          — Inline keyboard button handlers
  media.js              — Photo, voice, video, PDF, URL, YouTube handlers

server/
  approval.js           — HTTP server for Claude Code PreToolUse hook
  webui.js              — Browser-based approval UI

utils/
  format.js             — Message formatting, markdown→HTML, long message splitting
  tools.js              — Python tool wrappers (URL, PDF, YouTube, Whisper)

tools/
  extract_url.py        — Web content extraction (trafilatura)
  extract_pdf.py        — PDF text extraction (pymupdf)
  extract_youtube.py    — YouTube transcript extraction

approval-hook.js        — Claude Code hook script (called by Claude before each tool use)
```

---

## How it works

1. You send a message on Telegram
2. The bot spawns `claude -p --verbose --output-format stream-json <your message>`
3. Claude's JSON stream is parsed in real time:
   - Tool calls → shown as live status updates in Telegram
   - Text streaming → shown progressively in the same message
4. If an approval hook is configured, Claude pauses before each tool call and sends you an inline keyboard to approve/deny
5. On completion, the final response is sent, along with a summary of files edited and commands run

---

## Security

- The bot enforces a single-user whitelist via `TELEGRAM_USER_ID` — only your Telegram account can interact with it
- The approval HTTP server listens on `127.0.0.1` only (not externally accessible)
- The web UI token (`WEB_APPROVAL_TOKEN`) should be set if you expose the web UI via a reverse proxy

---

## License

ISC
