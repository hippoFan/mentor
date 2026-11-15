// Mentor's brain (Gemini version): same job and same reply shape as ClaudeBrain in brain.mjs.
// Gemini points natively on a 0-1000 grid, so marks are asked for in that grid and divided by 1000.
// Free key: Google AI Studio (MLH link for HackUTA: https://mlh.link/hackuta-aistudio).
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { SCAN_SCHEMA, sanitizeScan, scanSystem } from './scan.mjs';
import { RECAP_ASK, RECAP_SCHEMA, SCHEMA, SYSTEM_CORE, normalizeReply, pointingRules, sanitizeReply } from './brain.mjs';

// Models tried in order. The free tier allows only ~20 requests a day per model, and a model can be overloaded, so on a
// 429 / 503 / 404 Mentor moves to the next one for the rest of the process instead of failing the turn.
export const GEMINI_MODELS = (process.env.MENTOR_GEMINI_MODELS || process.env.MENTOR_GEMINI_MODEL
  || 'gemini-3.5-flash-lite,gemini-3.5-flash').split(',').map(m => m.trim()).filter(Boolean);
export const GEMINI_MODEL = GEMINI_MODELS[0];
// Per-attempt deadline for a spoken turn on every model but the last (ODY_GEMINI_TURN_TIMEOUT_MS). Gemini's minimum is 10 s.
const TURN_TIMEOUT_MS = Number(process.env.MENTOR_GEMINI_TURN_TIMEOUT_MS || 10000);
const skipped = new Set();   // models that hit their limit in this process
// How long Gemini thinks per spoken turn (MENTOR_GEMINI_THINKING): LOW (default) or MINIMAL (faster).
const THINKING = ThinkingLevel[(process.env.MENTOR_GEMINI_THINKING || 'LOW').toUpperCase()] || ThinkingLevel.LOW;

const SCAN_SYSTEM = scanSystem('on a 0-1000 grid: x from 0 (left edge) to 1000 (right edge), y from 0 (top) to 1000 (bottom)');
const SYSTEM = `${SYSTEM_CORE}\n\n${pointingRules(
  'a point in the attached image on a 0-1000 grid: x from 0 (left edge) to 1000 (right edge), y from 0 (top) to 1000 (bottom)')}`;

export class GeminiBrain {
  provider = 'gemini';

  constructor({ task = '' } = {}) {
    this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
    /** @type {any[]} Gemini `contents`, append-only; model turns go back unchanged (keeps thought signatures) */
    this.messages = [];
    this.task = task;
    this.queue = Promise.resolve();
  }

