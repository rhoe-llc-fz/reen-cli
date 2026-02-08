#!/usr/bin/env node
/**
 * reen-cli — CLI for REEN AI Conferences
 *
 * Connects local AI models (Claude, Codex, Gemini) to conferences on reen.tech.
 * Models are invoked via CLI subscriptions on the user's machine.
 */

import { WSClient } from './lib/ws-client.mjs';
import { ModelRunner } from './lib/model-runner.mjs';

const HELP = `
reen-cli — connect local AI models to REEN conferences

Usage:
  reen-cli connect <conference_id_or_url> --token <token> [--models claude,codex,gemini]
  reen-cli list --token <token> [--server <url>]
  reen-cli create --title "Title" --token <token> [--server <url>]

Commands:
  connect   Connect to a conference and route @mentions to local AI models
  list      List your conferences
  create    Create a new conference

Options:
  --token, -t     REEN API token (reen_XXX)
  --models, -m    Comma-separated models to enable (default: claude,codex,gemini)
  --server, -s    REEN server URL (default: https://backend.reen.tech)
  --context, -c   Number of context messages for AI (default: 20)
  --help, -h      Show this help

Examples:
  reen-cli connect conf_abc123 -t reen_XXX
  reen-cli connect wss://backend.reen.tech/ws/conference/conf_abc123 -t reen_XXX
  reen-cli list -t reen_XXX
  reen-cli create --title "Architecture Review" -t reen_XXX
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
    console.log(`Connect: reen-cli connect ${data.conference.id} -t ${token}`);
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

  // Resolve confId and wsUrl
  let confId, wsUrl;
  if (target.startsWith('ws://') || target.startsWith('wss://')) {
    wsUrl = target;
    confId = target.split('/').pop().split('?')[0];
  } else {
    confId = target;
    const wsServer = server.replace(/^http/, 'ws');
    wsUrl = `${wsServer}/ws/conference/${confId}?token=${encodeURIComponent(token)}`;
  }

  if (!wsUrl.includes('token=')) {
    wsUrl += (wsUrl.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
  }

  const enabledModels = modelsStr.split(',').map(m => m.trim().toLowerCase());
  const runner = new ModelRunner({ contextSize });

  console.log(`\n  Connecting to conference: ${confId}`);
  console.log(`  Models: ${enabledModels.join(', ')}`);
  console.log(`  Context: last ${contextSize} messages\n`);

  // Load history for context
  let history = [];
  try {
    const data = await apiCall('GET', `/api/conferences/${confId}?limit=${contextSize}`);
    history = data.messages || [];
    console.log(`  Loaded ${history.length} messages from history\n`);
  } catch (e) {
    console.log('  Could not load history, starting fresh\n');
  }

  const ws = new WSClient(wsUrl, {
    onOpen: () => {
      console.log('  Connected!\n');
      ws.send({
        type: 'capabilities',
        models: Object.fromEntries(enabledModels.map(m => [m, true]))
      });
    },

    onMessage: async (msg) => {
      if (msg.type === 'message') {
        history.push(msg);
        if (history.length > contextSize) history = history.slice(-contextSize);

        console.log(`  [${msg.author}] ${msg.content?.slice(0, 120)}`);

        // Check @mentions and route to models
        const mentions = msg.mentions || [];
        for (const model of enabledModels) {
          if (mentions.includes(model) || mentions.includes('all')) {
            console.log(`  -> Routing to ${model}...`);

            ws.send({ type: 'status', model, state: 'generating' });

            try {
              const response = await runner.run(model, history);
              ws.send({ type: 'message', content: response, mentions: [] });
              console.log(`  <- [${model}] ${response.slice(0, 120)}${response.length > 120 ? '...' : ''}`);
            } catch (err) {
              console.error(`  x [${model}] Error: ${err.message}`);
              ws.send({ type: 'message', content: `[${model} error] ${err.message}`, mentions: [] });
            }

            ws.send({ type: 'status', model, state: 'idle' });
          }
        }
      } else if (msg.type === 'system') {
        console.log(`  * ${msg.content}`);
      } else if (msg.type === 'cancel') {
        console.log(`  x Cancel requested for ${msg.target}`);
        runner.cancel(msg.target);
      }
    },

    onClose: (code, reason) => {
      console.log(`\n  Disconnected (${code}: ${reason})`);
      if (code !== 4001 && code !== 4004) {
        console.log('  Reconnecting in 3s...');
      }
    },

    onError: (err) => {
      console.error('  WS Error:', err.message);
    }
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    ws.close();
    runner.cancelAll();
    process.exit(0);
  });
}

// --- Main ---

switch (command) {
  case 'connect': await cmdConnect(); break;
  case 'list': await cmdList(); break;
  case 'create': await cmdCreate(); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
