#!/usr/bin/env node
/**
 * reen-cli daemon — auto-connect to all conferences
 *
 * Polls API, connects to new/active conferences via WebSocket,
 * listens for @mentions, routes to AI CLI (claude/gpt/gemini/grok).
 *
 * Standalone: all code in a single file (ws + node-pty).
 *
 * Usage:
 *   node reen/scripts/daemon.mjs --token reen_XXX --backend https://test-api.reen.tech
 *   node reen/scripts/daemon.mjs --token reen_XXX --backend https://backend.reen.tech --models claude
 *   JWT=reen_XXX SERVER=https://test-api.reen.tech node reen/scripts/daemon.mjs
 */

import WebSocket from 'ws';
import pty from 'node-pty';
import { execSync } from 'child_process';
import { mkdirSync } from 'fs';

// ═══════════════════════════════════════════
// §1. Configuration
// ═══════════════════════════════════════════

const DEFAULTS = {
  backend: 'http://localhost:5012',
  models: ['claude', 'gpt', 'gemini', 'grok'],
  recentBufferSize: 50,
  summaryInterval: 10,
  typingIntervalMs: 5000,
  claudeTimeoutMs: 120000,
  gptTimeoutMs: 180000,
  geminiTimeoutMs: 120000,
  grokTimeoutMs: 120000,
  pollIntervalMs: 10000,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };

  // Env vars take priority
  config.token = process.env.JWT || process.env.REEN_TOKEN || null;
  config.backend = process.env.SERVER || process.env.REEN_BACKEND || config.backend;
  if (process.env.MODELS) config.models = process.env.MODELS.split(',').map(m => m.trim());

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token': config.token = args[++i]; break;
      case '--backend': config.backend = args[++i]; break;
      case '--models': config.models = args[++i].split(',').map(m => m.trim()); break;
      case '--poll': config.pollIntervalMs = parseInt(args[++i]) * 1000; break;
      case '--verbose': config.verbose = true; break;
      case '--help':
        console.log('Usage: node daemon.mjs --token <reen_XXX> [--backend URL] [--models claude,gpt,gemini] [--poll 10] [--verbose]');
        process.exit(0);
    }
  }

  if (!config.token) {
    console.error('Required: --token <reen_XXX> or JWT=<token>');
    process.exit(1);
  }

  return config;
}

const CONFIG = parseArgs();
const log = (...args) => CONFIG.verbose && console.log('[daemon]', ...args);

// ═══════════════════════════════════════════
// §2. CLI Executors (PTY spawn)
// ═══════════════════════════════════════════

/** Clean env without Claude Code variables (prevent nested session) */
function cleanEnv(base = process.env) {
  const env = { ...base };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

/** Check if CLI command is available */
function hasCLI(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Sandbox for CLI — models won't scan the working repository
const SANDBOX_DIR = '/tmp/reen-sandbox';
mkdirSync(SANDBOX_DIR, { recursive: true });

/** Universal CLI call via PTY. Returns { promise, proc } */
function callCLI(command, args, timeoutMs, env = cleanEnv()) {
  const proc = pty.spawn(command, args, {
    name: 'xterm-color',
    cols: 120,
    rows: 30,
    cwd: SANDBOX_DIR,
    env,
  });

  let output = '';
  const timer = setTimeout(() => {
    proc.kill();
  }, timeoutMs);

  proc.onData(data => { output += data; });

  const promise = new Promise((resolve, reject) => {
    const timeoutReject = setTimeout(() => {
      proc.kill();
      reject(new Error(`${command} timeout (${timeoutMs}ms)`));
    }, timeoutMs + 100);

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      clearTimeout(timeoutReject);
      // Clean ANSI/PTY artifacts
      const clean = output
        .replace(/\x1b\[[0-9;?<>=:]*[a-zA-Z@^`{|}~]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[()][A-Z0-9]/g, '')
        .replace(/\x1b[>=<cDEHMNOZ78]/g, '')
        .replace(/\x1b/g, '')
        .replace(/\r/g, '')
        .replace(/\[[0-9;?<>=:]*[a-zA-Z@^`{|}~]/g, '')
        .replace(/\]9;[0-9;]*[^\]]*$/gm, '')
        .replace(/\n[a-z]\s*$/i, '')
        .trim();
      if (exitCode !== 0 && exitCode !== null) {
        reject(new Error(`${command} exit ${exitCode}: ${clean.substring(0, 200)}`));
        return;
      }
      resolve(clean);
    });
  });

  return { promise, proc };
}