  idle() { return this.queue.then(() => {}, () => {}); }

  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  #config(model, schema, level, timeout = 30_000) {
    return {
      systemInstruction: schema === SCAN_SCHEMA ? SCAN_SYSTEM : SYSTEM + (this.task ? `\n\nThe caller's task: ${this.task}` : ''),
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      // Gemini 2.x takes a token budget instead of a level; 0 = no thinking (fastest).
      maxOutputTokens: schema === SCHEMA ? 1600 : schema === SCAN_SCHEMA ? 12000 : 6000,
      thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: level === ThinkingLevel.MEDIUM ? 1024 : 0 } : { thinkingLevel: level },
      httpOptions: { timeout },
    };
  }

  /** One request, falling through GEMINI_MODELS on rate limits, overload or a missing model. */
  async #generate(contents, schema, level, timeout) {
    let last;
    for (const model of GEMINI_MODELS) {
      if (skipped.has(model) && model !== GEMINI_MODELS.at(-1)) continue;
      // A live call can't wait 30 s: unless this is the last model, each attempt gets a short deadline and a slow model
      // (timeout, 504 DEADLINE_EXCEEDED) is skipped for the rest of the call like a rate-limited one.
      const isLast = model === GEMINI_MODELS.at(-1);
      const attempt = timeout ?? (isLast ? 30_000 : TURN_TIMEOUT_MS);
      try {
        const response = await this.client.models.generateContent({ model, contents, config: this.#config(model, schema, level, attempt) });
        return { response, model };
      } catch (error) {
        last = error;
        const status = Number(error?.status || error?.code);
        const slow = status === 504 || (!status && /timed? ?out|abort|deadline/i.test(`${error?.name} ${error?.message}`));   // 400 'deadline too short' is a config error, not slowness
        if (![429, 503, 404, 500].includes(status) && !slow) throw error;
        skipped.add(model);
        console.warn(`[brain:gemini] ${model} ${slow ? 'too slow' : `unavailable (${status})`}; trying the next model`);
      }
    }
    throw last;
  }

  /** Same contract as ClaudeBrain.turn: marks come back normalised to 0..1 of the image. */
  turn(heard, image) { return this.#serial(() => this.#turn(heard, image)); }

  async #turn(heard, image) {
    const parts = [];
    if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image.jpeg.toString('base64') } }, { text: '[camera frame]' });
    else parts.push({ text: '[no camera frame available]' });
    parts.push({ text: `Caller said: ${heard}` });
    const user = { role: 'user', parts };

    const t0 = Date.now();
    const { response, model } = await this.#generate([...this.messages, user], SCHEMA, THINKING);
    const ms = Date.now() - t0;
    const modelTurn = response.candidates?.[0]?.content;
    if (modelTurn) this.messages.push(user, modelTurn);   // failed/blocked turn: nothing appended

    let out;
    try { out = JSON.parse(response.text || ''); }
    catch { return { say: 'Sorry, say that again?', marks: [], step: '', done: false, note: '', ms }; }
    normalizeReply(out, 1000, 1000, Boolean(image));
    sanitizeReply(out);
    out.ms = ms; out.model = model;
    const u = response.usageMetadata || {};
    console.log(`[brain:gemini] ${model} ${ms}ms in=${u.promptTokenCount} cached=${u.cachedContentTokenCount ?? 0} out=${u.candidatesTokenCount}`);
    return out;
  }

  /** Same contract as ClaudeBrain.scan: a separate request, not added to the conversation. */
  async scan(image) {
    const t0 = Date.now();
    const contents = [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: image.jpeg.toString('base64') } }, { text: '[camera frame] Scan the main object.' }] }];
    const { response, model } = await this.#generate(contents, SCAN_SCHEMA, ThinkingLevel.LOW, 90_000);
    const raw = JSON.parse(response.text || '');
    const ms = Date.now() - t0;
    console.log(`[brain:gemini] scan ${model} ${ms}ms`);
    return { ...sanitizeScan(raw, 1000, 1000), ms, model };
  }

  /** "Researched interiors" (research.mjs): what is inside a scanned object. A separate request, not in the conversation. */
  async research(scan, opts = {}) {
    const { geminiResearch } = await import('./research.mjs');
    return geminiResearch({ client: this.client, models: GEMINI_MODELS, skipped, scan, ...opts });
  }

  /**
   * Generic one-shot structured request (not added to the conversation), e.g. the circuit planner (circuit.mjs).
   * Falls through GEMINI_MODELS like every other call.
   * @param {string} prompt @param {object} schema JSON schema of the answer
   * @param {{jpeg: Buffer} | null} [image] @param {{system?: string, timeout?: number}} [opts]
   * @returns {Promise<{data: any, ms: number, model: string}>}
   */
  async structured(prompt, schema, image = null, { system = '', timeout = 30_000 } = {}) {
    const parts = [];
    if (image) parts.push({ inlineData: { mimeType: 'image/jpeg', data: image.jpeg.toString('base64') } }, { text: '[camera frame]' });
    parts.push({ text: String(prompt) });
    const t0 = Date.now();
    let last;
    for (const model of GEMINI_MODELS) {
      if (skipped.has(model) && model !== GEMINI_MODELS.at(-1)) continue;
      try {
        const response = await this.client.models.generateContent({ model, contents: [{ role: 'user', parts }], config: {
          ...(system ? { systemInstruction: system } : {}), responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 4000,
          thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.LOW }, httpOptions: { timeout } } });
        const ms = Date.now() - t0;
        console.log(`[brain:gemini] structured ${model} ${ms}ms`);
        return { data: JSON.parse(response.text || ''), ms, model };
      } catch (error) {
        last = error;
        const status = Number(error?.status || error?.code);
        if (![429, 503, 404, 500].includes(status)) throw error;
        skipped.add(model);
        console.warn(`[brain:gemini] ${model} unavailable (${status}); trying the next model`);
      }
    }
    throw last;
  }

  /** Same contract as ClaudeBrain.finish. */
  async finish() {
    if (!this.messages.length) return null;
    const { response } = await this.#generate([...this.messages, { role: 'user', parts: [{ text: RECAP_ASK }] }],
      RECAP_SCHEMA, ThinkingLevel.MEDIUM, 120_000);
    try { return JSON.parse(response.text || ''); } catch { return null; }
  }
}
