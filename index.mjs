#!/usr/bin/env node
/**
 * reen-cli — CLI клиент для REEN AI Conference
 *
 * Подключается к backend.reen.tech по WebSocket, слушает @mentions,
 * роутит к локальным AI CLI (claude/codex/gemini/grok).
 *
 * BYOK: API ключи и CLI подписки остаются на вашей машине.
 *
 * Команды:
 *   reen-cli daemon  --token reen_XXX                  # Все конференции (рекомендуется)
 *   reen-cli connect <conf_id> --token reen_XXX        # Одна конференция
 *   reen-cli list    --token reen_XXX                  # Список конференций
 *   reen-cli create  --title "Title" --token reen_XXX  # Создать конференцию
 *
 * Env vars:
 *   REEN_TOKEN / JWT    — токен авторизации
 *   REEN_BACKEND        — URL бэкенда (default: https://backend.reen.tech)
 *   MODELS              — модели через запятую (default: claude,codex,gemini,grok)
 *
 * Подробнее: https://reen.tech
 *
 * (c) Rhoe, LLC-FZ
 */

import WebSocket from 'ws';
import pty from 'node-pty';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ═══════════════════════════════════════════
// §1. Конфигурация
// ═══════════════════════════════════════════

const VERSION = '1.7.0';
const LOCKFILE = join(tmpdir(), 'reen-cli-daemon.lock');
const SANDBOX_DIR = join(tmpdir(), 'reen-sandbox');

const DEFAULTS = {
  backend: 'https://backend.reen.tech',
  models: ['claude', 'codex', 'gemini', 'grok'],
  recentBufferSize: 50,
  summaryInterval: 10,
  typingIntervalMs: 5000,
  claudeTimeoutMs: 120000,
  codexTimeoutMs: 180000,
  geminiTimeoutMs: 120000,
  grokTimeoutMs: 120000,
  pollIntervalMs: 15000,
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { ...DEFAULTS };

  // Команда (первый non-flag аргумент)
  config.command = null;
  config.commandArg = null;

  // Env vars
  config.token = process.env.JWT || process.env.REEN_TOKEN || null;
  config.backend = process.env.REEN_BACKEND || process.env.SERVER || config.backend;
  if (process.env.MODELS) config.models = process.env.MODELS.split(',').map(m => m.trim());

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--token': case '-t': config.token = args[++i]; break;
      case '--backend': case '--server': case '-s': config.backend = args[++i]; break;
      case '--models': case '-m': config.models = args[++i].split(',').map(m => m.trim()); break;
      case '--poll': case '-p': config.pollIntervalMs = parseInt(args[++i]) * 1000; break;
      case '--context': case '-c': config.recentBufferSize = parseInt(args[++i]); break;
      case '--verbose': case '-v': config.verbose = true; break;
      case '--version': console.log(`reen-cli v${VERSION}`); process.exit(0);
      case '--help': case '-h': printHelp(); process.exit(0);
      case 'daemon': case 'connect': case 'list': case 'create':
        config.command = args[i];
        // Следующий аргумент может быть позиционным
        if (args[i + 1] && !args[i + 1].startsWith('-')) config.commandArg = args[++i];
        break;
      case '--title': config.title = args[++i]; break;
      default:
        if (!args[i].startsWith('-') && !config.command) {
          config.command = args[i];
        }
    }
  }

  // Default command = daemon
  if (!config.command) config.command = 'daemon';

  if (!config.token && config.command !== '--help') {
    console.error('Требуется токен: --token <reen_XXX> или переменная REEN_TOKEN');
    process.exit(1);
  }

  return config;
}

