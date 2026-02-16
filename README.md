# reen-cli

CLI client for [REEN AI Conference](https://reen.tech) — run AI models locally with your own subscriptions.

## What is this?

REEN AI Conference is a multi-model brainstorming tool where you chat with AI models (Claude, Codex/GPT, Gemini, Grok) in real-time. `reen-cli` connects to the REEN backend and runs AI models **on your machine** using your own CLI subscriptions.

**BYOK (Bring Your Own Keys):** Your API keys and subscriptions never leave your machine. REEN only sees the text messages.

## Install

```bash
npm install -g reen-cli
```

### Prerequisites

You need at least one AI CLI installed and authenticated:

| Model | CLI | Install | Subscription |
|-------|-----|---------|-------------|
| Claude | `claude` | [claude.ai/download](https://claude.ai/download) | Claude Max / Pro |
| Codex/GPT | `codex` | `npm install -g @openai/codex` | ChatGPT Pro |
| Gemini | `gemini` | `npm install -g @anthropic-ai/gemini-cli` | Free tier / Google AI Pro |
| Grok | `grok` | [grok.com](https://grok.com) | SuperGrok |

## Usage

### Daemon mode (recommended)

Automatically connects to all your conferences:

```bash
reen-cli daemon --token reen_YOUR_TOKEN
```

### Single conference

```bash
reen-cli connect CONF_ID --token reen_YOUR_TOKEN
```

### List conferences

```bash
reen-cli list --token reen_YOUR_TOKEN
```

### Create conference

```bash
reen-cli create --title "Architecture Review" --token reen_YOUR_TOKEN
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--token, -t` | REEN API token (`reen_XXX` or JWT) | required |
| `--backend, -s` | Backend URL | `https://backend.reen.tech` |
| `--models, -m` | Models (comma-separated) | `claude,codex,gemini,grok` |
| `--poll, -p` | Poll interval in seconds | `15` |
| `--context, -c` | Context size (messages) | `50` |
| `--verbose, -v` | Verbose output | `false` |

## Environment variables

```bash
export REEN_TOKEN=reen_YOUR_TOKEN
export REEN_BACKEND=https://backend.reen.tech
export MODELS=claude,codex,gemini
```

## How it works

```
Browser (reen.tech)  ←WSS→  REEN Backend  ←WSS→  reen-cli (your machine)
                                                         ↓
                                                  claude -p / codex exec
                                                  gemini -p / grok -p
```

1. You type `@claude help me with this` in a conference on reen.tech
2. Backend broadcasts the message via WebSocket
3. `reen-cli` receives the @mention, spawns `claude -p` locally
4. Claude's response is sent back through WebSocket
5. All conference participants see the response in real-time

## Security

- API keys and CLI subscriptions stay **on your machine**
- Only message text travels over WSS
- REEN token gives access to conferences only, not to your model subscriptions
- CLI processes run in a sandboxed directory (`/tmp/reen-sandbox`)
- Claude Code session variables are stripped to prevent nested sessions

## Features

- **Daemon mode** — auto-connects to all conferences
- **@mention routing** — `@claude`, `@codex`, `@gemini`, `@grok`, `@all`
- **Model-to-model discussions** — models can @mention each other for multi-round debates
- **File sharing** — uploaded text files are included in model context
- **Cancel support** — stop model generation mid-response
- **Auto-reconnect** — WebSocket reconnects on connection drops
- **Lockfile protection** — prevents duplicate daemon instances

## License

MIT — [Rhoe, LLC-FZ](https://reen.tech)
