#!/usr/bin/env node
/**
 * reen-cli — CLI for REEN AI Conferences
 *
 * Connects local AI models (Claude, Codex, Gemini) to conferences on reen.tech.
 * Models are invoked via CLI subscriptions on the user's machine.
 */

import { WSClient } from './lib/ws-client.mjs';
import { ModelRunner } from './lib/model-runner.mjs';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Lockfile для предотвращения дублирования ---
const LOCKFILE = join(tmpdir(), 'reen-cli-daemon.lock');

function acquireLock() {
  if (existsSync(LOCKFILE)) {
    try {
      const pid = parseInt(readFileSync(LOCKFILE, 'utf-8').trim(), 10);
      // Проверяем жив ли процесс
      process.kill(pid, 0); // signal 0 = проверка без убийства
      console.error(`  ERROR: Daemon already running (PID ${pid}). Kill it first or use 'connect'.`);
      process.exit(1);
    } catch {
      // Процесс мёртв — stale lockfile, перезаписываем
    }
  }
  writeFileSync(LOCKFILE, String(process.pid));
}

function releaseLock() {
  try { unlinkSync(LOCKFILE); } catch {}
}

const HELP = `
reen-cli — connect local AI models to REEN conferences

Usage:
  reen-cli connect <conference_id_or_url> --token <token> [--models claude,codex,gemini]
  reen-cli daemon --token <token> [--models claude,codex,gemini] [--poll 15]
  reen-cli list --token <token> [--server <url>]
  reen-cli create --title "Title" --token <token> [--server <url>]

Commands:
  connect   Connect to a single conference
  daemon    Connect to ALL conferences, auto-join new ones
  list      List your conferences
  create    Create a new conference

Options:
  --token, -t     REEN API token (reen_XXX or JWT)
  --models, -m    Comma-separated models to enable (default: claude,codex,gemini)
  --server, -s    REEN server URL (default: https://backend.reen.tech)
  --context, -c   Number of context messages for AI (default: 20)
  --poll, -p      Poll interval in seconds for daemon mode (default: 15)
  --help, -h      Show this help

Examples:
  reen-cli connect conf_abc123 -t reen_XXX
  reen-cli daemon -t reen_XXX -s http://localhost:5012
  reen-cli list -t reen_XXX
`;

// --- Argument parsing ---

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const command = args[0];
const restArgs = args.slice(1);

function getFlag(flags, names) {
  for (const name of names) {
    const idx = flags.indexOf(name);
    if (idx !== -1 && idx + 1 < flags.length) {
      return flags[idx + 1];
    }
  }
  return null;
}

const token = getFlag(restArgs, ['--token', '-t']);
const server = getFlag(restArgs, ['--server', '-s']) || 'https://backend.reen.tech';
const modelsStr = getFlag(restArgs, ['--models', '-m']) || 'claude,codex,gemini';
const contextSize = parseInt(getFlag(restArgs, ['--context', '-c']) || '20', 10);
const pollInterval = parseInt(getFlag(restArgs, ['--poll', '-p']) || '15', 10);

if (!token) {
  console.error('Error: --token is required');
  process.exit(1);
}

// --- API helper ---

