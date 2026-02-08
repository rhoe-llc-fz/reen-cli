#!/usr/bin/env node
/**
 * reen-cli daemon — автоподключение ко всем конференциям
 * Поллит API каждые 10 секунд, подключается к новым конференциям автоматически.
 */

import { WSClient } from './lib/ws-client.mjs';
import { ModelRunner } from './lib/model-runner.mjs';

const token = process.env.JWT || process.argv[2];
const server = process.env.SERVER || process.argv[3] || 'http://127.0.0.1:5012';
const modelsStr = process.env.MODELS || 'claude,codex,gemini';
const contextSize = 20;
const pollInterval = 10000; // 10 секунд

if (!token) {
  console.error('Usage: JWT=<token> node daemon.mjs [server]');
  process.exit(1);
}

const enabledModels = modelsStr.split(',').map(m => m.trim().toLowerCase());
const connectedConfs = new Map(); // confId -> WSClient

async function fetchConferences() {
  try {
    const res = await fetch(`${server}/api/conferences`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.conferences || [];
  } catch {
    return [];
  }
}

async function fetchHistory(confId) {
  try {
    const res = await fetch(`${server}/api/conferences/${confId}?limit=${contextSize}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch {
    return [];
  }
}

async function connectToConference(confId, title) {
  if (connectedConfs.has(confId)) return;

  const wsServer = server.replace(/^http/, 'ws');
  const wsUrl = `${wsServer}/ws/conference/${confId}?token=${encodeURIComponent(token)}`;
  const runner = new ModelRunner({ contextSize });
  let history = await fetchHistory(confId);

  console.log(`  [+] ${title || confId} — connecting...`);

  const ws = new WSClient(wsUrl, {
    onOpen: () => {
      console.log(`  [+] ${title || confId} — connected`);
      ws.send({
        type: 'capabilities',
        models: Object.fromEntries(enabledModels.map(m => [m, true]))
      });
    },

    onMessage: async (msg) => {
      if (msg.type === 'cancel') {
        const target = msg.target;
        if (target) {
          console.log(`  [${title}] cancel @${target} requested by ${msg.requested_by || '?'}`);
          runner.cancel(target);
        }
        return;
      }

      if (msg.type === 'message') {
        history.push(msg);
        if (history.length > contextSize) history = history.slice(-contextSize);

        const mentions = msg.mentions || [];
        for (const model of enabledModels) {
          if (mentions.includes(model) || mentions.includes('all')) {
            console.log(`  [${title}] @${model} from ${msg.author}`);
            ws.send({ type: 'status', model, state: 'generating' });
            try {
              const response = await runner.run(model, history);
              ws.send({ type: 'message', content: response, mentions: [], author: model });
              console.log(`  [${title}] ${model} responded (${response.length} chars)`);
            } catch (err) {
              if (err.message === '__CANCELLED__') {
                console.log(`  [${title}] ${model} cancelled`);
              } else {
                console.error(`  [${title}] ${model} error: ${err.message}`);
                ws.send({ type: 'message', content: `[${model} error] ${err.message}`, mentions: [], author: model });
              }
            }
            ws.send({ type: 'status', model, state: 'idle' });
          }
        }
      }
    },

    onClose: (code, reason) => {
      if (code === 4004) {
        // Конференция удалена
        console.log(`  [-] ${title || confId} — deleted, removing`);
        connectedConfs.delete(confId);
      }
    }
  });

  connectedConfs.set(confId, ws);
}

async function poll() {
  const confs = await fetchConferences();
  for (const conf of confs) {
    if (!connectedConfs.has(conf.id)) {
      await connectToConference(conf.id, conf.title);
    }
  }
  // Чистим удалённые
  const activeIds = new Set(confs.map(c => c.id));
  for (const [id, ws] of connectedConfs) {
    if (!activeIds.has(id)) {
      console.log(`  [-] ${id} — no longer in list, disconnecting`);
      ws.close();
      connectedConfs.delete(id);
    }
  }
}

console.log(`\n  reen-cli daemon`);
console.log(`  Server: ${server}`);
console.log(`  Models: ${enabledModels.join(', ')}`);
console.log(`  Poll: every ${pollInterval/1000}s\n`);

// Первый запуск
await poll();

// Поллинг
setInterval(poll, pollInterval);

process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  for (const [, ws] of connectedConfs) ws.close();
  process.exit(0);
});
