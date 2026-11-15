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
import { SCAN_SCHEMA, sanitizeScan, scanSystem } from './scan.mjs';
import { RECAP_ASK, RECAP_SCHEMA, SCHEMA, SYSTEM, normalizeReply, sanitizeReply } from './brain.mjs';

const MODEL = process.env.MENTOR_CLAUDE_CODE_MODEL || 'sonnet';
const BIN = process.env.MENTOR_CLAUDE_BIN || 'claude';

function start(schema, system, dir, effort = 'low') {
  const args = ['-p', '--model', MODEL, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence', '--effort', effort, '--system-prompt', system];
  // Allowlist: the CLI gets only what it needs to run and find its own login; none of Mentor's keys or phone numbers.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(PATH|HOME|USER|LANG|LC_\w+|TERM|TMPDIR|XDG_\w+|CLAUDE\w*)$/.test(k)) env[k] = v;
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
        const timer = setTimeout(() => { child.kill(); reject(new Error('claude-code timed out')); }, timeoutMs);   // a fresh process on the next turn
        waiting.push(d => { clearTimeout(timer); d.is_error ? reject(new Error(String(d.result || 'claude-code error'))) : resolve(d); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    },
  };
}

export class ClaudeCodeBrain {
  provider = 'claude-code';

  constructor({ task = '' } = {}) {
    if (process.env.MENTOR_OWNER_TESTING !== '1') {
      throw new Error('MENTOR_BRAIN=claude-code runs on your personal Claude subscription and is for your own testing only. '
        + 'Set MENTOR_OWNER_TESTING=1 to confirm only you will call; anyone else\'s calls must use MENTOR_BRAIN=gemini or claude.');
    }
    console.warn('[brain:claude-code] OWNER TESTING ONLY: running on your personal Claude subscription. Never use this for judges or users.');
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
    normalizeReply(out, image?.width || 1, image?.height || 1, Boolean(image));
    sanitizeReply(out);
    out.ms = ms; out.model = `claude-code ${MODEL}`;
    this.messages.push({ heard, say: out.say });
    console.log(`[brain:claude-code] ${MODEL} ${ms}ms`);
    return out;
  }

  /** Same contract as ClaudeBrain.scan: a one-shot locked-down process with the scan schema. */
  async scan(image) {
    this.dir ??= await mkdtemp(join(tmpdir(), 'mentor-cc-'));
    const p = start(SCAN_SCHEMA, scanSystem('a pixel coordinate in the attached image (x right, y down), whose size is given in the message'), this.dir, process.env.MENTOR_SCAN_EFFORT || 'medium');
    const t0 = Date.now();
    try {
      const d = await p.ask([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.jpeg.toString('base64') } },
        { type: 'text', text: `[camera frame ${image.width}x${image.height}px] Scan the main object.` }], 150_000);
      const raw = d.structured_output || JSON.parse(d.result);
      const ms = Date.now() - t0;
      console.log(`[brain:claude-code] scan ${MODEL} ${ms}ms`);
      return { ...sanitizeScan(raw, image.width, image.height), ms, model: `claude-code ${MODEL}` };
    } finally { p.child.kill(); }
  }

  /** "Researched interiors" (research.mjs): a separate locked-down process; with web it may use only WebSearch + WebFetch. */
  async research(scan, opts = {}) {
    const { claudeResearch } = await import('./research.mjs');
    return claudeResearch({ bin: BIN, model: process.env.MENTOR_RESEARCH_MODEL || MODEL, scan, ...opts });
  }

  /**
   * Generic one-shot structured request in its own locked-down process (e.g. the circuit planner, circuit.mjs).
   * @param {string} prompt @param {object} schema JSON schema of the answer
   * @param {{jpeg: Buffer, width: number, height: number} | null} [image] @param {{system?: string, timeout?: number}} [opts]
   * @returns {Promise<{data: any, ms: number, model: string}>}
   */
  async structured(prompt, schema, image = null, { system = 'Return only the JSON the schema asks for.', timeout = 60_000 } = {}) {
    this.dir ??= await mkdtemp(join(tmpdir(), 'mentor-cc-'));
    const p = start(schema, system, this.dir);
    const t0 = Date.now();
    try {
      const content = [];
      if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.jpeg.toString('base64') } },
        { type: 'text', text: `[camera frame ${image.width}x${image.height}px]` });
      content.push({ type: 'text', text: String(prompt) });
      const d = await p.ask(content, timeout);
      const data = d.structured_output || JSON.parse(d.result);
      const ms = Date.now() - t0;
      console.log(`[brain:claude-code] structured ${MODEL} ${ms}ms`);
      return { data, ms, model: `claude-code ${MODEL}` };
    } finally { p.child.kill(); }
  }

  /** Recap from the transcript, in a one-shot process with the recap schema. */
  async finish() {
    if (!this.messages.length) return null;
    this.dir ??= await mkdtemp(join(tmpdir(), 'mentor-cc-'));
    const p = start(RECAP_SCHEMA, SYSTEM, this.dir);
    try {
      const transcript = this.messages.map(m => `Caller: ${m.heard}\nOdy: ${m.say}`).join('\n');
      const d = await p.ask([{ type: 'text', text: `${this.task ? `Task: ${this.task}\n` : ''}Call transcript:\n${transcript}\n\n${RECAP_ASK}` }], 120_000);
      return d.structured_output || null;
    } finally { p.child.kill(); }
  }

  async close() {
    this.proc?.child.kill();
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
