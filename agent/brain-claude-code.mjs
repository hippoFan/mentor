// Mentor's brain on the local Claude Code CLI, signed in with the owner's Claude subscription.
// TESTING ONLY, off by default (MENTOR_BRAIN=claude-code). A subscription covers its owner's own use; anything other
// people call (judges, users) must run on an API key (MENTOR_BRAIN=claude or gemini). See README "Security".
//
// Locked down: no tools (structured output only), no MCP servers, no settings/hooks/skills, no session saved to disk,
// Mentor's own system prompt, run in an empty temp folder. One warm process per call, so a turn costs no startup.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { RECAP_ASK, RECAP_SCHEMA, SCHEMA, SYSTEM } from './brain.mjs';

const MODEL = process.env.MENTOR_CLAUDE_CODE_MODEL || 'sonnet';
const BIN = process.env.MENTOR_CLAUDE_BIN || 'claude';

function start(schema, system, dir) {
  const args = ['-p', '--model', MODEL, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--disable-slash-commands', '--no-session-persistence', '--effort', 'low', '--system-prompt', system];
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/KEY|SECRET|TOKEN/.test(k) && !k.startsWith('CLAUDE')) delete env[k];   // it needs none of ours
  const child = spawn(BIN, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = [];
  createInterface({ input: child.stdout }).on('line', line => {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (d.type === 'result') waiting.shift()?.(d);
  });
  child.on('exit', () => { for (const w of waiting.splice(0)) w({ is_error: true, result: 'claude exited' }); });
  return {
    child,
    ask(content, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('claude-code timed out')), timeoutMs);
        waiting.push(d => { clearTimeout(timer); d.is_error ? reject(new Error(String(d.result || 'claude-code error'))) : resolve(d); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    },
  };
}

export class ClaudeCodeBrain {
  provider = 'claude-code';

  constructor({ task = '' } = {}) {
    this.task = task;
    this.messages = [];              // transcript only ({heard, say}), for the recap; images stay in the live process
    this.queue = Promise.resolve();
    this.proc = null; this.dir = null;
  }

  idle() { return this.queue.then(() => {}, () => {}); }
  #serial(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run; }

  async #ensure() {
    if (this.proc && this.proc.child.exitCode === null) return this.proc;
    this.dir ??= await mkdtemp(join(tmpdir(), 'mentor-cc-'));
    this.proc = start(SCHEMA, SYSTEM + (this.task ? `\n\nThe caller's task: ${this.task}` : ''), this.dir);
    return this.proc;
  }

  turn(heard, image) { return this.#serial(() => this.#turn(heard, image)); }

  async #turn(heard, image) {
    const content = [];
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.jpeg.toString('base64') } },
      { type: 'text', text: `[camera frame ${image.width}x${image.height}px]` });
    else content.push({ type: 'text', text: '[no camera frame available]' });
    content.push({ type: 'text', text: `Caller said: ${heard}` });
    const t0 = Date.now();
    const d = await (await this.#ensure()).ask(content);
    const ms = Date.now() - t0;
    const out = d.structured_output || (() => { try { return JSON.parse(d.result); } catch { return null; } })();
    if (!out) return { say: 'Sorry, say that again?', marks: [], step: '', done: false, note: '', ms };
    const w = image?.width || 1, h = image?.height || 1;
    out.marks = image ? (out.marks || []).slice(0, 5)
      .map(m => ({ ...m, x: m.x / w, y: m.y / h, x2: m.x2 >= 0 ? m.x2 / w : -1, y2: m.y2 >= 0 ? m.y2 / h : -1 }))
      .filter(m => m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1) : [];
    out.ms = ms; out.model = `claude-code ${MODEL}`;
    this.messages.push({ heard, say: out.say });
    console.log(`[brain:claude-code] ${MODEL} ${ms}ms`);
    return out;
  }

  /** Recap from the transcript, in a one-shot process with the recap schema. */
  async finish() {
    if (!this.messages.length) return null;
    this.dir ??= await mkdtemp(join(tmpdir(), 'mentor-cc-'));
    const p = start(RECAP_SCHEMA, SYSTEM, this.dir);
    try {
      const transcript = this.messages.map(m => `Caller: ${m.heard}\nMentor: ${m.say}`).join('\n');
      const d = await p.ask([{ type: 'text', text: `${this.task ? `Task: ${this.task}\n` : ''}Call transcript:\n${transcript}\n\n${RECAP_ASK}` }], 120_000);
      return d.structured_output || null;
    } finally { p.child.kill(); }
  }

  async close() {
    this.proc?.child.kill();
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
