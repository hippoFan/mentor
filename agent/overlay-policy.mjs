// Overlays on demand: the caller's video is a plain camera by default. Mentor draws marks only on a turn where the
// caller asked to be shown something (where / show / which / connect ...) or when a reply carries a safety warning,
// and the drawing fades after MARK_TTL. MENTOR_OVERLAY=always restores the old always-on look (caption pill, voice
// bars, every mark). The laptop twin and monitor always get every mark either way.

export const OVERLAY = process.env.MENTOR_OVERLAY === 'always' ? 'always' : 'demand';
export const SHOW_SPEAKING = OVERLAY === 'always' || process.env.MENTOR_SHOW_SPEAKING === '1';
export const MARK_TTL_MS = OVERLAY === 'always' ? 25_000 : 10_000;

/** A turn where the caller wants something pointed at, labelled or wired. */
export const POINT_INTENT = /\b(where|show|point|which|what('s| is| are)|whats|label|identify|scan|wires?|wiring|connect|plug|jumper|pins?|holes?|go(es)? in(to)?)\b/i;

/**
 * Whether this turn's marks go on the caller's video.
 * @param {string} heard what the caller said
 * @param {{kind?: string}[]} marks the reply's marks
 * @param {'always' | 'demand'} [mode]
 */
export function shouldDraw(heard, marks, mode = OVERLAY) {
  if (!Array.isArray(marks) || !marks.length) return false;
  if (mode === 'always') return true;
  return marks.some(m => m?.kind === 'warn') || POINT_INTENT.test(String(heard || ''));
}

/**
 * What the renderer gets this frame: marks expire after the TTL, the caption pill only rides along with shown marks
 * (or always, in 'always' mode), voice bars only when enabled.
 * @returns {{marks: any[], caption: string, speaking: boolean, expired: boolean}}
 */
export function overlayFrame({ marks, marksAt, now = Date.now(), caption = '', speaking = false, mode = OVERLAY, ttl = MARK_TTL_MS, showSpeaking = SHOW_SPEAKING }) {
  const expired = marks.length > 0 && now - marksAt > ttl;
  const shown = expired ? [] : marks;
  return {
    marks: shown,
    caption: mode === 'always' || shown.length ? caption : '',
    speaking: showSpeaking && speaking,
    expired,
  };
}

/** Added to the brain's pointing rules in 'demand' mode, so it doesn't spend tokens on marks nobody will see. */
export const MARKS_ON_DEMAND = `Marks only on request: return marks only when the caller asks where something is, what or
which a part is, asks you to show, point at, label or identify something, or asks where a wire, pin or part connects or
goes; or when something is dangerous (kind "warn"). Otherwise "marks" is []. Still fill "board" whenever a board is in view.`;
