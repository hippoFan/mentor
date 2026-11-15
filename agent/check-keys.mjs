// Checks the keys in ../.env without printing them:  npm run check-keys
// LiveKit: lists rooms (free). Gemini: looks up each model (no request, so no quota used).
// Anthropic: lists models (free). ElevenLabs: reads the account's subscription (free).
import { RoomServiceClient } from 'livekit-server-sdk';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_MODELS } from './brain-gemini.mjs';

const env = process.env;
const set = k => Boolean(env[k] && !/^(wss:\/\/)?YOUR_/.test(env[k]));
const row = (name, ok, detail) => console.log(`${ok === null ? '—   ' : ok ? 'OK  ' : 'FAIL'} ${name.padEnd(11)} ${detail}`);
const why = e => String(e?.status || e?.code || '') + ' ' + String(e?.message || e).replace(/(key|token|secret)=\S+/gi, '$1=***').slice(0, 160);

// LiveKit
if (['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].every(set)) {
  try {
    const host = env.LIVEKIT_URL.replace(/^wss?:\/\//, 'https://');
    const rooms = await new RoomServiceClient(host, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).listRooms();
    row('LiveKit', true, `project reachable, ${rooms.length} active room(s)`);
  } catch (e) {
    row('LiveKit', false, why(e));
    // Shape only, never values: catches swapped key/secret, cut-off secret, stray quotes/spaces, wrong URL form.
    const k = env.LIVEKIT_API_KEY, s = env.LIVEKIT_API_SECRET, u = env.LIVEKIT_URL;
    const odd = v => /[\s"'<>]/.test(v) ? 'HAS SPACES/QUOTES' : 'clean';
    console.log(`     key: starts "${k.slice(0, 3)}", ${k.length} chars, ${odd(k)}   (expected: starts "API", ~15 chars)`);
    console.log(`     secret: ${s.length} chars, ${odd(s)}, starts "API"? ${s.startsWith('API')}   (expected: ~40+ chars, not "API")`);
    console.log(`     url: scheme ${u.split('://')[0]}, ends ".livekit.cloud"? ${/\.livekit\.cloud\/?$/.test(u)}, ${odd(u)}`);
    console.log(`     laptop clock UTC: ${new Date().toISOString()} (tokens fail if this is off by minutes)`);
  }
} else row('LiveKit', false, 'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not all set');
row('AGENT_NAME', set('AGENT_NAME') ? true : null, set('AGENT_NAME') ? 'set' : 'not set (defaults to mentor-hackuta; pick a unique one)');

// Gemini
if (set('GEMINI_API_KEY') || set('GOOGLE_API_KEY')) {
  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY });
    // Lookup only: a real request would spend the free tier's ~20 requests/day/model.
    const found = [];
    for (const m of GEMINI_MODELS) { try { await ai.models.get({ model: m }); found.push(m); } catch { /* not available to this key */ } }
    row('Gemini', found.length > 0, found.length ? `key accepted; models: ${found.join(', ')}` : 'key accepted but none of MENTOR_GEMINI_MODELS is available');
  } catch (e) { row('Gemini', false, why(e)); }
} else row('Gemini', null, 'no GEMINI_API_KEY');

// Anthropic
if (set('ANTHROPIC_API_KEY')) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    row('Anthropic', r.ok, r.ok ? 'key accepted' : `HTTP ${r.status}`);
  } catch (e) { row('Anthropic', false, why(e)); }
} else row('Anthropic', null, 'no ANTHROPIC_API_KEY (Gemini will be the brain)');

// ElevenLabs
const eleven = env.ELEVEN_API_KEY || env.ELEVENLABS_API_KEY;
if (eleven) {
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': eleven } });
    const b = r.ok ? await r.json() : null;
    row('ElevenLabs', r.ok, r.ok ? `tier ${b.tier}, ${b.character_count}/${b.character_limit} credits used` : `HTTP ${r.status} (a key limited to TTS+STT may not read this; that's fine if the call works)`);
  } catch (e) { row('ElevenLabs', false, why(e)); }
} else row('ElevenLabs', null, 'no ELEVENLABS_API_KEY yet');

// Chert (optional)
row('Chert API', set('CHERT_API_KEY') && set('CHERT_PROJECT_ID') ? true : null,
  set('CHERT_API_KEY') ? 'key set (run npm run status for the line)' : 'not set (only needed for recap/status)');
