// Mentor's brain (Gemini version): same job and same reply shape as ClaudeBrain in brain.mjs.
// Gemini points natively on a 0-1000 grid, so marks are asked for in that grid and divided by 1000.
// Free key: Google AI Studio (MLH link for HackUTA: https://mlh.link/hackuta-aistudio).
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { RECAP_ASK, RECAP_SCHEMA, SCHEMA, SYSTEM_CORE, pointingRules } from './brain.mjs';

// Models tried in order. The free tier allows only ~20 requests a day per model, and a model can be overloaded, so on a
// 429 / 503 / 404 Mentor moves to the next one for the rest of the process instead of failing the turn.
export const GEMINI_MODELS = (process.env.MENTOR_GEMINI_MODELS || process.env.MENTOR_GEMINI_MODEL
  || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash').split(',').map(m => m.trim()).filter(Boolean);
export const GEMINI_MODEL = GEMINI_MODELS[0];
const skipped = new Set();   // models that hit their limit in this process
// How long Gemini thinks per spoken turn (MENTOR_GEMINI_THINKING): LOW (default) or MINIMAL (faster).
const THINKING = ThinkingLevel[(process.env.MENTOR_GEMINI_THINKING || 'LOW').toUpperCase()] || ThinkingLevel.LOW;

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
      systemInstruction: SYSTEM + (this.task ? `\n\nThe caller's task: ${this.task}` : ''),
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      // Gemini 2.x takes a token budget instead of a level; 0 = no thinking (fastest).
      thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: level === ThinkingLevel.MEDIUM ? 1024 : 0 } : { thinkingLevel: level },
      httpOptions: { timeout },
    };
  }

  /** One request, falling through GEMINI_MODELS on rate limits, overload or a missing model. */
  async #generate(contents, schema, level, timeout) {
    let last;
    for (const model of GEMINI_MODELS) {
      if (skipped.has(model) && model !== GEMINI_MODELS.at(-1)) continue;
      try {
        const response = await this.client.models.generateContent({ model, contents, config: this.#config(model, schema, level, timeout) });
        return { response, model };
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
    out.marks = image
      ? (out.marks || []).slice(0, 3)
          .map(m => ({ ...m, x: m.x / 1000, y: m.y / 1000 }))
          .filter(m => m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1)
      : [];
    out.ms = ms;
    const u = response.usageMetadata || {};
    console.log(`[brain:gemini] ${model} ${ms}ms in=${u.promptTokenCount} cached=${u.cachedContentTokenCount ?? 0} out=${u.candidatesTokenCount}`);
    return out;
  }

  /** Same contract as ClaudeBrain.finish. */
  async finish() {
    if (!this.messages.length) return null;
    const { response } = await this.#generate([...this.messages, { role: 'user', parts: [{ text: RECAP_ASK }] }],
      RECAP_SCHEMA, ThinkingLevel.MEDIUM, 120_000);
    try { return JSON.parse(response.text || ''); } catch { return null; }
  }
}
