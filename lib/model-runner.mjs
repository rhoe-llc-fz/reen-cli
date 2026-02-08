/**
 * Model runner — spawns local CLI processes for AI models
 *
 * Supported models:
 *   claude  -> claude -p "prompt"
 *   codex   -> codex exec "prompt"
 *   gemini  -> gemini -p "prompt"
 *
 * All models use the user's local CLI subscriptions.
 * No API keys are transmitted over the network.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

// CLI commands per model
const MODEL_COMMANDS = {
  claude: { cmd: 'claude', args: (prompt) => ['-p', prompt] },
  codex:  { cmd: 'codex',  args: (prompt) => ['exec', '--skip-git-repo-check', prompt] },
  gemini: { cmd: 'gemini', args: (prompt) => ['-p', prompt] }
};

export class ModelRunner {
  constructor(options = {}) {
    this.contextSize = options.contextSize || 20;
    this.activeProcesses = new Map(); // model -> ChildProcess
    this.cancelledModels = new Set(); // модели, отменённые пользователем
  }

  /**
   * Build a prompt from conversation history
   */
  buildPrompt(model, history) {
    const sys = `You are ${model} in a multi-AI conference chat. Other participants: claude, codex, gemini, and human users. Respond naturally and concisely to the conversation. Do NOT talk about code, CLI tools, or the conference system itself — just answer the question asked. Reply in the same language as the user.`;
    const msgs = history.slice(-this.contextSize);
    const lines = msgs.map(m => {
      const author = m.author || m.role || 'user';
      return `[${author}]: ${m.content}`;
    });
    return sys + '\n\n' + lines.join('\n') + `\n\n[${model}]:`;
  }

  /**
   * Run a model with conversation context
   * Returns the model's response as a string
   */
  async run(model, history) {
    const config = MODEL_COMMANDS[model];
    if (!config) {
      throw new Error(`Unknown model: ${model}. Supported: ${Object.keys(MODEL_COMMANDS).join(', ')}`);
    }

    const prompt = this.buildPrompt(model, history);
    const cliArgs = config.args(prompt);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const sandboxDir = '/tmp/reen-sandbox';
      try { mkdirSync(sandboxDir, { recursive: true }); } catch {}
      const proc = spawn(config.cmd, cliArgs, {
        cwd: sandboxDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000 // 2 min timeout
      });

      this.activeProcesses.set(model, proc);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code, signal) => {
        this.activeProcesses.delete(model);
        const wasCancelled = this.cancelledModels.delete(model);
        if (wasCancelled) {
          reject(new Error('__CANCELLED__'));
        } else if (code === 0) {
          resolve(stdout.trim());
        } else if (signal) {
          reject(new Error(`${model} killed by ${signal}${stderr ? ': ' + stderr.slice(0, 200) : ''}`));
        } else {
          reject(new Error(`${model} exited with code ${code}: ${stderr.slice(0, 200)}`));
        }
      });

      proc.on('error', (err) => {
        this.activeProcesses.delete(model);
        if (err.code === 'ENOENT') {
          reject(new Error(`'${config.cmd}' not found. Install it or check your PATH.`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Cancel a running model
   */
  cancel(model) {
    const proc = this.activeProcesses.get(model);
    if (proc) {
      this.cancelledModels.add(model);
      proc.kill('SIGTERM');
    }
  }

  /**
   * Cancel all running models
   */
  cancelAll() {
    for (const [model, proc] of this.activeProcesses) {
      proc.kill('SIGTERM');
    }
    this.activeProcesses.clear();
  }
}
