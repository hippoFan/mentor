// API key STATUS for the main page. Keys live only in the repo's .env on this laptop and are set by editing that file.
// The page can see only whether each key is set: never a key, never part of one. Nothing here reads or writes .env
// (merge review: the page can't set keys, so a script on the page can't swap a base URL or replace a key).
//
//   keyStatus()                        // [{name, label, group, set}]  (non-secret settings also carry their value)
//   await setKey(...)                  // always refuses: edit .env on the laptop instead
export const KEYS = [
  { name: 'GEMINI_API_KEY', label: 'Gemini', group: 'models' },
  { name: 'ANTHROPIC_API_KEY', label: 'Claude (Anthropic)', group: 'models' },
  { name: 'ARGOS_OPENAI_KEY', label: 'OpenAI-compatible key', group: 'models' },
  { name: 'ARGOS_OPENAI_BASE', label: 'OpenAI-compatible base URL', group: 'models', secret: false },
  { name: 'ARGOS_OPENAI_MODEL', label: 'OpenAI-compatible model', group: 'models', secret: false },
  { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', group: 'voice' },
  { name: 'CHERT_API_KEY', label: 'Chert', group: 'facetime' },
];
// A base URL is shown as its host only (a URL can carry a token in its userinfo or query).
const host = v => { try { return v ? new URL(v).host : ''; } catch { return ''; } };

export function keyStatus() {
  return KEYS.map(k => {
    const v = process.env[k.name] || '';
    return { name: k.name, label: k.label, group: k.group, set: Boolean(v.trim()),
      ...(k.secret === false ? { value: k.name === 'ARGOS_OPENAI_BASE' ? host(v) : v } : {}) };
  });
}

/** Keys are never set from the page. Throws a user-readable Error with status 403. */
export async function setKey() {
  throw Object.assign(new Error('Keys are set in the .env file on this laptop, not from the page.'), { status: 403 });
}
