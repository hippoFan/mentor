// Argos's model providers: one structured-JSON call, whichever key the user has. Gemini is the default (MLH track);
// Claude and any OpenAI-compatible API (OpenAI/Codex models, AIsa, Deepspace, a local server...) are optional.
// Keys come from .env (see keys.mjs); nothing here ever logs or returns a key.
//
//   await complete({ system, prompt, schema })                 // default provider
//   await complete({ provider: 'claude', system, prompt, schema, timeout: 60_000 })
//   providers()                                                // [{id, name, ready, model}] for the page
import { GoogleGenAI } from '@google/genai';

const env = (...names) => names.map(n => process.env[n]).find(v => typeof v === 'string' && v.trim())?.trim() || '';

export const PROVIDERS = {
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
    base: () => (env('ARGOS_OPENAI_BASE') || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** What the page may show: never the key, only whether one is set. */
export function providers() {
  return PROVIDER_IDS.map(id => ({ id, name: PROVIDERS[id].name, ready: Boolean(PROVIDERS[id].key()), model: PROVIDERS[id].models()[0] }));
}
/** The provider to use: the asked one if it has a key, else Gemini, else the first with a key. null if none. */
export function pickProvider(asked) {
  if (PROVIDERS[asked]?.key()) return asked;
  return ['gemini', ...PROVIDER_IDS].find(id => PROVIDERS[id].key()) || null;
}

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

const CALL = { gemini: callGemini, claude: callClaude, openai: callOpenAI };

/**
 * One structured call. Throws if no provider has a key or the reply isn't JSON.
 * @returns {Promise<{data: any, provider: string, model: string, ms: number}>}
 */
export async function complete({ provider, system, prompt, schema, timeout = 60_000 }) {
  const id = pickProvider(provider);
  if (!id) throw Object.assign(new Error('No model key set. Add a Gemini key on the main page.'), { code: 'NO_KEY' });
  const t0 = Date.now();
  const { text, model } = await CALL[id]({ system, prompt, schema, timeout });
  const data = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  const ms = Date.now() - t0;
  console.log(`[argos] ${id} ${model} ${ms}ms`);
  return { data, provider: id, model, ms };
}
