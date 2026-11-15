// API keys for Argos, set from the Main page (user-approved, locked down). Keys live only in the repo's .env on this
// laptop. The page can WRITE a key and read back only whether it is set plus its last 4 characters: never the key.
//
//   keyStatus()                         // [{name, label, group, set, settable, last4?}] (+ host for the base URL, value for the model)
//   await setKey(name, value)           // validate, write .env atomically (temp + rename, mode 600), update process.env
//
// Rules (SECURITY.md): fixed allowlist of names; values are single-line, from a fixed character set and length-capped;
// the OpenAI-compatible base URL may only point at OpenAI, AIsa or this laptop; '' clears. Values are never logged and
// never appear in an error. Origin/Host are checked by live.mjs and again in server.mjs. ARGOS_ENV_FILE overrides the
// file (tests use a temp file; nothing in the tests ever opens the real .env).
import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const SECRET = /^[A-Za-z0-9._\-+/=~]{12,300}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{1,120}$/;
export const KEYS = [
  { name: 'GEMINI_API_KEY', label: 'Gemini', group: 'models', check: SECRET },
  { name: 'ANTHROPIC_API_KEY', label: 'Claude (Anthropic)', group: 'models', check: SECRET },
  { name: 'ARGOS_OPENAI_KEY', label: 'OpenAI-compatible key', group: 'models', check: SECRET },
  { name: 'ARGOS_OPENAI_BASE', label: 'OpenAI-compatible base URL', group: 'models', secret: false, check: v => baseUrl(v) !== null },
  { name: 'ARGOS_OPENAI_MODEL', label: 'OpenAI-compatible model', group: 'models', secret: false, check: MODEL },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', group: 'voice', check: SECRET },
  { name: 'CHERT_API_KEY', label: 'Chert', group: 'facetime', settable: false },   // the call line: status only, set in .env
];
const BY_NAME = new Map(KEYS.map(k => [k.name, k]));

// The base URL may point only at OpenAI, AIsa (OpenAI-compatible) or a server on this laptop. No user:pass, query or hash.
export const BASE_HOSTS = ['api.openai.com', 'api.aisa.one'];
const OWN_PORTS = () => [8789, 8790, Number(process.env.MENTOR_HUB_PORT || 8789), Number(process.env.MENTOR_MONITOR_PORT || 8790)];
/** @returns {string|null} the normalised base URL, or null if it is not allowed */
export function baseUrl(v) {
  if (typeof v !== 'string' || v.length > 200) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || !/^[A-Za-z0-9._/-]*$/.test(u.pathname)) return null;
  const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    && !OWN_PORTS().includes(Number(u.port || 80));   // never Ody's own hub or page server (the key would go to them)
  const known = u.protocol === 'https:' && !u.port && BASE_HOSTS.includes(u.hostname);
  if (!local && !known) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}
// A base URL is shown as its host only.
const host = v => { try { return v ? new URL(v).host : ''; } catch { return ''; } };

export function keyStatus() {
  return KEYS.map(k => {
    const v = (process.env[k.name] || '').trim();
    const out = { name: k.name, label: k.label, group: k.group, set: Boolean(v), settable: k.settable !== false };
    if (k.secret === false) out[k.name === 'ARGOS_OPENAI_BASE' ? 'host' : 'value'] = k.name === 'ARGOS_OPENAI_BASE' ? host(v) : v;
    else if (v.length >= 24) out.last4 = v.slice(-4);   // short values show nothing: 4 characters would be too much of them
    return out;
  });
}

export const envFile = () => process.env.ARGOS_ENV_FILE || fileURLToPath(new URL('../../.env', import.meta.url));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Validates without echoing the value. @returns {string} the value to store ('' clears) */
export function checkKey(name, value) {
  const k = BY_NAME.get(name);
  if (!k || k.settable === false) throw fail('That setting can’t be changed from the page.', 403);
  if (typeof value !== 'string') throw fail('The value must be text.');
  const v = value.trim();
  if (v === '') return '';
  if (CONTROL.test(v)) throw fail('One line only, no special characters.');
  if (k.name === 'ARGOS_OPENAI_BASE') {
    const b = baseUrl(v);
    if (!b) throw fail('The base URL must be https://api.openai.com, https://api.aisa.one, or http://127.0.0.1 / http://localhost on this laptop.');
    return b;
  }
  if (!k.check.test(v)) throw fail(k.secret === false ? 'Model names use letters, digits and . _ : / @ - only.' : 'That doesn’t look like an API key (12–300 letters, digits and - _ . + / = ~).');
  return v;
}

let chain = Promise.resolve();   // one write at a time
/**
 * Sets (or with '' clears) one allowlisted key: rewrites only that line of .env, atomically, mode 600, and updates
 * process.env so Argos uses it without a restart. Never logs or returns the value.
 * @returns {Promise<{name: string, set: boolean, last4?: string}>}
 */
export function setKey(name, value) {
  const v = checkKey(name, value);
  const run = chain.then(async () => {
    const file = envFile();
    let text = '';
    try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw fail('Couldn’t read the settings file.', 500); }
    const lines = text.split('\n'), re = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
    const out = []; let placed = false;
    for (const line of lines) {
      if (!re.test(line)) { out.push(line); continue; }
      if (!placed && v) out.push(`${name}=${v}`);
      placed = true;
    }
    if (!placed && v) { if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${name}=${v}`); else out.push(`${name}=${v}`); }
    let body = out.join('\n'); if (body && !body.endsWith('\n')) body += '\n';
    const tmp = join(dirname(file), `.env.tmp-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
      await chmod(tmp, 0o600);
      await rename(tmp, file);
    } catch {
      await rm(tmp, { force: true });
      throw fail('Couldn’t save the settings file.', 500);
    }
    if (v) process.env[name] = v; else delete process.env[name];
    return keyStatus().find(k => k.name === name);
  });
  chain = run.catch(() => {});
  return run;
}
