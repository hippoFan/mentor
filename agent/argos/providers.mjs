// Argos's model providers: one structured-JSON call, whichever key the user has. Gemini is the default (MLH track);
// Claude and any OpenAI-compatible API (OpenAI/Codex models, AIsa, Deepspace, a local server...) are optional.
// 'claude-code' is OWNER TESTING ONLY: the owner's own Claude subscription through the locked-down local `claude -p`
// (../claude-code-cli.mjs, the same path as the call brain). It exists only while MENTOR_OWNER_TESTING=1 is set in the
// hub's environment, is then tried first, and is never for judges, users or a public deployment (SECURITY.md).
// Keys come from .env (see keys.mjs); nothing here ever logs or returns a key.
//
//   await complete({ system, prompt, schema })                 // default order, falling through on errors/timeouts
//   await complete({ provider: 'claude', system, prompt, schema, timeout: 60_000, onNote })
//   providers()                                                // [{id, name, ready, model, owner?}] for the page
import { GoogleGenAI } from '@google/genai';
import { claudeCodeOnce, hasClaudeBin, ownerTesting } from '../claude-code-cli.mjs';
import { baseUrl } from './keys.mjs';

const env = (...names) => names.map(n => process.env[n]).find(v => typeof v === 'string' && v.trim())?.trim() || '';

export const PROVIDERS = {
  'claude-code': {
    name: 'Claude (owner\u2019s subscription \u2014 testing)',
    owner: true,
    available: ownerTesting,                      // not listed at all without MENTOR_OWNER_TESTING=1
    ready: () => ownerTesting() && hasClaudeBin(),
    models: () => [env('MENTOR_CLAUDE_CODE_MODEL') || 'claude-opus-5-5'],
  },
  gemini: {
    name: 'Gemini',
    key: () => env('GEMINI_API_KEY', 'GOOGLE_API_KEY'),
    models: () => (env('ARGOS_GEMINI_MODELS', 'ODY_GEMINI_MODELS', 'MENTOR_GEMINI_MODELS') || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash')
      .split(',').map(s => s.trim()).filter(Boolean),
  },
  claude: {
    name: 'Claude',
    key: () => env('ANTHROPIC_API_KEY'),
    models: () => [env('ARGOS_CLAUDE_MODEL') || 'claude-sonnet-5-5'],
  },
  openai: {
    name: env('ARGOS_OPENAI_NAME') || 'OpenAI-compatible',
    key: () => env('ARGOS_OPENAI_KEY', 'OPENAI_API_KEY'),
    models: () => [env('ARGOS_OPENAI_MODEL') || 'gpt-5.1-codex-mini'],
    base: () => baseUrl(env('ARGOS_OPENAI_BASE') || 'https://api.openai.com/v1'),   // the same allowlist as the Main page, also for a hand-edited .env
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);
const available = id => PROVIDERS[id]?.available?.() ?? Boolean(PROVIDERS[id]);
const ready = id => available(id) && (PROVIDERS[id].ready ? PROVIDERS[id].ready() : Boolean(PROVIDERS[id].key()));

/** The default order: the owner's subscription first while owner testing is on, then Gemini, then the others. */
export const defaultOrder = () => (ownerTesting() ? ['claude-code', 'gemini', 'claude', 'openai'] : ['gemini', 'claude', 'openai']).filter(available);

/** What the page may show, in the default order: never the key, only whether one is set. */
export function providers() {
  return defaultOrder().map(id => ({ id, name: PROVIDERS[id].name, ready: ready(id), model: PROVIDERS[id].models()[0], ...(PROVIDERS[id].owner ? { owner: true } : {}) }));
}
/** The providers to try, in order: the asked one (if usable), then the default order. Empty if none is ready. */
export function providerOrder(asked) {
  return [...new Set([asked, ...defaultOrder()])].filter(id => id && ready(id));
}
/** The provider to use first: the asked one if it is ready, else the first ready one in the default order. null if none. */
export function pickProvider(asked) { return providerOrder(asked)[0] || null; }

const isSlow = e => { const status = Number(e?.status || e?.code), http = status >= 400 && status < 600;
  return status === 504 || e?.name === 'AbortError' || e?.name === 'TimeoutError' || (!http && /timed? ?out|abort|deadline/i.test(`${e?.name} ${e?.message}`)); };
const skipped = new Set();   // Gemini models that hit a limit in this process (same idea as brain-gemini.mjs)
let gemini = null, geminiKey = '';

async function callGemini({ system, prompt, schema, timeout }) {
  const key = PROVIDERS.gemini.key();
  if (!gemini || key !== geminiKey) { gemini = new GoogleGenAI({ apiKey: key }); geminiKey = key; }
  const models = PROVIDERS.gemini.models();
  let last;
  for (const model of models) {
    if (skipped.has(model) && model !== models.at(-1)) continue;
    try {
      const r = await gemini.models.generateContent({
        model, contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 12000,
          httpOptions: { timeout } },
      });
      return { text: r.text || '', model };
    } catch (e) {
      last = e;
      const status = Number(e?.status || e?.code);
      // Too slow (504 DEADLINE_EXCEEDED, or our own deadline's abort): skip this model next time and let complete()
      // fall through to the next provider for this request, instead of waiting out every Gemini model.
      if (isSlow(e)) { skipped.add(model); throw e; }
      if (![429, 503, 404, 500].includes(status)) throw e;
      skipped.add(model);
      console.warn(`[argos] ${model} unavailable (${status}); trying the next model`);
    }
  }
  throw last || new Error('no Gemini model available');
}

async function callClaude({ system, prompt, schema, timeout }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: PROVIDERS.claude.key(), timeout, maxRetries: 1 });
  const model = PROVIDERS.claude.models()[0];
  const r = await client.messages.create({ model, max_tokens: 8000, system,
    output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: prompt }] });
  if (r.stop_reason === 'refusal') throw new Error('refused');
  return { text: r.content.filter(b => b.type === 'text').map(b => b.text).join(''), model };
}

