// Consent before anything is processed (PRIVACY.md). Ody's greeting asks the caller to say "yes"; until a clear yes it
// makes no brain calls, scans or research, writes no snapshots and sends no camera frames to the laptop page. Speech to
// text has to run to hear the answer (PRIVACY.md says ElevenLabs hears the voice). "Stop recording" mid-call stops all
// snapshot files for the rest of the call. Pure and testable: the agent wires say/send/log in.
//
// Retention: pruneRuns() deletes call folders (runs/YYYY-MM-DD-HH-MM-<hex>) older than ODY_KEEP_DAYS (default 7).
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const CONSENT_ON = process.env.MENTOR_CONSENT !== '0';   // ODY_CONSENT=0: owner testing only
export const CONSENT_GREETING = process.env.MENTOR_CONSENT_GREETING
  || "Hi, I'm Ody. I use AI to see your camera and hear you, through Google, ElevenLabs and LiveKit; the privacy notice is on the laptop. Say yes to continue.";
export const CONSENT_THANKS = "Thanks. Show me what you're building, and tell me where you want to get to.";
export const CONSENT_DECLINED = 'No problem. Nothing was saved. You can hang up any time.';
export const CONSENT_REASK = 'Sorry, I need a yes or a no. Say yes to continue.';
export const NO_RECORDING_SAY = "Okay. I've stopped saving snapshots for the rest of this call.";

const YES_WORDS = String.raw`yes|yeah|yea|yep|yup|ya|sure|okay|ok|alright|all right|i agree|agreed|i consent|go ahead|continue|sounds good|of course|absolutely|fine|that'?s fine|let'?s go|let'?s do it|i do|yes please|no problem|no worries|definitely|please do|why not|go for it`;
const YES = new RegExp(String.raw`^(?:(?:${YES_WORDS})(?:\b|$)[\s,.!]*)+`, 'i');
const NO = /^(?:no|nope|nah|stop|cancel|never ?mind|not now|no thanks|no thank you|don'?t|do not|i don'?t (?:agree|consent|want)|i do not (?:agree|consent|want)|i refuse|decline)\b/i;
const ASK_BACK = /^(?:yes|yeah|sure|ok(?:ay)?)\s*\?$|^(?:what|huh|sorry|pardon)\b/i;   // "yes?" / "what?" are not answers

/**
 * The caller's answer to the consent question. "Yes, scan this" = yes with rest "scan this" (handled as a turn after).
 * @returns {{answer: 'yes' | 'no' | 'unclear', rest: string}}
 */
export function consentAnswer(text) {
  const s = String(text || '').replace(/[’]/g, "'").trim();
  if (!s || ASK_BACK.test(s)) return { answer: 'unclear', rest: '' };
  if (/^(?:i\s+)?(?:do not|don'?t|never)\s+(?:agree|consent|want|accept)\b|^i\s+refuse\b|^i\s+decline\b/i.test(s)) return { answer: 'no', rest: '' };
  const yes = s.match(YES);
  if (yes) return { answer: 'yes', rest: s.slice(yes[0].length).replace(/^(?:and|so|then)\b[\s,]*/i, '').trim() };
  if (NO.test(s)) return { answer: 'no', rest: '' };
  return { answer: 'unclear', rest: '' };
}

/** "Stop recording" / "don't save" / "stop saving snapshots": no more snapshot files for this call. */
export const NO_RECORD = /\b(?:stop|don'?t|do not|no more|quit|pause)\s+(?:the\s+)?(?:recording|record|saving|save|snapshots?|taking (?:pictures|photos|snapshots))\b|\bdon'?t save (?:anything|this|it|me)\b|\bturn off (?:the )?recording\b/i;
export const isNoRecord = t => NO_RECORD.test(String(t || ''));

/**
 * The consent state machine for one call.
 * @param {{enabled?: boolean, say: (text: string) => void, send: (event: object) => void, log?: (rec: object) => void}} io
 *   log receives {type:'consent', state, at} records for conversation.json
 */
export function createConsentGate({ enabled = CONSENT_ON, say, send, log = () => {} }) {
  let state = enabled ? 'pending' : 'given', reasked = false, declinedSaid = false, noRecording = false;
  const record = st => { const rec = { type: 'consent', state: st, at: new Date().toISOString() }; log(rec); send({ ...rec }); };
  return {
    get state() { return state; },
    /** True once the caller said yes (or consent is off): brain calls, scans and snapshots may run. */
    get given() { return state === 'given'; },
    /** Snapshot files may be written: consent given and the caller hasn't said "stop recording". */
    get recording() { return state === 'given' && !noRecording; },
    get noRecording() { return noRecording; },
    /** Call when the greeting (with the question) is spoken. */
    asked() { if (state === 'pending') send({ type: 'consent', state: 'asked', at: new Date().toISOString() }); },
    /**
     * One heard utterance while consent isn't given yet.
     * @returns {{pass: boolean, rest: string}} pass = consent was just given and `rest` (maybe '') should be handled as a turn
     */
    answer(text) {
      if (state === 'given') return { pass: true, rest: text };
      const { answer, rest } = consentAnswer(text);
      if (answer === 'yes') {
        state = 'given'; record('given');
        if (!rest) say(CONSENT_THANKS);
        return { pass: true, rest };
      }
      if (answer === 'no' || isNoRecord(text)) {
        state = 'declined'; reasked = true;   // still gated (and quiet); a later clear yes is still consent
        if (!declinedSaid) { declinedSaid = true; say(CONSENT_DECLINED); send({ type: 'consent', state: 'declined', at: new Date().toISOString() }); }
        return { pass: false, rest: '' };
      }
      if (!reasked) { reasked = true; say(CONSENT_REASK); }   // re-ask once, then wait quietly (no loop burning TTS)
      return { pass: false, rest: '' };
    },
    /** "Stop recording" mid-call. Returns true if it changed anything. */
    stopRecording() {
      if (noRecording) return false;
      noRecording = true; record('no-recording');
      return true;
    },
  };
}

// ---------- retention ----------
export const RUN_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-[0-9a-f]{6,32}$/;
export const KEEP_DAYS = (() => { const n = Number(process.env.MENTOR_KEEP_DAYS ?? 7); return Number.isFinite(n) && n >= 1 ? n : 7; })();

/**
 * Deletes call folders in `dir` older than `days`, judged by the UTC start time in their name. Only real directories
 * whose name matches YYYY-MM-DD-HH-MM-<hex> (never symlinks, never anything else). Never throws.
 * @returns {Promise<string[]>} the folder names deleted
 */
export async function pruneRuns(dir, { days = KEEP_DAYS, now = Date.now(), log = console.log } = {}) {
  const keep = Math.max(1, Number(days) || 7) * 86_400_000, deleted = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return deleted; }
  for (const e of entries) {
    const m = e.name.match(RUN_DIR_RE);
    if (!m || !e.isDirectory() || e.isSymbolicLink()) continue;
    const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (!Number.isFinite(at) || now - at <= keep) continue;
    const path = join(dir, e.name);
    try {
      const st = await lstat(path);   // re-check right before deleting: still a real directory, not a symlink
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      await rm(path, { recursive: true, force: true });   // rm unlinks symlinks inside; it never follows them
      deleted.push(e.name);
    } catch (err) { log(`[retention] could not delete ${e.name}: ${err?.message || err}`); }
  }
  if (deleted.length) log(`[retention] deleted ${deleted.length} call folder(s) older than ${days} days: ${deleted.join(', ')}`);
  return deleted;
}