function printHelp() {
  console.log(`
  reen-cli v${VERSION} — CLI для REEN AI Conference

  Использование:
    reen-cli daemon  [options]              Подключиться ко ВСЕМ конференциям (рекомендуется)
    reen-cli connect <conf_id> [options]    Подключиться к одной конференции
    reen-cli list    [options]              Список конференций
    reen-cli create  --title "Title" [opts] Создать конференцию

  Опции:
    --token, -t <token>     REEN API токен (reen_XXX или JWT) [обязательно]
    --backend, -s <url>     URL бэкенда [default: https://backend.reen.tech]
    --models, -m <list>     Модели через запятую [default: claude,codex,gemini,grok]
    --poll, -p <seconds>    Интервал опроса для daemon [default: 15]
    --context, -c <number>  Размер контекста сообщений [default: 50]
    --verbose, -v           Подробный вывод
    --version               Версия
    --help, -h              Справка

  Переменные окружения:
    REEN_TOKEN / JWT        Токен авторизации
    REEN_BACKEND / SERVER   URL бэкенда
    MODELS                  Модели через запятую

  Примеры:
    reen-cli daemon --token reen_abc123
    reen-cli daemon --token reen_abc123 --backend http://localhost:5012 --models claude,codex
    REEN_TOKEN=reen_abc123 reen-cli daemon --verbose

  Подробнее: https://reen.tech
  `);
}

const CONFIG = parseArgs();
const log = (...args) => CONFIG.verbose && console.log('[reen-cli]', ...args);

// ═══════════════════════════════════════════
// §2. CLI Executors (PTY spawn)
// ═══════════════════════════════════════════

// Создаём sandbox директорию (Gemini сканирует cwd)
if (!existsSync(SANDBOX_DIR)) mkdirSync(SANDBOX_DIR, { recursive: true });

