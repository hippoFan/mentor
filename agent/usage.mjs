// What Ody has used: the ElevenLabs subscription's character quota, then per call (from logs/agent.log and
// runs/*/conversation.json): brain calls by provider/model, scans, research calls and TTS characters spoken.
//   npm run usage                  (node --env-file=../.env usage.mjs; the key is read from the environment, never printed)
//   node usage.mjs --no-api        logs only, no network
//   node usage.mjs --log <file> --runs <dir>
import './env.mjs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LOG = opt('--log', fileURLToPath(new URL('../logs/agent.log', import.meta.url)));
const RUNS = opt('--runs', fileURLToPath(new URL('../runs/', import.meta.url)));

/** ElevenLabs subscription usage. Never prints or returns the key. */
export async function elevenUsage(key = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY, fetchFn = fetch) {
  if (!key) return { ok: false, why: 'no ELEVENLABS_API_KEY in the environment (run with node --env-file=../.env)' };
  try {
    const r = await fetchFn('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, why: `ElevenLabs answered HTTP ${r.status}` };
    const d = await r.json();
    return { ok: true, tier: String(d.tier ?? ''), used: Number(d.character_count) || 0, limit: Number(d.character_limit) || 0,
      reset: d.next_character_count_reset_unix ? new Date(d.next_character_count_reset_unix * 1000) : null, status: String(d.status ?? '') };
  } catch (e) { return { ok: false, why: `ElevenLabs request failed: ${e?.name === 'TimeoutError' ? 'timeout' : 'network error'}` }; }
}

/**
 * Splits agent.log into calls and counts what each used.
 * @returns {{id: string, brain: Record<string, number>, scans: number, research: Record<string, number>, analyses: number,
 *   holes: number, ttsChars: number, ttsExact: boolean, says: number}[]}
 */
export function parseAgentLog(text) {
  const calls = [];
  let c = null;
  const start = id => { c = { id, brain: {}, scans: 0, research: {}, analyses: 0, holes: 0, ttsChars: 0, ttsExact: false, says: 0, usageLine: null }; calls.push(c); };
  const add = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const line of String(text).split('\n')) {
    let m = line.match(/^\[mentor\] call (\S+?),/);
    if (m) { start(m[1]); continue; }
    if (!c) { if (/^\[(brain|speak|scan|research)/.test(line)) start('(before the first call line)'); else continue; }
    if ((m = line.match(/^\[brain:(gemini|claude-code)\] (?:(scan|structured) )?(\S+) \d+ms/))) add(c.brain, `${m[1]} ${m[3]}${m[2] ? ` (${m[2]})` : ''}`);
    else if ((m = line.match(/^\[brain\] (?:(scan|structured) )?(\S+) \d+ms/))) add(c.brain, `claude ${m[2]}${m[1] ? ` (${m[1]})` : ''}`);
    else if ((m = line.match(/^\[brain\] (?:scan )?\d+ms/))) add(c.brain, 'claude (model not logged)');
    else if ((m = line.match(/^\[research:(gemini|claude-code)\] (\S+)/))) add(c.research, `${m[1]} ${m[2]}`);
    else if (/^\[scan\] .* in \d+ ms$/.test(line)) c.scans++;
    else if (/^\[analysis\] (works|does not work)/.test(line)) c.analyses++;
    else if (/^\[connect\] step /.test(line)) c.holes++;
    else if ((m = line.match(/^\[(?:speak|say:muted)\] \((\d+) ch\)/))) { c.ttsChars += Number(m[1]); c.ttsExact = true; c.says++; }
    else if ((m = line.match(/^\[speak\] (.*)$/))) { c.ttsChars += m[1].length; c.says++; }   // old lines: cut at 80 chars
    else if ((m = line.match(/^\[usage\] call \S+: tts_chars=(\d+)/))) c.usageLine = Number(m[1]);
  }
  for (const k of calls) if (k.usageLine != null) { k.ttsChars = k.usageLine; k.ttsExact = true; }
  return calls;
}

/** Per run folder: brain turns and the characters of the brain's spoken replies, from conversation.json. */
export async function runSummaries(dir = RUNS) {
  const out = [];
  let names = [];
  try { names = (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink() && /^\d{4}-\d{2}-\d{2}-/.test(e.name)).map(e => e.name).sort(); } catch { return out; }
  for (const name of names) {
    let msgs; try { msgs = JSON.parse(await readFile(join(dir, name, 'conversation.json'), 'utf8')); } catch { continue; }
    if (!Array.isArray(msgs)) continue;
    let turns = 0, chars = 0;
    const sayOf = t => { try { return String(JSON.parse(t)?.say || ''); } catch { return ''; } };
    for (const m of msgs) {
      if (m?.type === 'consent') continue;
      if (typeof m?.say === 'string') { turns++; chars += m.say.length; continue; }   // claude-code transcript
      if (m?.role === 'assistant' && Array.isArray(m.content)) { turns++; chars += m.content.filter(b => b?.type === 'text').map(b => sayOf(b.text)).join('').length; }
      if (m?.role === 'model' && Array.isArray(m.parts)) { turns++; chars += m.parts.filter(p => p?.text && !p.thought).map(p => sayOf(p.text)).join('').length; }
    }
    out.push({ name, turns, sayChars: chars, consent: msgs.find(m => m?.type === 'consent' && m.state === 'given')?.at || '' });
  }
  return out;
}

const fmt = n => Number(n).toLocaleString('en-US');
async function main() {
  if (!args.includes('--no-api')) {
    const e = await elevenUsage();
    if (e.ok) {
      const pct = e.limit ? ` (${(100 * e.used / e.limit).toFixed(1)}%)` : '';
      console.log(`ElevenLabs ${e.tier || 'subscription'}: ${fmt(e.used)} / ${fmt(e.limit)} characters used${pct}, ${fmt(Math.max(0, e.limit - e.used))} left${e.reset ? `; resets ${e.reset.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`);
    } else console.log(`ElevenLabs: ${e.why}`);
  }
  let log = '';
  try { log = await readFile(LOG, 'utf8'); } catch { console.log(`(no log at ${LOG})`); }
  const calls = parseAgentLog(log);
  const total = { tts: 0, brain: {}, scans: 0, research: 0 };
  console.log(`\nCalls in ${LOG}: ${calls.length}`);
  for (const c of calls) {
    const brain = Object.entries(c.brain).map(([k, v]) => `${k} x${v}`).join(', ') || 'none';
    const research = Object.values(c.research).reduce((a, b) => a + b, 0);
    console.log(`- ${c.id}: brain ${brain}; scans ${c.scans}; research ${research}; analyses ${c.analyses}; hole lookups ${c.holes}; TTS ${c.ttsExact ? '' : '~'}${fmt(c.ttsChars)} chars in ${c.says} lines`);
    total.tts += c.ttsChars; total.scans += c.scans; total.research += research;
    for (const [k, v] of Object.entries(c.brain)) total.brain[k] = (total.brain[k] || 0) + v;
  }
  console.log(`Total: brain ${Object.entries(total.brain).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}; scans ${total.scans}; research ${total.research}; TTS ~${fmt(total.tts)} chars`);
  const runs = await runSummaries();
  if (runs.length) {
    console.log(`\nRuns with a transcript in ${RUNS}:`);
    for (const r of runs) console.log(`- ${r.name}: ${r.turns} brain turns, ${fmt(r.sayChars)} chars of spoken replies${r.consent ? `, consent ${r.consent}` : ''}`);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
