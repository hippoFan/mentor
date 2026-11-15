// The locked-down local Claude Code CLI (`claude -p`) on the OWNER's Claude subscription. OWNER TESTING ONLY: used by
// Ody's call brain (brain-claude-code.mjs, MENTOR_BRAIN=claude-code) and Argos's 'claude-code' provider
// (argos/providers.mjs). Both refuse to run unless MENTOR_OWNER_TESTING=1. Never for judges, users or the public.
//
// Locked down: no tools (structured output only), no MCP servers, no settings/hooks/skills, no slash commands, no
// session saved to disk, our own system prompt, an allowlisted environment (none of Ody's keys), run in an empty temp
// folder, and killed on a timeout.
//
//   const p = startClaudeCode(schema, system, dir, effort?, model?)  ->  {child, ask(content, timeoutMs)}
//   await claudeCodeOnce({ prompt, schema, system, timeout, effort, model })  ->  {data, model, ms}
//   hasClaudeBin()  ->  true if the `claude` binary (MENTOR_CLAUDE_BIN) is on PATH
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

export const CLAUDE_CODE_MODEL = process.env.MENTOR_CLAUDE_CODE_MODEL || 'claude-opus-5-5';   // owner testing: Opus 5.5
export const claudeBin = () => process.env.MENTOR_CLAUDE_BIN || 'claude';
export const ownerTesting = () => process.env.MENTOR_OWNER_TESTING === '1';

/** Whether the CLI exists (never runs it). */
export function hasClaudeBin(bin = claudeBin()) {
  const exe = p => { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } };
  if (bin.includes('/')) return exe(bin);
  return (process.env.PATH || '').split(delimiter).some(d => d && exe(join(d, bin)));
}

/** One warm locked-down process; ask() sends one user turn and resolves with its result line. */
export function startClaudeCode(schema, system, dir, effort = 'low', model = CLAUDE_CODE_MODEL) {
  const args = ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(schema), '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence', '--effort', effort, '--system-prompt', system];
  // Allowlist: the CLI gets only what it needs to run and find its own login; none of Mentor's keys or phone numbers.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(PATH|HOME|USER|LANG|LC_\w+|TERM|TMPDIR|XDG_\w+|CLAUDE\w*)$/.test(k)) env[k] = v;
  const child = spawn(claudeBin(), args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = [];
  const failAll = why => { for (const w of waiting.splice(0)) w({ is_error: true, result: why }); };
  createInterface({ input: child.stdout }).on('line', line => {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (d.type === 'result') waiting.shift()?.(d);
  });
  child.on('exit', () => failAll('claude exited'));
  child.on('error', e => failAll(`claude could not start (${e?.code || e?.message || 'error'})`));   // e.g. no binary: an error, never a crash
  child.stdin.on('error', () => {});   // writing to a process that already exited
  return {
    child,
    ask(content, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('claude-code timed out'), { name: 'TimeoutError' })); }, timeoutMs);   // a fresh process on the next turn
        waiting.push(d => { clearTimeout(timer); d.is_error ? reject(new Error(String(d.result || 'claude-code error'))) : resolve(d); });
        child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    },
  };
}

/**
 * One structured request in its own process and its own empty temp folder, deleted afterwards. Owner testing only.
 * @returns {Promise<{data: any, model: string, ms: number}>}
 */
export async function claudeCodeOnce({ prompt, schema, system = 'Return only the JSON the schema asks for.', timeout = 60_000, effort = 'low', model = CLAUDE_CODE_MODEL }) {
  if (!ownerTesting()) throw new Error('claude-code runs on the owner\'s personal Claude subscription and is for owner testing only (MENTOR_OWNER_TESTING=1).');
  const dir = await mkdtemp(join(tmpdir(), 'mentor-cc-'));
  const p = startClaudeCode(schema, system, dir, effort, model);
  const t0 = Date.now();
  try {
    const d = await p.ask([{ type: 'text', text: String(prompt) }], timeout);
    const data = d.structured_output ?? JSON.parse(d.result);
    return { data, model, ms: Date.now() - t0 };
  } finally {
    p.child.kill();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