async function callOpenAI({ system, prompt, schema, timeout }) {
  const p = PROVIDERS.openai, model = p.models()[0];
  if (!p.base()) throw new Error('The OpenAI-compatible base URL is not allowed. Set it on the Main page.');
  const res = await fetch(`${p.base()}/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key()}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      response_format: { type: 'json_schema', json_schema: { name: 'argos', schema, strict: false } } }),
  });
  if (!res.ok) throw Object.assign(new Error(`${p.name} ${res.status}`), { status: res.status });
  const j = await res.json();
  return { text: j.choices?.[0]?.message?.content || '', model };
}

async function callClaudeCode({ system, prompt, schema, timeout }) {
  // The owner's subscription, through the same locked-down `claude -p` as the call brain (no tools, no MCP, no settings,
  // allowlisted env, empty temp folder, killed on timeout). claudeCodeOnce refuses without MENTOR_OWNER_TESTING=1 too.
  const model = PROVIDERS['claude-code'].models()[0];
  const r = await claudeCodeOnce({ prompt, schema, system, timeout, model });
  return { text: JSON.stringify(r.data), model: `claude-code ${model}` };
}

const CALL = { 'claude-code': callClaudeCode, gemini: callGemini, claude: callClaude, openai: callOpenAI };

/** Rejects with a TimeoutError if fn() hasn't settled after ms (each provider also enforces its own deadline). */
function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * One structured call. Tries the asked provider, then the default order (providerOrder): a provider that times out or
 * fails is skipped for this request with a "trying the next model" note (console + onNote). Throws NO_KEY if none is
 * ready, else the last provider's error.
 * @param {{provider?: string, system: string, prompt: string, schema: object, timeout?: number, onNote?: (note: string) => void}} req
 * @returns {Promise<{data: any, provider: string, providerName: string, model: string, ms: number, skipped: {id: string, name: string, why: string}[]}>}
 */
export async function complete({ provider, system, prompt, schema, timeout = 60_000, onNote = () => {} }) {
  const order = providerOrder(provider);
  if (!order.length) throw Object.assign(new Error('No model key set. Add a Gemini key on the main page.'), { code: 'NO_KEY' });
  const passed = [];
  let last;
  for (const [i, id] of order.entries()) {
    const t0 = Date.now();
    try {
      const { text, model } = await deadline(CALL[id]({ system, prompt, schema, timeout }), timeout + 2_000);
      const data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
      const ms = Date.now() - t0;
      console.log(`[argos] ${id} ${model} ${ms}ms`);
      return { data, provider: id, providerName: PROVIDERS[id].name, model, ms, skipped: passed };
    } catch (e) {
      last = e;
      const why = isSlow(e) ? `didn't answer within ${Math.round(timeout / 1000)} s` : `failed (${String(e?.status || e?.message || 'error').slice(0, 80)})`;
      passed.push({ id, name: PROVIDERS[id].name, why });
      if (i === order.length - 1) break;
      const note = `${PROVIDERS[id].name} ${why}; trying the next model (${PROVIDERS[order[i + 1]].name}).`;
      console.warn(`[argos] ${note}`);
      try { onNote(note); } catch { /* page gone */ }
    }
  }
  throw last;
}
