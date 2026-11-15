// Project memory: what the caller BUILT and CHANGED this call (by voice), sent with every brain turn, so the brain never
// says "I don't see an LED" about a part it added itself, and knows the new design (modified parts) and the parts list.
// Pure, so tests can check it; agent.mjs fills it from the call's state.
import { modsMemory } from './modify.mjs';
import { checklistMemory } from './checklist.mjs';

/**
 * @param {{board?: string, circuit?: string, wiring?: string, removed?: string[], analysis?: {title: string, works: boolean} | null,
 *   scan?: string, mods?: {target: {name: string}, change: object}[], checklist?: object[]}} m
 * @returns {string} '' when there is nothing to remember
 */
// Always sent. Speech-to-text often hears a single mumbled word as a name ("Candace."), and the brain then kept calling
// the caller that; and the old board-only habit made it refuse edits on other objects.
export const RULES = '[Rules for this call: never call the caller by any name unless they clearly said "my name is ..."; Ody can scan, explode, take apart and edit ANY object by voice (pens, phones, anything), not only boards: never say it can\'t; if a request is unclear, ask one short question.]';

export function projectMemoryText({ board = '', circuit = '', wiring = '', removed = [], analysis = null, scan = '', mods = [], checklist = [] } = {}) {
  const lines = [];
  if (board) lines.push(`board recognised: ${board}`);
  if (circuit) lines.push(`circuit the caller asked for (by voice): ${circuit}`);
  if (wiring) lines.push(wiring);
  if (removed.length) lines.push(`parts removed in the 3D twin: ${removed.join(', ')}`);
  const m = modsMemory(mods); if (m) lines.push(m);
  if (analysis) lines.push(`last combo verdict: ${analysis.title} (${analysis.works ? 'works' : "won't work"})`);
  if (scan) lines.push(`last scan: ${scan}`);
  const c = checklistMemory(checklist); if (c) lines.push(c);
  if (!lines.length) return RULES;
  return `${RULES}\n[Project memory from this call. Trust it for what the caller has planned, added and changed. A part added by voice may not be plugged in yet: never say it is missing or that you don't have it; if you can't see it on camera, say it isn't plugged in yet and say where it goes. Parts on the parts list have no 3D model yet; the caller may not have them. ${lines.join('; ').slice(0, 1200)}]`;
}