/** Чистый env без переменных Claude Code (защита от nested session) */
function cleanEnv(base = process.env) {
  const env = { ...base };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

/** Универсальный вызов CLI через PTY */
async function callCLI(command, args, timeoutMs, env = cleanEnv()) {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`${command} timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    proc.onData(data => { output += data; });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      // Очистка ANSI/PTY мусора
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
      resolve(clean);
    });
  });
}

async function callClaude(prompt) {
  const raw = await callCLI('claude', ['-p', prompt, '--output-format', 'text'], CONFIG.claudeTimeoutMs);
  if (!raw || raw.length < 3) throw new Error('Claude: пустой ответ');
  return raw;
}

async function callCodex(prompt) {
  const raw = await callCLI('codex', ['exec', '--skip-git-repo-check', prompt], CONFIG.codexTimeoutMs, { ...process.env });
  // Парсинг ответа Codex (между маркерами)
  const startMark = '\ncodex\n';
  const endMark = '\ntokens used\n';
  const si = raw.indexOf(startMark);
  const ei = raw.lastIndexOf(endMark);
  let response = raw;
  if (si !== -1 && ei !== -1) response = raw.substring(si + startMark.length, ei).trim();
  else if (si !== -1) response = raw.substring(si + startMark.length).trim();
  if (!response || response.length < 5) throw new Error('Codex: пустой ответ');
  return response;
}

async function callGemini(prompt) {
  const raw = await callCLI('gemini', ['-p', prompt], CONFIG.geminiTimeoutMs);
  if (!raw || raw.length < 3) throw new Error('Gemini: пустой ответ');
  return raw;
}

async function callGrok(prompt) {
  const raw = await callCLI('grok', ['-p', prompt], CONFIG.grokTimeoutMs);
  if (!raw || raw.length < 3) throw new Error('Grok: пустой ответ');
  return raw;
}

const EXECUTORS = { claude: callClaude, codex: callCodex, gemini: callGemini, grok: callGrok };

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
    this.cancelledModels = new Set();
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
    // Модели не отвечают на сообщения других моделей (anti-loop)
    const knownModels = new Set(['claude', 'codex', 'gemini', 'grok', 'claude-code']);
    if (knownModels.has(event.author)) return false;
    const relevant = event.mentions.filter(m => CONFIG.models.includes(m));
    return relevant.length > 0;
  }

  buildPrompt(model, taskMessage) {
    const stancesText = Object.entries(this.stances)
      .map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (пока нет)';
    const recentText = this.recentBuffer.slice(-20)
      .map(m => {
        let text = `[${m.author}]: ${m.content}`;
        if (m.attachment?.file_content) {
          text += `\n\n--- Файл: ${m.attachment.original_name} ---\n${m.attachment.file_content}\n--- Конец файла ---`;
        }
        return text;
      }).join('\n');

    return `You are ${model}, a participant in a multi-model AI conference. Other participants: ${CONFIG.models.filter(m => m !== model).join(', ')}.
Use @name to ask a question or request input from another participant. Without @ — just a reference, no response triggered.

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
      const res = await fetch(`${CONFIG.backend}/api/conferences/${this.confId}?limit=${CONFIG.recentBufferSize}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.token}` }
      });
      if (res.ok) {
        const data = await res.json();
        (data.messages || []).forEach(m => this.pushMessage(m));
        log(`${this.title}: загружено ${data.messages?.length || 0} сообщений`);
      }
    } catch (err) {
      log(`${this.title}: не удалось загрузить историю: ${err.message}`);
    }
  }

  async connect() {
    if (!this.alive) return;
    const wsUrl = CONFIG.backend.replace(/^http/, 'ws');
    const url = `${wsUrl}/ws/conference/${this.confId}?token=${encodeURIComponent(CONFIG.token)}`;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log(`  [+] ${this.title} — подключено`);
      const models = {};
      CONFIG.models.forEach(m => { models[m] = true; });
      this.sendJson({ type: 'capabilities', models });
    });

    this.ws.on('message', async (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        await this.handleEvent(event);
      } catch (err) {
        log(`${this.title}: ошибка обработки: ${err.message}`);
      }
    });

    this.ws.on('close', (code) => {
      log(`${this.title}: WS закрыт ${code}`);
      if (code === 4001 || code === 4004) {
        console.log(`  [-] ${this.title} — удалена или нет доступа`);
        this.alive = false;
        return;
      }
      if (this.alive) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on('error', (err) => {
      log(`${this.title}: WS ошибка: ${err.message}`);
    });
  }

  async handleEvent(event) {
    // Обработка cancel
    if (event.type === 'cancel' && event.target) {
      this.cancelledModels.add(event.target);
      return;
    }
    // Обработка control (stop/go)
    if (event.type === 'control' && event.action === 'stopped') {
      CONFIG.models.forEach(m => this.cancelledModels.add(m));
      return;
    }
    if (event.type === 'control' && (event.action === 'playing' || event.action === 'resumed')) {
      this.cancelledModels.clear();
    }

    if (event.type === 'message') this.pushMessage(event);
    if (!this.shouldHandle(event)) return;
    this.markHandled(event.id);

    const targets = event.mentions.includes('all')
      ? CONFIG.models
      : event.mentions.filter(m => CONFIG.models.includes(m));
    log(`${this.title}: @${targets.join(',')} от ${event.author}`);

    // Последовательный запуск (модели видят ответы предыдущих)
    for (const model of targets) {
      if (this.cancelledModels.has(model)) {
        log(`${this.title}: ${model} отменён`);
        continue;
      }
      await this.routeToAgent(model, event.content);
    }
  }

  async routeToAgent(model, taskMessage) {
    const executor = EXECUTORS[model];
    if (!executor) return;

    this.sendJson({ type: 'status', model, state: 'generating' });
    const typingInterval = setInterval(() => this.sendJson({ type: 'typing' }), CONFIG.typingIntervalMs);

    try {
      const prompt = this.buildPrompt(model, taskMessage);
      const response = await executor(prompt);

      // Проверяем отмену
      if (this.cancelledModels.has(model)) {
        log(`${this.title}: ${model} — ответ отброшен (отменён)`);
        return;
      }

      // Парсим @mentions из ответа для цепочки
      const mentionRe = /@(claude|codex|gemini|grok|all)\b/gi;
      const responseMentions = [...new Set(
        [...response.matchAll(mentionRe)].map(m => m[1].toLowerCase())
      )];

      this.sendJson({ type: 'message', content: response, mentions: responseMentions, author: model });

      // Обновить stance
      const sentences = response.split(/[.!?]\s+/).slice(0, 2).join('. ');
      this.stances[model] = sentences.substring(0, 200);

      console.log(`  [${this.title}] ${model} ответил (${response.length} символов)`);
    } catch (err) {
      if (this.cancelledModels.has(model)) return; // Тихо игнорируем при отмене
      console.error(`  [${this.title}] ${model} ошибка: ${err.message}`);
      this.sendJson({ type: 'message', content: `[${model} error] ${err.message}`, mentions: [], author: model });
      this.sendJson({ type: 'status', model, state: 'error' });
    } finally {
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
// §4. Daemon — автоподключение ко всем конференциям
// ═══════════════════════════════════════════

const connections = new Map();

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

  // Отключаем удалённые конференции
  for (const [id, conn] of connections) {
    if (!activeIds.has(id) || !conn.alive) {
      console.log(`  [-] ${conn.title} — отключаю`);
      conn.close();
      connections.delete(id);
    }
  }
}

// ═══════════════════════════════════════════
// §5. Команды: list, create, connect
// ═══════════════════════════════════════════

async function cmdList() {
  const confs = await fetchConferences();
  if (confs.length === 0) {
    console.log('Конференций нет');
    return;
  }
  console.log(`\n  Конференции (${confs.length}):\n`);
  for (const c of confs) {
    const date = c.created_at ? new Date(c.created_at).toLocaleDateString() : '';
    console.log(`  ${c.id}  ${c.title || '(без названия)'}  ${date}`);
  }
  console.log('');
}

async function cmdCreate() {
  const title = CONFIG.title || CONFIG.commandArg || 'New Conference';
  try {
    const res = await fetch(`${CONFIG.backend}/api/conferences`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    });
    if (res.ok) {
      const data = await res.json();
      console.log(`Создана: ${data.id} — ${title}`);
    } else {
      console.error(`Ошибка: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
  }
}

async function cmdConnect() {
  const confId = CONFIG.commandArg;
  if (!confId) {
    console.error('Укажите ID конференции: reen-cli connect <conf_id> --token ...');
    process.exit(1);
  }

  console.log(`\n  reen-cli v${VERSION}`);
  console.log(`  Конференция: ${confId}`);
  console.log(`  Backend:     ${CONFIG.backend}`);
  console.log(`  Models:      ${CONFIG.models.join(', ')}\n`);

  const conn = new ConferenceConnection(confId, confId);
  await conn.loadHistory();
  await conn.connect();

  process.on('SIGINT', () => {
    console.log('\n  Завершение...');
    conn.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => { conn.close(); process.exit(0); });
}

async function cmdDaemon() {
  // Lockfile проверка
  if (existsSync(LOCKFILE)) {
    try {
      const pid = parseInt(readFileSync(LOCKFILE, 'utf8').trim());
      try { process.kill(pid, 0); console.error(`Daemon уже запущен (PID ${pid}). Для перезапуска: rm ${LOCKFILE}`); process.exit(1); }
      catch { unlinkSync(LOCKFILE); } // Процесс не существует — stale lockfile
    } catch { /* ignore */ }
  }
  writeFileSync(LOCKFILE, String(process.pid));

  console.log(`\n  reen-cli daemon v${VERSION}`);
  console.log(`  Backend:  ${CONFIG.backend}`);
  console.log(`  Models:   ${CONFIG.models.join(', ')}`);
  console.log(`  Poll:     every ${CONFIG.pollIntervalMs / 1000}s\n`);

  await poll();
  setInterval(poll, CONFIG.pollIntervalMs);

  const cleanup = () => {
    console.log('\n  Завершение...');
    for (const [, conn] of connections) conn.close();
    try { unlinkSync(LOCKFILE); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ═══════════════════════════════════════════
// §6. Запуск
// ═══════════════════════════════════════════

switch (CONFIG.command) {
  case 'daemon': await cmdDaemon(); break;
  case 'connect': await cmdConnect(); break;
  case 'list': await cmdList(); break;
  case 'create': await cmdCreate(); break;
  default:
    console.error(`Неизвестная команда: ${CONFIG.command}`);
    printHelp();
    process.exit(1);
}
