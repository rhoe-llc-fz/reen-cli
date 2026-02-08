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

// CLI commands per model
const MODEL_COMMANDS = {
  claude: { cmd: 'claude', args: (prompt) => ['-p', prompt] },
  codex:  { cmd: 'codex',  args: (prompt) => ['exec', prompt] },
  gemini: { cmd: 'gemini', args: (prompt) => ['-p', prompt] }
};

export class ModelRunner {
  constructor(options = {}) {
    this.contextSize = options.contextSize || 20;
    this.activeProcesses = new Map(); // model -> ChildProcess
  }

  /**
   * Build a prompt from conversation history
   */
  buildPrompt(history) {
    const msgs = history.slice(-this.contextSize);
    const lines = msgs.map(m => {
      const role = m.role || (m.author === 'system' ? 'system' : 'user');
      return `[${m.author || role}]: ${m.content}`;
    });
    return lines.join('\n');
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

    const prompt = this.buildPrompt(history);
    const cliArgs = config.args(prompt);

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(config.cmd, cliArgs, {
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

      proc.on('close', (code) => {
        this.activeProcesses.delete(model);
        if (code === 0) {
          resolve(stdout.trim());
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
      proc.kill('SIGTERM');
      this.activeProcesses.delete(model);
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
