// Voice control of the laptop's 3D twin: "explode it", "remove the wifi module", "put the USB back", "combine the rest",
// "show me the chip". Instant (no brain call) and only for short, direct commands, so a sentence that merely mentions a
// word isn't hijacked. The agent sends each command to the page as {type:'twin', action, target?, name?, query?, scope?}.
//
//   parseTwin('combine everything except the wifi module')   // [{action:'remove', query:'wifi module'}, {action:'combine'}]
//   matchPart('wifi module', stageParts)                      // {id, name, score} from the page's latest 'parts' list

/** View commands (no part target): [regex, action, spoken confirmation]. Checked in order. */
export const TWIN_CMDS = [
  [/\b(un-?explode|put (it|everything) (back )?together|re-?assemble|collapse( it)?|assemble( it)?|close it( back)? up)\b/i, 'assemble', 'Put it back together on your laptop.'],
  [/\b(explode|exploded view|blow it up|take it apart|break it apart|pull it apart|open it up|show me (the )?inside|show me what'?s inside|let me see inside)\b/i, 'explode', 'Exploded it on your laptop.'],
  [/\b(rotate|spin) (it|that|the model|the hologram)\b|\bturn it around\b/i, 'rotate', 'Spinning it on your laptop.'],
  [/\b(stop (spinning|rotating))\b/i, 'stop', 'Stopped.'],
  [/\b(reset|recenter|re-center) (the )?(view|model|hologram|camera)\b/i, 'reset', 'Reset the view.'],
  [/\b(realistic|real (view|look|mode)|make it look real)\b/i, 'realistic', 'Switched to the realistic look.'],
  [/\b(hologram (view|mode|look)|holographic)\b/i, 'hologram', 'Back to the hologram.'],
  [/\b(export|download|save) (it|the model|the 3d|a 3d file|the hologram)\b/i, 'export', 'Exported the 3D file on your laptop.'],
];
export const MAX_WORDS = 7;

// Politeness and filler that don't count toward the 7 words and are stripped before parsing.
const LEAD = /^(?:(?:ok(?:ay)?|so|now|and|then|hey|please|can you|could you|would you|will you|go ahead and|let'?s|just|ody)[\s,]+)+/;
const TAIL = /(?:[\s,]+(?:please|now|for me|thanks|thank you|on (?:the|my) (?:laptop|hologram|model|screen|twin)|from (?:the|my) (?:model|hologram|board|laptop)))+$/;
const norm = t => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'+\s-]/g, ' ').replace(/\s+/g, ' ').trim();
/** The command words (fillers stripped), or '' if this isn't a short direct command. */
export function commandWords(text) {
  const s = norm(text).replace(LEAD, '').replace(TAIL, '').trim();
  if (!s || s.split(' ').length > MAX_WORDS) return '';
  return s;
}

const NOT_A_COMMAND = /^(?:i|we|he|she|they|you|it|my|did|didn'?t|have|has|was|were)\b|\b(?:don'?t|do not|never|didn'?t|earlier|yesterday|already)\b/;
const VAGUE = /^(?:how|where|what|why|when|which|who|again|that again|it again|me|you|around|inside|up|down|everything|all|them|this|that)\b/;
const cleanQuery = q => q.replace(/^(?:the|a|an|my|that|this|those|these)\s+/, '').replace(/\s+(?:part|piece|thing|bit)$/, '').trim();
const splitTargets = q => q.split(/\s*(?:,|\band\b|\bplus\b)\s*/).map(x => cleanQuery(x)).filter(Boolean).slice(0, 4);

/**
 * Parses a short twin command.
 * @returns {{action: string, query?: string, say?: string}[] | null} commands in the order to send; query = the spoken
 *   noun phrase ('__it' = the part last talked about, '__last' = the part removed last); null if not a twin command
 */
export function parseTwin(text) {
  const s = commandWords(text);
  if (!s || NOT_A_COMMAND.test(s)) return null;
  // combine, optionally without some parts: "put it together without the X", "combine everything except the X"
  let m = s.match(/^(?:combine|merge|join|build|put)\b.*?\b(?:without|except(?: for)?|but not|minus|leaving out|leave out)\s+(.+)$/);
  if (m) { const t = splitTargets(m[1]); if (t.length) return [...t.map(query => ({ action: 'remove', query })), { action: 'combine' }]; }
  if (/^(?:combine|merge)(?: (?:the rest|everything|it|them|it all|all|all of it|what'?s left|the remaining(?: parts)?|the parts|the rest of it|together))?$/.test(s)
    || /^put (?:the rest|what'?s left|the remaining parts) together$/.test(s)) return [{ action: 'combine' }];
  // after voice edits (modify.mjs): "show me the new design" = combine and judge the new design
  if (/^(?:(?:show|give) me|let me see|show|combine|build|put together|check|judge|analy[sz]e|rate) (?:the |my |our )?(?:new|final|modified|changed|updated|edited) (?:design|version|model|build|thing|one)$/.test(s)
    || /^what does (?:the |my )?(?:new|modified|changed) (?:design|version|model|one) look like$/.test(s)) return [{ action: 'combine', design: true }];
  // view commands (explode / assemble / rotate ...): the original fast path
  const view = TWIN_CMDS.find(([re]) => re.test(s));
  if (view) return [{ action: view[1], say: view[2] }];
  // restore
  if (/^(?:bring|put) (?:everything|it all|them all|all(?: the parts| of it)?|all parts|the parts|them) back(?: in| on)?$/.test(s)
    || /^(?:restore|undo)(?: (?:everything|all|it all|the parts|all parts|them))?$/.test(s) || s === 'put everything back') return [{ action: 'restore' }];
  if (/^(?:put|bring) it back(?: in| on)?$/.test(s) || s === 'undo that') return [{ action: 'restore', query: '__last' }];
  m = s.match(/^(?:put|bring|add) (?:back )?(.+?)(?: back)?(?: in| on)?$/);
  if (m && /\bback\b/.test(s)) { const q = cleanQuery(m[1].replace(/\bback\b/, '').trim()); if (q && !VAGUE.test(q)) return [{ action: 'restore', query: q }]; }
  m = s.match(/^restore (.+)$/);
  if (m) { const q = cleanQuery(m[1]); if (q && !VAGUE.test(q)) return [{ action: 'restore', query: q }]; }
  // remove
  m = s.match(/^(?:remove|hide|take out|take off|take away|delete|drop|pull out|pull off|get rid of|lose)\s+(.+)$/) || s.match(/^(?:take|pull)\s+(.+?)\s+(?:out|off|away)$/);
  if (m) {
    const q = m[1].trim();
    if (/^(?:it|that|that one|this one)$/.test(q)) return [{ action: 'remove', query: '__it' }];
    const t = splitTargets(q);
    if (t.length && !t.some(x => VAGUE.test(x))) return t.map(query => ({ action: 'remove', query }));
    return null;
  }
  // select / focus
  m = s.match(/^(?:show me|highlight|select|point (?:at|to)|find)\s+(.+)$/);
  if (m) { const q = cleanQuery(m[1]); if (q && !VAGUE.test(q)) return [{ action: 'select', query: q }]; return null; }
  m = s.match(/^(?:zoom(?: in)? (?:on|into|to)|focus on|look at|go to)\s+(.+)$/);
  if (m) { const q = cleanQuery(m[1]); if (q && !VAGUE.test(q)) return [{ action: 'focus', query: q }]; return null; }
  return null;
}

// ---------- fuzzy part matching ----------
const STOP = new Set(['the', 'a', 'an', 'my', 'of', 'on', 'in', 'to', 'and', 'for', 'with', 'it', 'its', 'this', 'that']);
/** Words that name a kind of thing: a match on these alone counts for little. */
const GENERIC = new Set(['module', 'port', 'connector', 'board', 'part', 'button', 'header', 'headers', 'chip', 'pin', 'pins', 'led', 'unit', 'assembly', 'cover', 'body']);
export const tokens = s => String(s || '').toLowerCase().replace(/wi-?fi/g, 'wifi').replace(/usb-?c\b/g, 'usb c').replace(/usb-?b\b/g, 'usb b')
  .split(/[^a-z0-9]+/).filter(w => w && !STOP.has(w));
/** Spoken words -> words that appear in part names. Phrases first (checked on the whole query). */
const PHRASES = [
  [/\b(usb|serial) chip\b|\b16u2\b|usb to serial/, ['atmega16u2', '16u2', 'bridge']],
  [/\bmain chip\b|\bmain processor\b/, ['ra4m1', 'atmega328p', 'microcontroller', 'mcu', 'soc', 'processor']],
  [/\blogic board\b|\bmother ?board\b|\bmain ?board\b/, ['logic', 'motherboard', 'mainboard', 'board', 'pcb']],
  [/\bwireless charging\b|\bcharging coil\b|\bmag ?safe\b/, ['coil', 'charging', 'wireless', 'magsafe', 'magnet', 'magnets', 'nfc']],
  [/\bled matrix\b|\bdot matrix\b/, ['matrix', 'led']],
  [/\bback (glass|cover|panel)\b/, ['back', 'glass', 'cover', 'panel', 'rear']],
];
const SYN = {
  chip: ['ra4m1', 'atmega328p', 'microcontroller', 'mcu', 'soc', 'processor'],
  microcontroller: ['ra4m1', 'atmega328p', 'mcu', 'microcontroller'], mcu: ['ra4m1', 'atmega328p', 'microcontroller'],
  processor: ['ra4m1', 'atmega328p', 'microcontroller', 'soc', 'cpu'], cpu: ['ra4m1', 'atmega328p', 'microcontroller', 'soc', 'processor'],
  brain: ['ra4m1', 'atmega328p', 'microcontroller', 'soc'], arduino: ['ra4m1', 'atmega328p', 'microcontroller'],
  wifi: ['esp32', 's3', 'wifi', 'wireless', 'antenna', 'radio'], wireless: ['esp32', 's3', 'wifi', 'antenna', 'radio'],
  bluetooth: ['esp32', 's3', 'wifi', 'bluetooth', 'antenna', 'radio'], radio: ['esp32', 's3', 'antenna', 'wifi'], antenna: ['esp32', 's3', 'antenna'],
  esp: ['esp32', 's3'], esp32: ['esp32', 's3'], ble: ['esp32', 's3', 'bluetooth'],
  usb: ['usb', 'c', 'b', 'port'], cable: ['usb', 'port'], charger: ['usb', 'charging', 'port'], charging: ['usb', 'charging', 'port', 'coil'],
  power: ['barrel', 'jack', 'regulator', 'vin', 'power', 'battery'], barrel: ['barrel', 'jack'], jack: ['barrel', 'jack'], dc: ['barrel', 'jack'],
  regulator: ['regulator', 'ldo', 'buck'], adapter: ['barrel', 'jack'],
  lights: ['led', 'matrix', 'leds'], light: ['led', 'matrix'], leds: ['led', 'matrix'], matrix: ['matrix', 'led'],
  reset: ['reset', 'button'], qwiic: ['qwiic', 'connector'], stemma: ['qwiic'], i2c: ['qwiic'], icsp: ['icsp', 'header'],
  pins: ['header', 'headers', 'pins'], headers: ['header', 'headers', 'pins'],
  battery: ['battery', 'cell'], screen: ['display', 'screen', 'panel', 'oled', 'lcd'], display: ['display', 'screen', 'panel', 'oled', 'lcd', 'matrix'],
  camera: ['camera', 'cameras', 'lens', 'module'], cameras: ['camera', 'cameras', 'lens'], lens: ['camera', 'lens'], lenses: ['camera', 'lens'],
  speaker: ['speaker', 'speakers', 'earpiece'], mic: ['microphone', 'mic'], vibration: ['taptic', 'vibration', 'motor', 'haptic'],
  frame: ['frame', 'midframe', 'chassis'], sim: ['sim', 'tray'], case: ['case', 'shell', 'housing'], shell: ['shell', 'case', 'housing'],
  breadboard: ['breadboard'], sensor: ['sensor', 'hc', 'sr04', 'dht22', 'mpu6050'],
};
const GENERIC_SPOKEN = new Set(['module', 'part', 'thing', 'piece', 'one', 'component', 'unit']);

/**
 * Best part for a spoken noun phrase, or null. Token overlap with synonyms; a whole-phrase hit wins.
 * @param {string} query e.g. "wifi module", "the chip", "usb"
 * @param {{id: string, name: string}[]} parts the page's latest 'parts' list
 * @returns {{id: string, name: string, score: number} | null}
 */
export function matchPart(query, parts) {
  const q = String(query || '').toLowerCase().trim();
  const qt = tokens(q).filter(w => !GENERIC_SPOKEN.has(w) || tokens(q).length === 1);
  if (!qt.length || !Array.isArray(parts) || !parts.length) return null;
  const syn = new Set();
  for (const [re, add] of PHRASES) if (re.test(q)) add.forEach(w => syn.add(w));
  for (const w of qt) (SYN[w] || []).forEach(x => syn.add(x));
  let best = null;
  for (const p of parts) {
    if (!p || !p.name) continue;
    const nameTokens = tokens(p.name), pt = new Set([...nameTokens, ...tokens(p.id)]);
    let score = 0;
    for (const w of qt) if (pt.has(w)) score += GENERIC.has(w) ? 0.5 : 2;
    for (const w of syn) if (pt.has(w) && !qt.includes(w)) score += GENERIC.has(w) ? 0.25 : 1;
    const name = p.name.toLowerCase();
    if (q.length >= 3 && (name === q || name.includes(q))) score += 3;
    score /= 1 + 0.05 * nameTokens.length;   // a short, specific name beats a long one with the same hits
    if (score > (best?.score ?? 0)) best = { id: String(p.id || p.name), name: p.name, score: Math.round(score * 100) / 100 };
  }
  return best && best.score >= 0.75 ? best : null;   // at least one real (synonym) hit
}

/** "the USB-C port, the RA4M1 microcontroller, ..." — the first n part names, for "which parts exist". */
export function partList(parts, n = 5) {
  const names = [...new Set((parts || []).map(p => p?.name).filter(Boolean))].slice(0, n);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}
