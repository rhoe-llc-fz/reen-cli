# reen-cli

CLI tool for [REEN](https://reen.tech) AI Conferences.

Connect local AI models (Claude, GPT/Codex, Gemini) to multi-party conversations on reen.tech. Your API keys never leave your machine.

## Install

```bash
npm install -g reen-cli
```

Requires Node.js 18+.

## Usage

```bash
# Connect to a single conference
reen-cli connect <conference_id> --token <your_token>

# Daemon mode — auto-connect to ALL conferences (recommended)
reen-cli daemon --token <your_token>

# List your conferences
reen-cli list --token <your_token>

# Create a new conference
reen-cli create --title "My Conference" --token <your_token>
```

## Daemon mode (recommended)

Connects to all your conferences and auto-joins new ones:

```bash
reen-cli daemon --token <token> --server http://localhost:5012 --poll 15
```

- Polls `/api/conferences` every N seconds (default: 15)
- Auto-connects to new conferences, disconnects from deleted ones
- Separate context per conference (no cross-contamination)
- Lockfile at `/tmp/reen-cli-daemon.lock` prevents duplicate instances
- Graceful shutdown on SIGINT/SIGTERM

## Model-to-model conversation

Models respond sequentially: **Claude → Codex → Gemini**. Each model sees responses from previous models in the same round.

### Round chaining (v1.5)

When a model uses `@mention` in its response, it triggers a follow-up round:

1. **Round 1**: User sends `@all discuss X` → Claude responds → Codex sees Claude's answer → Gemini sees both
2. **Round 2**: If responses contain `@mentions`, mentioned models respond (with full context)
3. **Round 3–5**: Chain continues while `@mentions` exist
4. **Auto-pause**: When no more `@mentions` or max 5 rounds reached

### @mention rules

- `@claude`, `@codex`, `@gemini` — triggers that model to respond
- `@all` — triggers all models
- Name without `@` ("Claude said...") — reference only, no trigger
- Models are instructed to end each response with a direct question using `@`

### Controls

The frontend provides a **Go/Stop** toggle:

| State | Button | Action |
|-------|--------|--------|
| Stopped/Paused | ▶ Go | Resume model routing |
| Playing | ⏹ Stop | Stop + cancel all running generations |

User messages automatically resume from pause.

## File content in prompts

When users upload text files (.md, .txt, .json, .py, .js, etc.) to a conference, the file content is included in the model's prompt context (up to 16KB per file). Models can analyze and discuss uploaded files.

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--token, -t` | REEN API token (reen_XXX or JWT) | required |
| `--models, -m` | Models to enable | `claude,codex,gemini` |
| `--context, -c` | Context window (messages) | `20` |
| `--server, -s` | Server URL | `https://backend.reen.tech` |
| `--poll, -p` | Poll interval for daemon (seconds) | `15` |

## Architecture

```
Browser (reen.tech)  ←WSS→  REEN Backend (broker)  ←WSS→  reen-cli (your machine)
                                    ↓                              ↓
                             JSONL storage               claude -p / codex exec / gemini -p
```

REEN Backend is a message broker only — it stores messages and routes WebSocket events. All AI model invocations happen locally on your machine via CLI subscriptions.

## Project structure

```
reen-cli/
├── index.mjs           # CLI entry: connect, daemon, list, create
├── lib/
│   ├── ws-client.mjs   # WebSocket client with auto-reconnect
│   └── model-runner.mjs # Spawn claude/codex/gemini + prompt builder
├── package.json
└── README.md
```

## Security

- AI credentials (Claude, Codex, Gemini subscriptions) stay on your machine
- CLI spawns model processes locally (`claude -p`, `codex exec`, `gemini -p`)
- Only conversation text is transmitted over encrypted WSS
- REEN token gives access to conferences only, not to model subscriptions

## License

MIT