async function apiCall(method, path, data = null) {
  const url = `${server}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  return res.json();
}

// --- Shared: connect to one conference ---

const enabledModels = modelsStr.split(',').map(m => m.trim().toLowerCase());

// Глобальное состояние конференций: paused/stopped предотвращает роутинг к моделям
const confStates = new Map(); // confId -> 'playing' | 'paused' | 'stopped'

/**
 * Подключает модели к одной конференции.
 * Возвращает { ws, runner, history } для управления.
 */
function connectToConference(confId, runner, label = '') {
  const wsServer = server.replace(/^http/, 'ws');
  const wsUrl = `${wsServer}/ws/conference/${confId}?token=${encodeURIComponent(token)}`;
  const tag = label || confId.slice(-6);

  let history = [];
  confStates.set(confId, 'playing');

  // Подгружаем историю через REST
  apiCall('GET', `/api/conferences/${confId}?limit=${contextSize}`)
    .then(data => {
      history = data.messages || [];
      console.log(`  [${tag}] Loaded ${history.length} messages`);
    })
    .catch(() => {
      console.log(`  [${tag}] Could not load history`);
    });

  const ws = new WSClient(wsUrl, {
    onOpen: () => {
      console.log(`  [${tag}] Connected`);
      ws.send({
        type: 'capabilities',
        models: Object.fromEntries(enabledModels.map(m => [m, true]))
      });
    },

    onMessage: async (msg) => {
      if (msg.type === 'message') {
        history.push(msg);
        if (history.length > contextSize) history = history.slice(-contextSize);

        console.log(`  [${tag}] [${msg.author}] ${msg.content?.slice(0, 100)}`);

        // Проверяем состояние конференции (pause/stop блокируют роутинг)
        const state = confStates.get(confId);
        if (state === 'paused' || state === 'stopped') {
          console.log(`  [${tag}] ⏸ Skipping (${state})`);
          return;
        }

        // Определяем автора сообщения
        const msgAuthor = (msg.author || '').toLowerCase();

        // Маршрутизация по @mentions
        const mentions = msg.mentions || [];
        for (const model of enabledModels) {
          // Модель не отвечает сама себе (anti-self-loop)
          if (model === msgAuthor) continue;

          if (mentions.includes(model) || mentions.includes('all')) {
            console.log(`  [${tag}] -> ${model}...`);
            ws.send({ type: 'status', model, state: 'generating' });

            try {
              const response = await runner.run(model, history);
              // Парсим @mentions из ответа модели для продолжения цепочки
              const mentionRe = /@(claude|codex|gemini|all)\b/gi;
              const responseMentions = [...new Set(
                [...response.matchAll(mentionRe)].map(m => m[1].toLowerCase())
              )];
              ws.send({ type: 'message', content: response, mentions: responseMentions, author: model });
              console.log(`  [${tag}] <- [${model}] ${response.slice(0, 100)}${response.length > 100 ? '...' : ''}`);
            } catch (err) {
              if (err.message !== '__CANCELLED__') {
                console.error(`  [${tag}] x [${model}] ${err.message}`);
                ws.send({ type: 'message', content: `[${model} error] ${err.message}`, mentions: [], author: model });
              }
            }

            ws.send({ type: 'status', model, state: 'idle' });
          }
        }
      } else if (msg.type === 'system') {
        console.log(`  [${tag}] * ${msg.content}`);
      } else if (msg.type === 'cancel') {
        console.log(`  [${tag}] x Cancel: ${msg.target}`);
        runner.cancel(msg.target);
      } else if (msg.type === 'control') {
        // Управление конференцией: play/pause/stop
        const action = msg.action;
        console.log(`  [${tag}] ⚡ Control: ${action}`);
        confStates.set(confId, action);
        if (action === 'stopped') {
          // Stop = отменить все текущие генерации
          runner.cancelAll();
        }
      }
    },

    onClose: (code, reason) => {
      if (code === 4001 || code === 4004) {
        console.log(`  [${tag}] Disconnected (${code})`);
      }
    },

    onError: (err) => {
      console.error(`  [${tag}] WS Error: ${err.message}`);
    }
  });

  return { ws, history };
}

// --- Commands ---

async function cmdList() {
  const data = await apiCall('GET', '/api/conferences');
  const confs = data.conferences || [];
  if (confs.length === 0) {
    console.log('No conferences found.');
    return;
  }
  console.log(`\nConferences (${confs.length}):\n`);
  for (const c of confs) {
    console.log(`  ${c.id}  ${c.title}  (${c.message_count || 0} msgs, ${c.created_at?.slice(0, 10)})`);
  }
  console.log('');
}

async function cmdCreate() {
  const title = getFlag(restArgs, ['--title']);
  if (!title) {
    console.error('Error: --title is required');
    process.exit(1);
  }
  const data = await apiCall('POST', '/api/conferences', { title });
  if (data.success) {
    console.log(`Conference created: ${data.conference.id}`);
    console.log(`Connect: reen-cli connect ${data.conference.id} -t <token>`);
  } else {
    console.error('Failed to create conference:', data);
  }
}

async function cmdConnect() {
  let target = restArgs[0];
  if (!target) {
    console.error('Error: conference URL or ID required');
    process.exit(1);
  }

  let confId;
  if (target.startsWith('ws://') || target.startsWith('wss://')) {
    confId = target.split('/').pop().split('?')[0];
  } else {
    confId = target;
  }

  const runner = new ModelRunner({ contextSize });

  console.log(`\n  Connecting to conference: ${confId}`);
  console.log(`  Models: ${enabledModels.join(', ')}\n`);

  const conn = connectToConference(confId, runner);

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    conn.ws.close();
    runner.cancelAll();
    process.exit(0);
  });
}

async function cmdDaemon() {
  acquireLock();
  const runner = new ModelRunner({ contextSize });
  const connections = new Map(); // confId -> { ws, history }

  console.log(`\n  DAEMON MODE`);
  console.log(`  Models: ${enabledModels.join(', ')}`);
  console.log(`  Poll: every ${pollInterval}s\n`);

  async function syncConferences() {
    try {
      const data = await apiCall('GET', '/api/conferences');
      const confs = data.conferences || [];

      for (const conf of confs) {
        if (!connections.has(conf.id)) {
          const label = conf.title?.slice(0, 20) || conf.id.slice(-6);
          console.log(`  + Joining: ${conf.id} (${label})`);
          const conn = connectToConference(conf.id, runner, label);
          connections.set(conf.id, conn);
        }
      }

      // Убираем удалённые конференции
      const activeIds = new Set(confs.map(c => c.id));
      for (const [confId, conn] of connections) {
        if (!activeIds.has(confId)) {
          console.log(`  - Leaving: ${confId}`);
          conn.ws.close();
          connections.delete(confId);
        }
      }
    } catch (err) {
      console.error(`  Poll error: ${err.message}`);
    }
  }

  // Первичное подключение
  await syncConferences();

  // Периодический опрос новых конференций
  setInterval(syncConferences, pollInterval * 1000);

  function shutdown() {
    console.log('\n  Shutting down daemon...');
    for (const [, conn] of connections) {
      conn.ws.close();
    }
    runner.cancelAll();
    releaseLock();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// --- Main ---

switch (command) {
  case 'connect': await cmdConnect(); break;
  case 'daemon':  await cmdDaemon(); break;
  case 'list':    await cmdList(); break;
  case 'create':  await cmdCreate(); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