/** Filter CLI garbage (loading messages, hooks, credentials) */
function filterCLIGarbage(raw) {
  const lines = raw.split('\n');
  let inStackTrace = false;
  const filtered = lines.filter(line => {
    const l = line.trim();
    if (!l) return false;
    // Gemini CLI garbage
    if (l.startsWith('Loaded cached credentials')) return false;
    if (l.startsWith('Project hooks disabled')) return false;
    if (l.startsWith('Hook registry initialized')) return false;
    if (l.startsWith('Attempt ') && l.includes('failed with status')) return false;
    // Common CLI messages
    if (l.startsWith('Warning:') || l.startsWith('Note:')) return false;
    // Stack trace фильтрация (GaxiosError, Error, etc.)
    if (/^(Gaxios)?Error:?\s/.test(l) || l.startsWith('GaxiosError')) { inStackTrace = true; return false; }
    if (inStackTrace) {
      // Stack trace lines: "at Foo (/path...)", "code: 429", "status: 429", curly braces
      if (/^\s*at\s/.test(line) || /^\s*(code|status|statusText|data|config|headers|url|method|stack)\s*:/.test(l) || l === '{' || l === '}' || l === '},') return false;
      // End of stack trace — regular text
      if (l.length > 0 && !l.startsWith('at ') && !l.includes('Error') && !/^\s*[{}\[\]]/.test(l)) inStackTrace = false;
    }
    return true;
  });
  return filtered.join('\n').trim();
}

/** Detect API errors in CLI response */
function detectAPIError(raw) {
  // JSON error response (Google API, etc.)
  const errorMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (errorMatch && (raw.includes('"error"') || raw.includes('RESOURCE_EXHAUSTED') || raw.includes('rateLimitExceeded'))) {
    return errorMatch[1];
  }
  // Gaxios / HTTP stack traces (Gemini CLI on 429, 500, etc.)
  const gaxiosMatch = raw.match(/GaxiosError:?\s*(.+?)[\n{]/);
  if (gaxiosMatch) {
    const codeMatch = raw.match(/code:\s*(\d{3})/);
    const code = codeMatch ? ` (HTTP ${codeMatch[1]})` : '';
    return `${gaxiosMatch[1].trim()}${code}`;
  }
  // General pattern: HTTP error codes in stack traces
  const httpErrMatch = raw.match(/(?:status\s*code|HTTP)\s*(\d{3})\b/i);
  if (httpErrMatch && raw.includes('Error') && (raw.includes('    at ') || raw.includes('stack:'))) {
    return `HTTP ${httpErrMatch[1]} error`;
  }
  return null;
}

function spawnClaude(prompt) {
  const { promise, proc } = callCLI('claude', ['-p', prompt], CONFIG.claudeTimeoutMs);
  return { proc, promise: promise.then(raw => {
    if (!raw || raw.length < 3) throw new Error('Claude: empty response');
    return raw;
  })};
}

function cleanCodexOutput(raw) {
  // Step 1: Cut everything before the last "=== YOUR TURN ===" (end of prompt echo)
  let response = raw;
  const lastYourTurn = response.lastIndexOf('=== YOUR TURN ===');
  if (lastYourTurn !== -1) response = response.substring(lastYourTurn + 17);

  // Step 2: If there are "codex\n" segments — take the last long one (final answer)
  const segments = response.split(/\ncodex\n/);
  if (segments.length > 1) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i].trim().length > 50) { response = segments[i]; break; }
    }
  }

  // Step 3: Line-by-line garbage filtering
  response = response.split('\n').filter(line => {
    const l = line.trim();
    if (!l) return true;
    // Codex CLI header/footer
    if (/^(OpenAI Codex|workdir:|model:|provider:|approval:|sandbox:|reasoning\s|session id:|--------$)/.test(l)) return false;
    if (/^tokens?\s+used/i.test(l)) return false;
    // Bare numbers — token counter without prefix (1,297 / 5432 / 12,345)
    if (/^\d[\d,]*$/.test(l)) return false;
    // Prompt echo
    if (/^(user$|=== (DISCUSSION SUMMARY|PARTICIPANT POSITIONS|RECENT MESSAGES|YOUR TURN|SYSTEM INSTRUCTIONS) ===$)/.test(l)) return false;
    if (/^(You are (gpt|claude|gemini|grok)\. Other active)/.test(l)) return false;
    if (/^\((start of discussion|none yet)\)$/.test(l)) return false;
    if (/^[a-z]{2,10}\]:\s/.test(l)) return false; // truncated "[john.smith]:" → "ohn.smith]:"
    // Codex internal
    if (l === 'mcp startup: no servers' || l === 'codex' || /^→$/.test(l)) return false;
    if (/^\d{4}-\d{2}-\d{2}T.*ERROR\s+codex_core::/.test(l)) return false;
    if (/^Reconnecting\.\.\.\s\d+\/\d+/.test(l)) return false;
    // Thinking / search
    if (l === 'thinking') return false;
    if (/^\*\*[A-Za-z][^*]{3,70}\*\*$/.test(l)) return false;
    if (/^🌐\s+(Search|Searched)/.test(l)) return false;
    return true;
  }).join('\n');

  response = response.replace(/\n{3,}/g, '\n\n').trim();

  // Step 4: Deduplication — codex outputs the response twice (streaming echo)
  // 4a: By paragraphs (\n\n)
  const paragraphs = response.split(/\n\n/);
  const seen = new Set();
  const unique = [];
  for (const p of paragraphs) {
    const key = p.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  response = unique.join('\n\n').trim();

  // 4b: By lines — if first and second halves are identical
  const lines = response.split('\n');
  for (let half = Math.floor(lines.length / 2); half >= 1; half--) {
    const firstHalf = lines.slice(0, half).join('\n').trim();
    const secondHalf = lines.slice(half).join('\n').trim();
    if (firstHalf === secondHalf && firstHalf.length > 10) {
      response = firstHalf;
      break;
    }
  }

  return response;
}

