// The laptop's record button: one recorded clip -> ElevenLabs Scribe (batch speech-to-text) -> text for Argos.
// The key stays on the laptop; the page only uploads audio to its own server. Wispr Flow needs nothing here: it types
// into whatever text box is focused, including Argos's.
export const STT = { maxBytes: 8 * 1024 * 1024, model: process.env.ARGOS_STT_MODEL || 'scribe_v2', timeoutMs: 30_000 };
export const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];

/** @returns {Promise<{text: string, language: string, ms: number}>} throws a user-readable Error */
export async function transcribe(buf, type = 'audio/webm', fetchFn = fetch) {
  const key = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
  if (!key) throw new Error('No ElevenLabs key. Add one on the main page, or type instead.');
  if (!Buffer.isBuffer(buf) || buf.length < 200) throw new Error('That recording was empty.');
  if (buf.length > STT.maxBytes) throw new Error('That recording is too long. Keep it under a minute.');
  const mime = AUDIO_TYPES.find(t => String(type).startsWith(t)) || 'audio/webm';
  const form = new FormData();
  form.append('model_id', STT.model);
  form.append('file', new Blob([buf], { type: mime }), `clip.${mime.split('/')[1].replace('x-', '').replace('mpeg', 'mp3')}`);
  const t0 = Date.now();
  let res = await fetchFn('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(STT.timeoutMs) });
  if (res.status === 422 && STT.model !== 'scribe_v1') {   // an account or region without v2: fall back once
    form.set('model_id', 'scribe_v1');
    res = await fetchFn('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(STT.timeoutMs) });
  }
  if (res.status === 401) throw new Error('ElevenLabs refused the key.');
  if (res.status === 429 || res.status === 402) throw new Error('ElevenLabs credits or rate limit reached. Type instead.');
  if (!res.ok) throw new Error(`Speech-to-text failed (${res.status}).`);
  const j = await res.json();
  return { text: String(j.text || '').replace(/\s+/g, ' ').trim().slice(0, 600), language: String(j.language_code || '').slice(0, 8), ms: Date.now() - t0 };
}
