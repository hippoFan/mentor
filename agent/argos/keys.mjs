// API keys and integrations for the main page. Keys live only in the repo's .env on this laptop (mode 600). The page can
// set or clear a key from a fixed list; it can never read one back, only whether it is set and its last 4 characters.
//
//   keyStatus()                        // [{name, label, group, set, last4}]
//   await setKey('GEMINI_API_KEY', v)  // writes .env and process.env; '' clears it
import { chmod, readFile, writeFile } from 'node:fs/promises';

export const ENV_FILE = new URL('../../.env', import.meta.url);
export const KEYS = [
  { name: 'GEMINI_API_KEY', label: 'Gemini', group: 'models' },
  { name: 'ANTHROPIC_API_KEY', label: 'Claude (Anthropic)', group: 'models' },
  { name: 'ARGOS_OPENAI_KEY', label: 'OpenAI-compatible key', group: 'models' },
  { name: 'ARGOS_OPENAI_BASE', label: 'OpenAI-compatible base URL', group: 'models', secret: false },
  { name: 'ARGOS_OPENAI_MODEL', label: 'OpenAI-compatible model', group: 'models', secret: false },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', group: 'voice' },
  { name: 'CHERT_API_KEY', label: 'Chert', group: 'facetime' },
];
const byName = new Map(KEYS.map(k => [k.name, k]));

export function keyStatus() {
  return KEYS.map(k => {
    const v = process.env[k.name] || '';
    return { name: k.name, label: k.label, group: k.group, set: Boolean(v.trim()),
      ...(k.secret === false ? { value: v } : { last4: v.length >= 12 ? v.slice(-4) : '' }) };
  });
}

/** Validates and saves one key. Throws a user-readable Error. */
export async function setKey(name, value) {
  const k = byName.get(name);
  if (!k) throw new Error('Unknown setting.');
  const v = String(value ?? '').trim();
  if (v.length > 400 || /[\s"'`\\$]/.test(v)) throw new Error('That value has characters a key never has.');
  if (name === 'ARGOS_OPENAI_BASE' && v && !/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[\w./-]*)?$/i.test(v))
    throw new Error('The base URL must be https (or http://localhost for a local server).');
  let text = '';
  try { text = await readFile(ENV_FILE, 'utf8'); } catch { /* no .env yet */ }
  const lines = text.split('\n').filter(l => !new RegExp(`^\\s*${name}=`).test(l));
  while (lines.length && lines.at(-1) === '') lines.pop();
  if (v) lines.push(`${name}=${v}`);
  await writeFile(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  await chmod(ENV_FILE, 0o600).catch(() => {});
  if (v) process.env[name] = v; else delete process.env[name];
  return keyStatus().find(s => s.name === name);
}
