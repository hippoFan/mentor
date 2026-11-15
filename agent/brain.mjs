// Mentor's brain (Claude version): Claude Fable 5.2 sees the caller's latest camera frame plus what they said, and answers with
// what to say out loud, where to point on the frame, and the current step. One request per user turn.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = process.env.MENTOR_MODEL || 'claude-fable-5-2';
const EFFORT = process.env.MENTOR_EFFORT || 'low';   // voice call: keep turns fast; raise to 'medium' if steps get sloppy

export const SYSTEM_CORE = `You are Mentor, an AI on a FaceTime video call who guides someone through a hands-on build, one step at a time,
like a patient expert sitting next to them. You see their camera through the attached image (the most recent frame).
Your words are spoken aloud: keep "say" to one or two short, plain sentences. No markdown, no lists, no emoji.
Ask them to show you things, move the camera closer, or hold still when you cannot see well enough. Never guess a pin
or part you cannot actually see; say what you need instead. Confirm each step from the image before moving on.
Be clear you are an AI if asked. Safety first: tell them to unplug power before rewiring.
You are named after Mentor in Homer's Odyssey, whose shape Athena took to guide Telemachus home step by step. Be that
guide: calm, encouraging, never doing the work for them. At most one light Odyssey touch in a whole call (for example
when they finish: "you made it home"), never forced, never in the middle of an instruction.`;

/** How marks are expressed differs per model: Claude in image pixels, Gemini in its native 0-1000 grid. */
export const pointingRules = units => `Pointing: "marks" are drawn on their live video. Use at most 3. Each mark is ${units}.
Point at the exact spot (the hole, port, LED, or pin header
region). Prefer marking a region you are sure of over a single pin you are not. Leave "marks" empty when nothing
needs pointing at, or when the image is missing or unclear. Use kind "circle" to highlight, "arrow" to direct.
"step" is a short title for the current step (max 8 words). Set "done" true only when the whole task is finished.
"note" is one line for the after-call recap (what was done or decided this turn), or empty.`;

const SYSTEM = `${SYSTEM_CORE}\n\n${pointingRules('a pixel coordinate (x right, y down) in the attached image, whose size is given in the message')}`;

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'marks', 'step', 'done', 'note'],
  properties: {
    say: { type: 'string' },
    marks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'x', 'y', 'kind'],
        properties: {
          label: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          kind: { type: 'string', enum: ['arrow', 'circle'] },
        },
      },
    },
    step: { type: 'string' },
    done: { type: 'boolean' },
    note: { type: 'string' },
  },
};

export const RECAP_ASK =
  'The call has ended. Write the recap the caller gets by iMessage. "title": what they built (max 6 words). ' +
  '"summary": 2-4 short plain sentences on what they did and where they got to. "next": one suggested next step. ' +
  '"code": the complete final code for what they built (e.g. the Arduino sketch), or "" if no code was involved. ' +
  'Plain text only, no markdown fences.';
export const RECAP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'summary', 'next', 'code'],
  properties: { title: { type: 'string' }, summary: { type: 'string' }, next: { type: 'string' }, code: { type: 'string' } },
};

export class ClaudeBrain {
  provider = 'claude';
  constructor({ task = '' } = {}) {
    this.client = new Anthropic({ timeout: 30_000, maxRetries: 1 });
    /** @type {any[]} append-only: thinking blocks and every turn go back unchanged */
    this.messages = [];
    this.task = task;
    this.queue = Promise.resolve();   // turns run one at a time so history stays user/assistant/user/...
  }

  /** Resolves when no request is in flight. */
  idle() { return this.queue.then(() => {}, () => {}); }

  /** Runs fn after any in-flight turn; returns its result. */
  #serial(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {string} heard what the caller said this turn
   * @param {{jpeg: Buffer, width: number, height: number} | null} image latest camera frame
   * @returns {Promise<{say: string, marks: {label: string, x: number, y: number, kind: string}[], step: string, done: boolean, note: string, ms: number}>}
   *   marks come back normalised to 0..1 of the image
   */
  turn(heard, image) { return this.#serial(() => this.#turn(heard, image)); }

  async #turn(heard, image) {
    const content = [];
    if (image) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.jpeg.toString('base64') } });
      content.push({ type: 'text', text: `[camera frame ${image.width}x${image.height}px]` });
    } else {
      content.push({ type: 'text', text: '[no camera frame available]' });
    }
    content.push({ type: 'text', text: `Caller said: ${heard}` });
    const t0 = Date.now();
    // The user turn is appended only together with a successful answer, so a failed request leaves history valid.
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM + (this.task ? `\n\nThe caller's task: ${this.task}` : ''),
      messages: [...this.messages, { role: 'user', content }],
    });
    const ms = Date.now() - t0;
    this.messages.push({ role: 'user', content }, { role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      return { say: "Sorry, I can't help with that one. Let's get back to your build.", marks: [], step: '', done: false, note: '', ms };
    }
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let out;
    try { out = JSON.parse(text); }
    catch { return { say: 'Sorry, say that again?', marks: [], step: '', done: false, note: '', ms }; }

    const w = image?.width || 1, h = image?.height || 1;
    out.marks = image
      ? (out.marks || []).slice(0, 3)
          .map(m => ({ ...m, x: m.x / w, y: m.y / h }))
          .filter(m => m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1)
      : [];
    out.ms = ms;
    console.log(`[brain] ${ms}ms in=${response.usage?.input_tokens} cached=${response.usage?.cache_read_input_tokens} out=${response.usage?.output_tokens}`);
    return out;
  }

  /**
   * After the call: one more request on the same (cached) conversation for the recap text and the final code.
   * @returns {Promise<{title: string, summary: string, next: string, code: string} | null>} null if nothing happened
   */
  async finish() {
    if (!this.messages.length) return null;
    const ask = { role: 'user', content: [{ type: 'text', text: RECAP_ASK }] };
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECAP_SCHEMA } },
      system: SYSTEM + (this.task ? `\n\nThe caller's task: ${this.task}` : ''),
      messages: [...this.messages, ask],
    }, { timeout: 120_000 });
    this.messages.push(ask, { role: 'assistant', content: response.content });
    if (response.stop_reason === 'refusal') return null;
    try { return JSON.parse(response.content.filter(b => b.type === 'text').map(b => b.text).join('')); }
    catch { return null; }
  }
}

/**
 * Picks the brain: MENTOR_BRAIN=claude|gemini, else whichever key is present (Claude first).
 * @param {{task?: string, provider?: string}} [opts]
 */
export async function createBrain({ task = '', provider } = {}) {
  const want = provider || process.env.MENTOR_BRAIN
    || (process.env.ANTHROPIC_API_KEY ? 'claude' : (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) ? 'gemini' : '');
  if (want === 'claude') return new ClaudeBrain({ task });
  if (want === 'gemini') { const { GeminiBrain } = await import('./brain-gemini.mjs'); return new GeminiBrain({ task }); }
  throw new Error('No brain key: set ANTHROPIC_API_KEY or GEMINI_API_KEY in mentor/.env (or MENTOR_BRAIN)');
}