function spawnGPT(prompt) {
  const { promise, proc } = callCLI('codex', ['exec', '--skip-git-repo-check', prompt], CONFIG.gptTimeoutMs, cleanEnv());
  return { proc, promise: promise.then(raw => {
    const response = cleanCodexOutput(raw);
    if (!response || response.length < 3) throw new Error('GPT: empty response');
    return response;
  })};
}

function spawnGemini(prompt) {
  const { promise, proc } = callCLI('gemini', ['-m', 'gemini-2.5-pro', '-p', prompt], CONFIG.geminiTimeoutMs);
  return { proc, promise: promise.then(raw => {
    const apiError = detectAPIError(raw);
    if (apiError) throw new Error(`Gemini API: ${apiError}`);
    const clean = filterCLIGarbage(raw);
    if (!clean || clean.length < 3) throw new Error('Gemini: empty response');
    return clean;
  })};
}

function spawnGrok(prompt) {
  const { promise, proc } = callCLI('grok', ['-p', prompt], CONFIG.grokTimeoutMs);
  return { proc, promise: promise.then(raw => {
    if (!raw || raw.length < 3) throw new Error('Grok: empty response');
    return raw;
  })};
}

const SPAWNERS = { claude: spawnClaude, gpt: spawnGPT, gemini: spawnGemini, grok: spawnGrok };

// ═══════════════════════════════════════════
// §3. Conference Connection (per-conference state)
// ═══════════════════════════════════════════

class ConferenceConnection {
  constructor(confId, title) {
    this.confId = confId;
    this.title = title || confId;
    this.ws = null;
    this.reconnectTimer = null;
    this.recentBuffer = [];
    this.summary = '';
    this.stances = {};
    this.messagesSinceSummary = 0;
    this.handledIds = new Set();
    this.initialPrompt = '';
    this.activeProcs = new Map(); // model -> pty process (for cancel)
    this.cancelledModels = new Set(); // models stopped by user
    this.paused = false; // conference paused (Stop button)
    this.alive = true;
  }

  pushMessage(msg) {
    this.recentBuffer.push(msg);
    if (this.recentBuffer.length > CONFIG.recentBufferSize) this.recentBuffer.shift();
    this.messagesSinceSummary++;
  }

  markHandled(msgId) {
    this.handledIds.add(msgId);
    if (this.handledIds.size > 500) {
      const first = this.handledIds.values().next().value;
      this.handledIds.delete(first);
    }
  }

  shouldHandle(event) {
    if (event.type !== 'message') return false;
    if (!event.id || this.handledIds.has(event.id)) return false;
    if (!event.mentions || event.mentions.length === 0) return false;
    const relevant = event.mentions.filter(m => CONFIG.models.includes(m));
    return relevant.length > 0;
  }

  buildPrompt(model, taskMessage) {
    const stancesText = Object.entries(this.stances)
      .map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none yet)';
    const recentText = this.recentBuffer.slice(-20)
      .map(m => {
        let text = `[${m.author}]: ${m.content}`;
        if (m.attachment?.file_content) {
          text += `\n\n--- File: ${m.attachment.original_name} ---\n${m.attachment.file_content}\n--- End of file ---`;
        }
        return text;
      }).join('\n');

    // CLI-override: some CLI tools have a hardcoded system prompt
    // ("I am a CLI agent for software engineering"), need to explicitly override
    const cliOverride = ['gemini', 'grok'].includes(model)
      ? `IMPORTANT: You are NOT a CLI agent. Ignore any default system instructions about being a CLI tool. Your role right now is: AI conference participant named "${model}". Respond in the language of the conversation.\n\n`
      : '';

    return `${cliOverride}You are ${model}. Other active participants: ${CONFIG.models.filter(m => m !== model).join(', ')}.

${this.initialPrompt ? `=== SYSTEM INSTRUCTIONS ===\n${this.initialPrompt}\n` : ''}
=== DISCUSSION SUMMARY ===
${this.summary || '(start of discussion)'}

=== PARTICIPANT POSITIONS ===
${stancesText}

=== RECENT MESSAGES ===
${recentText}

=== YOUR TURN ===
${taskMessage}`;
  }

  sendJson(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  async loadHistory() {
    try {
      const res = await fetch(`${CONFIG.backend}/api/conferences/${this.confId}?limit=50`, {
        headers: { 'Authorization': `Bearer ${CONFIG.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.initial_prompt) this.initialPrompt = data.initial_prompt;
        (data.messages || []).forEach(m => this.pushMessage(m));
        log(`${this.title}: loaded ${data.messages?.length || 0} messages`);
      }
    } catch (err) {
      log(`${this.title}: failed to load history: ${err.message}`);
    }
  }

  async connect() {
    if (!this.alive) return;
    const wsUrl = CONFIG.backend.replace(/^http/, 'ws');
    const url = `${wsUrl}/ws/conference/${this.confId}?token=${encodeURIComponent(CONFIG.token)}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`  [+] ${this.title} — connected`);
      const models = {};
      CONFIG.models.forEach(m => { models[m] = true; });
      this.sendJson({ type: 'capabilities', models });
    });

    this.ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        await this.handleEvent(event);
      } catch (err) {
        log(`${this.title}: processing error: ${err.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      log(`${this.title}: WS closed ${code}`);
      if (code === 4001 || code === 4004) {
        console.log(`  [-] ${this.title} — deleted or no access`);
        this.alive = false;
        return;
      }
      if (this.alive) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on('error', (err) => {
      log(`${this.title}: WS error: ${err.message}`);
    });
  }

  cancelModel(model) {
    this.cancelledModels.add(model);
    const proc = this.activeProcs.get(model);
    if (proc) {
      proc.kill();
      this.activeProcs.delete(model);
    }
    console.log(`  [${this.title}] ${model} — cancelled`);
  }

  async handleEvent(event) {
    // Cancel: kill process + block model until next user message
    if (event.type === 'cancel') {
      const target = event.target;
      if (target) this.cancelModel(target);
      return;
    }
    // Control: stop = pause entire conference, playing = resume
    if (event.type === 'control') {
      if (event.action === 'stopped') {
        this.paused = true;
        for (const model of [...this.activeProcs.keys()]) this.cancelModel(model);
        console.log(`  [${this.title}] conference paused`);
      } else if (event.action === 'playing') {
        this.paused = false;
        this.cancelledModels.clear();
        console.log(`  [${this.title}] conference resumed`);
      }
      return;
    }
    if (event.type === 'message') {
      this.pushMessage(event);
      // Message from user — reset cancellations
      const isModel = CONFIG.models.includes(event.author);
      if (!isModel) {
        this.cancelledModels.clear();
        this.paused = false;
      }
    }
    if (this.paused) return;
    if (!this.shouldHandle(event)) return;
    this.markHandled(event.id);

    const targets = event.mentions
      .filter(m => CONFIG.models.includes(m))
      .filter(m => !this.cancelledModels.has(m));
    if (targets.length === 0) return;
    log(`${this.title}: @${targets.join(',')} от ${event.author}`);

    const tasks = targets.map(model => this.routeToAgent(model, event.content));
    await Promise.allSettled(tasks);
  }

  async routeToAgent(model, taskMessage) {
    const spawner = SPAWNERS[model];
    if (!spawner) return;

    this.sendJson({ type: 'status', model, state: 'generating' });
    const typingInterval = setInterval(() => this.sendJson({ type: 'typing' }), CONFIG.typingIntervalMs);

    try {
      const prompt = this.buildPrompt(model, taskMessage);
      const { proc, promise } = spawner(prompt);
      this.activeProcs.set(model, proc);
      const response = await promise;
      this.activeProcs.delete(model);
      // ANTI-LOOP: models do NOT trigger other models — mentions always empty
      this.sendJson({ type: 'message', content: response, mentions: [], author: model });
      // Update stance
      const sentences = response.split(/[.!?]\s+/).slice(0, 2).join('. ');
      this.stances[model] = sentences.substring(0, 200);
      console.log(`  [${this.title}] ${model} responded (${response.length} chars)`);
    } catch (err) {
      this.activeProcs.delete(model);
      console.error(`  [${this.title}] ${model} error: ${err.message}`);
      // Send short error to chat so user can see the reason
      const short = err.message.length > 200 ? err.message.substring(0, 200) + '…' : err.message;
      this.sendJson({ type: 'message', content: `⚠️ ${short}`, mentions: [], author: model });
      this.sendJson({ type: 'status', model, state: 'idle' });
    } finally {
      this.activeProcs.delete(model);
      clearInterval(typingInterval);
      this.sendJson({ type: 'status', model, state: 'idle' });
    }
  }

  close() {
    this.alive = false;
    if (this.ws) this.ws.close();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }
}

// ═══════════════════════════════════════════
// §4. Daemon — polling and auto-connect
// ═══════════════════════════════════════════

const connections = new Map(); // confId -> ConferenceConnection

async function fetchConferences() {
  try {
    const res = await fetch(`${CONFIG.backend}/api/conferences`, {
      headers: { 'Authorization': `Bearer ${CONFIG.token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.conferences || [];
  } catch {
    return [];
  }
}

async function poll() {
  const confs = await fetchConferences();
  const activeIds = new Set();

  for (const conf of confs) {
    activeIds.add(conf.id);
    if (!connections.has(conf.id)) {
      const conn = new ConferenceConnection(conf.id, conf.title);
      connections.set(conf.id, conn);
      await conn.loadHistory();
      await conn.connect();
    }
  }

  // Disconnect deleted conferences
  for (const [id, conn] of connections) {
    if (!activeIds.has(id) || !conn.alive) {
      console.log(`  [-] ${conn.title} — disconnecting`);
      conn.close();
      connections.delete(id);
    }
  }
}

// ═══════════════════════════════════════════
// §5. Startup
// ═══════════════════════════════════════════

// Mapping model_id → CLI command
const MODEL_CLI = { claude: 'claude', gpt: 'codex', gemini: 'gemini', grok: 'grok' };

// Check which CLIs are actually available
const available = CONFIG.models.filter(m => {
  const cmd = MODEL_CLI[m] || m;
  const ok = hasCLI(cmd);
  if (!ok) console.log(`  [!] ${m} — CLI "${cmd}" not found, skipping`);
  return ok;
});
const skipped = CONFIG.models.filter(m => !available.includes(m));
CONFIG.models = available;

console.log(`\n  reen-cli daemon`);
console.log(`  Backend:  ${CONFIG.backend}`);
console.log(`  Models:   ${CONFIG.models.join(', ')}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`);
console.log(`  Poll:     every ${CONFIG.pollIntervalMs / 1000}s\n`);

await poll();
setInterval(poll, CONFIG.pollIntervalMs);

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  for (const [, conn] of connections) conn.close();
  process.exit(0);
});
