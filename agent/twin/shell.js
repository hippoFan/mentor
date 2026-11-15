// The app shell around the 3D twin: ONE WebSocket for the whole page, the call state (waiting / live / reconnecting /
// ended), the caller's phone view, the step + the voyage to Ithaca, the conversation, and the tester drawer.
// No three.js here: if WebGL or the twin fails to load, the call side of the page still works.
// Other modules (twin/app.js) listen through subscribe(); a late subscriber gets the last hello and everything since.

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const secs = ms => (ms / 1000).toFixed(1);
const BRAINS = { gemini: 'Gemini', claude: 'Claude', 'claude-code': 'Claude Code' };
const SLOW = 4000;   // a turn slower than this gets underlined for the tester
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// ---------- the bus: one socket, many listeners ----------
const listeners = new Set();
let history = [];   // the last hello and every event since (no video frames), for listeners that attach late
/** @param {(event: object) => void} fn @returns {() => void} unsubscribe */
export function subscribe(fn) {
  listeners.add(fn);
  for (const e of history) { try { fn(e); } catch (err) { console.warn('[ody] listener', err); } }
  return () => listeners.delete(fn);
}
function emit(e) {
  if (e.type === 'hello') history = [e];
  else if (e.type !== 'frame' && e.type !== 'input' && e.type !== 'twin') {   // voice commands act once, never on replay
    history.push(e); if (history.length > 400) history.splice(1, 1); }
  for (const fn of listeners) { try { fn(e); } catch (err) { console.warn('[ody] listener', err); } }
}

const S = {
  sock: false, everConnected: false, retryAt: 0, call: null, since: 0, brain: '', step: '', done: false,
  steps: [], turns: [], mood: 'listening', moodTimer: 0, frames: [], inputs: [], lastFrame: 0, input: null,
  lines: [], expanded: false, replay: null, consent: null,
};
let sock = null;
/** Page -> server (same socket): {type:'parts'|'analyze', ...}. Dropped while disconnected; the server validates. */
export function send(obj) {
  try { if (sock && sock.readyState === 1) { sock.send(JSON.stringify(obj)); return true; } } catch { /* closed */ }
  return false;
}
const CONSENT = { asked: 'Waiting for the caller to agree', given: 'Caller agreed', declined: 'Caller declined, nothing processed', 'no-recording': 'Not recording snapshots' };
function consentUi() {
  const c = S.call === 'live' ? S.consent : null, pill = $('consent');
  pill.hidden = !c || !CONSENT[c];
  if (!pill.hidden) { pill.textContent = CONSENT[c]; pill.dataset.state = c; }
  $('consentCard').hidden = c !== 'asked';
  document.body.classList.toggle('consent-asked', c === 'asked');
}
function replayUi() {
  const on = S.call === 'live' && !!S.replay;
  document.body.toggleAttribute('data-replay', on);
  $('replayBadge').hidden = !on;
  $('replayBadge').textContent = on ? (typeof S.replay === 'string' ? S.replay.slice(0, 70) : 'Replay of a real call') : '';   // one line: the event's label, or the plain fact
}

/** waiting | connecting | live | reconnecting | ended */
export function phase() {
  if (!S.sock) return S.everConnected ? 'reconnecting' : 'connecting';
  if (S.call === 'live') return 'live';
  if (S.call === 'ended') return 'ended';
  return 'waiting';
}

// ---------- status pill + the stage message ----------
function status() {
  const p = phase(), now = Date.now();
  document.body.dataset.phase = p;
  document.body.classList.toggle('live', p === 'live');
  let t;
  if (p === 'reconnecting') { const s = Math.max(0, Math.ceil((S.retryAt - now) / 1000)); t = s ? `Reconnecting in ${s} s` : 'Reconnecting…'; }
  else if (p === 'connecting') t = 'Connecting…';
  else if (p === 'live') { const s = Math.max(0, Math.floor((now - S.since) / 1000)); t = `${S.replay ? '' : 'Live '}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }   // a replay's badge already says so
  else if (p === 'ended') t = 'Call ended, recap saved';
  else t = 'Waiting for a call';
  $('status').textContent = t;
  $('brain').textContent = S.brain && p === 'live' ? `with ${BRAINS[S.brain] || String(S.brain).slice(0, 24)}` : '';
  // tester
  $('sock').textContent = S.sock ? 'Connected' : S.everConnected ? 'Reconnecting' : 'Connecting';
  $('sockPip').classList.toggle('on', S.sock);
  $('callState').textContent = S.call === 'live' ? 'Live' : S.call === 'ended' ? 'Ended' : 'No call';
  const lastTurn = S.turns[S.turns.length - 1];
  $('model').textContent = (BRAINS[S.brain] || S.brain || 'Not set') + (lastTurn?.model ? `, ${lastTurn.model}` : '');
  S.frames = S.frames.filter(x => now - x < 5000); S.inputs = S.inputs.filter(x => now - x < 5000);
  $('rates').textContent = S.frames.length || S.inputs.length ? `Caller ${(S.frames.length / 5).toFixed(1)}/s, Ody ${(S.inputs.length / 5).toFixed(1)}/s` : 'None yet';
  // the phone: paused picture, or why there is none
  const stale = p === 'live' && S.lastFrame && now - S.lastFrame > 3000;
  const pill = $('stale');
  pill.hidden = !(stale || p === 'reconnecting');
  pill.textContent = p === 'reconnecting' ? 'Feed lost, reconnecting' : 'Picture paused';
  $('idletext').textContent = p === 'live' ? 'Waiting for the camera' : p === 'ended' ? 'Call ended' : p === 'reconnecting' ? 'Reconnecting' : 'The caller’s camera shows here';
  stageMessage(p);
}
let lastMsg = '';
function stageMessage(p) {
  const [h, sub] = p === 'reconnecting' ? ['Reconnecting to the call feed.', 'This laptop lost the call’s stream. It retries by itself; nothing is lost.']
    : p === 'live' ? ['Show Ody your board.', 'Or hold anything up and say “scan this”.']
    : p === 'ended' ? (S.done ? ['Home. You made it to Ithaca.', 'The recap is saved. Everything Ody marked stays here to review.'] : ['The call has ended.', 'The recap is saved. Call Ody again to start a new voyage.'])
    : ['Every Telemachus deserves a Mentor.', 'FaceTime Ody, then hold your board up to the camera.'];
  const key = h + sub;
  if (key === lastMsg) return;
  lastMsg = key;
  $('waitTitle').textContent = h; $('waitSub').textContent = sub;
}

// ---------- the step, what Ody is doing, and the voyage ----------
function nowBox() {
  const p = phase();
  let mood, step;
  if (p === 'live') {
    mood = S.done ? 'Arrived' : { listening: 'Ody is listening', thinking: 'Ody is looking', speaking: 'Ody is talking' }[S.mood];
    step = S.done ? 'Home. You made it to Ithaca.' : S.step ? S.step.replace(/[.!?]?$/, '.') : 'Ody is on the call.';
  } else if (p === 'ended') { mood = 'Call ended'; step = S.done ? 'Home. You made it to Ithaca.' : S.step ? `Last step: ${S.step.replace(/[.!?]?$/, '.')}` : 'No steps this call.'; }
  else if (p === 'reconnecting') { mood = 'Reconnecting'; step = S.done ? 'Home. You made it to Ithaca.' : S.step ? S.step.replace(/[.!?]?$/, '.') : 'Waiting for the feed to come back.'; }
  else { mood = 'No call yet'; step = 'Call Ody to set sail.'; }
  $('mood').textContent = mood;
  const s = $('step'), prev = s.textContent;
  s.textContent = step;
  $('stepbox').classList.toggle('done', S.done);
  if (prev !== step) { s.classList.remove('swap'); void s.offsetWidth; s.classList.add('swap'); }
}
function mood(m, ms) {
  clearTimeout(S.moodTimer); S.mood = m; nowBox();
  if (ms) S.moodTimer = setTimeout(() => { S.mood = 'listening'; nowBox(); }, ms);
}

const SHOWN = 3;   // islands shown before older ones fold into one line
function renderSteps(arriving = false) {
  const ol = $('steps'), svg = $('sea');
  ol.replaceChildren(); svg.replaceChildren();
  const on = S.call === 'live' || S.call === 'ended';
  $('voyage').classList.toggle('empty', !on);
  const hiddenCount = Math.max(0, S.steps.length - SHOWN);
  const items = [];
  if (!hiddenCount) items.push({ cls: 'origin', text: on ? 'Set out' : 'Set out: the call starts', isle: 'done' });
  else items.push({ cls: 'earlier', text: `${hiddenCount} earlier island${hiddenCount === 1 ? '' : 's'}`, isle: 'done' });
  S.steps.slice(-SHOWN).forEach((t, i, arr) => {
    const now = i === arr.length - 1 && !S.done;
    items.push({ cls: now ? 'now' : 'done', text: t, isle: now ? 'now' : 'done' });
  });
  items.push({ cls: 'ithaca' + (S.done ? ' home' : ''), text: 'Ithaca', note: S.done ? 'reached' : 'the project, working', isle: 'ithaca' });
  for (const it of items) {
    const li = el('li', it.cls, it.text);
    if (it.note) li.append(el('small', '', it.note));
    if (it.cls === 'now') li.setAttribute('aria-current', 'step');
    ol.append(li);
  }
  // islands sit on each item's first line; the route wanders between them like a hand-drawn course
  const lis = [...ol.children];
  const pts = lis.map((li, i) => ({ x: [14, 22, 16, 24, 13][i % 5], y: li.offsetTop + 11 }));
  const P = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const segI = i => { const a = P(i - 1), b = P(i), c = P(i + 1), d = P(i + 2);
    return `C${b.x + (c.x - a.x) / 6} ${b.y + (c.y - a.y) / 6} ${c.x - (d.x - b.x) / 6} ${c.y - (d.y - b.y) / 6} ${c.x} ${c.y}`; };
  const course = (from, to) => `M${P(from).x} ${P(from).y}` + Array.from({ length: to - from }, (_, k) => segI(from + k)).join('');
  const nowIdx = S.done ? items.length - 1 : items.findIndex(it => it.isle === 'now');
  const cut = nowIdx < 0 ? 0 : nowIdx;
  if (pts.length > 1) {
    const sailedTo = arriving ? cut - 1 : cut;
    svg.append(sv('path', { class: 'water', d: course(0, pts.length - 1) }));
    if (sailedTo > 0) svg.append(sv('path', { class: 'wake', d: course(0, sailedTo) }));
    if (arriving && cut > 0) svg.append(sv('path', { class: 'wake landfall', pathLength: 1, d: course(cut - 1, cut) }));
    if (!S.done) svg.append(sv('path', { class: 'ahead', d: course(cut, pts.length - 1) }));
  }
  items.forEach((it, i) => {
    const p = pts[i];
    const r = it.isle === 'ithaca' ? 6 : it.cls === 'earlier' || it.cls === 'origin' ? 3.5 : 4.5;
    const cls = 'isle ' + it.isle + (it.isle === 'ithaca' && S.done ? ' home' + (arriving ? ' arriving' : '') : '');
    svg.append(sv('circle', { class: cls, cx: p.x, cy: p.y, r }));
    if (it.isle === 'now') svg.append(sv('circle', { class: 'eye', cx: p.x, cy: p.y, r: 9 }));
  });
}
function addStep(text) {
  if (!text || /^show me your project$/i.test(text) || /^done\./i.test(text)) return;
  const t = String(text).slice(0, 200);
  if (S.steps[S.steps.length - 1] !== t) S.steps.push(t);
  if (S.steps.length > 60) S.steps.shift();
}

// ---------- the conversation: the last few lines, all of them on request ----------
const FEW = 3;
function renderLog() {
  const log = $('log'), btn = $('logmore');
  log.replaceChildren();
  if (!S.lines.length) { log.append(el('p', 'empty', 'What the caller and Ody say shows up here.')); btn.hidden = true; return; }
  const shown = S.expanded ? S.lines : S.lines.slice(-FEW);
  for (const e of shown) {
    const mentor = e.type === 'say';
    const row = el('div', 'line ' + (mentor ? 'mentor' : 'you'));
    const text = el('p', 'text', String(e.text ?? '').slice(0, 600));
    if (mentor && Number.isFinite(e.ms) && e.ms > 0) text.append(el('span', 'meta', `answered in ${secs(e.ms)} s`));
    row.append(el('span', 'who', mentor ? 'Ody' : 'Caller'), text);
    log.append(row);
  }
  btn.hidden = S.lines.length <= FEW;
  btn.setAttribute('aria-expanded', String(S.expanded));
  btn.textContent = S.expanded ? 'Show the last few' : `Show all ${S.lines.length} lines`;
  log.classList.toggle('expanded', S.expanded);
  if (S.expanded) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}
function addLine(e) { S.lines.push(e); if (S.lines.length > 60) S.lines.shift(); renderLog(); }
$('logmore').addEventListener('click', () => { S.expanded = !S.expanded; renderLog(); });

// ---------- tester: marks on Ody's own picture ----------
function drawMarks() {
  const svg = $('eyemarks'), pts = $('points');
  svg.replaceChildren(); pts.replaceChildren();
  const t = S.turns[S.turns.length - 1];
  const w = S.input?.w || 1000, h = S.input?.h || 1000;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('preserveAspectRatio', 'none');
  if (!t) { pts.append(el('li', 'empty', 'No marks yet')); return; }
  const shown = $('eye').clientWidth;
  const u = shown > 40 ? 3 * w / shown : Math.min(w, h) / 100;
  const marks = (Array.isArray(t.marks) ? t.marks : []).filter(m => m && Number.isFinite(m.x) && Number.isFinite(m.y)).slice(0, 16);
  for (const m of marks) {
    const x = m.x * w, y = m.y * h;
    if (m.kind === 'wire' && m.x2 >= 0) svg.append(sv('line', { x1: x, y1: y, x2: m.x2 * w, y2: m.y2 * h, stroke: '#FFC845', 'stroke-width': u * 0.9, 'stroke-dasharray': `${u * 2.4} ${u * 1.4}` }));
    svg.append(sv('circle', { cx: x, cy: y, r: u * 4.2, fill: 'none', stroke: '#FFC845', 'stroke-width': u * 0.9 }));
    svg.append(sv('path', { d: `M${x - u * 1.6} ${y}H${x + u * 1.6}M${x} ${y - u * 1.6}V${y + u * 1.6}`, stroke: '#FFFFFF', 'stroke-width': u * 0.35 }));
    const li = el('li'); li.append(el('span', '', String(m.label || m.kind || 'mark').slice(0, 60)), el('span', '', `${m.kind || 'circle'}, x ${m.x.toFixed(2)}, y ${m.y.toFixed(2)}`));
    pts.append(li);
  }
  if (!marks.length) pts.append(el('li', 'empty', 'The latest answer pointed at nothing'));
}
function eyeNote() {
  const t = S.turns[S.turns.length - 1], n = (t?.marks || []).length;
  $('eyeNote').textContent = !t ? 'Marks from the latest answer appear here at their exact points.'
    : `Turn ${S.turns.length}, ${n} mark${n === 1 ? '' : 's'}, ${Math.round((Date.now() - (t._at || Date.now())) / 1000)} s ago` + (S.input ? `. Picture ${S.input.w} by ${S.input.h}` : '');
}
function renderTurns() {
  const ms = S.turns.map(t => Number(t.ms) || 0);
  $('nTurns').textContent = S.turns.length;
  $('nMarks').textContent = S.turns.reduce((n, t) => n + (Array.isArray(t.marks) ? t.marks.length : 0), 0);
  const sorted = [...ms].sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const withUnit = (node, v) => { node.replaceChildren(); if (!v) { node.textContent = '–'; return; } node.append(secs(v), el('small', '', 's')); };
  withUnit($('median'), med); withUnit($('last'), ms[ms.length - 1] || 0);
  const svg = $('spark'); svg.replaceChildren();
  const W = 360, H = 64, max = Math.max(SLOW * 1.25, ...ms);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
  const yS = H - (SLOW / max) * (H - 4);
  svg.append(sv('line', { x1: 0, x2: W, y1: yS, y2: yS, stroke: '#6E6688', 'stroke-dasharray': '3 4', 'vector-effect': 'non-scaling-stroke' }));
  const shown = ms.slice(-24), n = Math.max(shown.length, 12), bw = W / n;
  shown.forEach((v, i) => {
    const bh = Math.max(2, (v / max) * (H - 4));
    svg.append(sv('rect', { x: i * bw + bw * 0.18, y: H - bh, width: bw * 0.64, height: bh, rx: 2, fill: i === shown.length - 1 ? '#FFC845' : '#5C5478' }));
  });
  svg.setAttribute('aria-label', ms.length ? `Response time per turn, last ${secs(ms[ms.length - 1])} seconds, dashed line at ${SLOW / 1000} seconds` : 'No turns yet');
  const ul = $('turns'); ul.replaceChildren();
  if (!S.turns.length) { ul.append(el('li', 'empty', 'Each answer from the brain is listed here.')); return; }
  S.turns.slice(-12).reverse().forEach((t, i) => {
    const li = el('li');
    const tms = Number(t.ms) || 0, m = el('span', 'ms' + (tms > SLOW ? ' slow' : ''), tms ? secs(tms) + ' s' : '–');
    const what = el('span', 'what');
    const labels = (Array.isArray(t.marks) ? t.marks : []).map(k => k?.label).filter(Boolean).join(', ');
    what.append(document.createTextNode(String(labels || 'No marks').slice(0, 120)), el('em', '', `  ${t.model || BRAINS[t.brain] || t.brain || ''}${t.done ? ', done' : ''}`));
    what.title = (t.step ? t.step + '. ' : '') + (t.model || '');
    li.append(el('span', 'n', String(S.turns.length - i)), m, what);
    ul.append(li);
  });
}

// ---------- events ----------
function resetCall() {
  S.steps = []; S.turns = []; S.step = ''; S.done = false; S.input = null; S.lastFrame = 0; S.lines = []; S.expanded = false;
  renderLog(); renderSteps(); renderTurns(); drawMarks(); eyeNote(); nowBox();
  $('input').hidden = true; $('eyeNone').hidden = false;
}
function hideFrame() { document.body.classList.remove('has-frame'); $('phoneimg').hidden = true; }
function onCall(e) {
  if (e.state === 'live') {
    if (S.call !== 'live' || S.since !== (e.since || S.since)) { resetCall(); S.consent = null; }
    S.call = 'live'; S.since = Number(e.since) || Date.now(); mood('listening');
    S.replay = e.replay ? (typeof e.label === 'string' && e.label.trim() ? e.label.trim() : true) : null;
  } else if (e.state === 'ended') { S.call = 'ended'; S.replay = null; mood('listening'); hideFrame(); }
  else { S.call = null; S.replay = null; hideFrame(); }
  replayUi(); consentUi();
  renderSteps(); status(); nowBox();
}
const isB64 = s => typeof s === 'string' && s.length < 4_000_000 && /^[A-Za-z0-9+/=]+$/.test(s);
function handle(e) {
  switch (e.type) {
    case 'hello':
      S.call = null; resetCall();
      if (e.brain) S.brain = String(e.brain);
      if (e.call) onCall(e.call);
      { const c = typeof e.consent === 'string' ? e.consent : e.consent?.state; if (CONSENT[c]) { S.consent = c; consentUi(); } }
      (Array.isArray(e.turns) ? e.turns : []).forEach(t => { S.turns.push({ ...t, _at: Date.now() }); addStep(t.step); if (t.done) S.done = true; });
      if (e.step) { S.step = String(e.step); addStep(S.step); }
      S.lines = (Array.isArray(e.transcript) ? e.transcript : []).slice(-60);
      renderLog(); renderSteps(); renderTurns(); drawMarks(); nowBox(); status();
      break;
    case 'call': onCall(e); break;
    case 'brain': S.brain = String(e.brain || ''); status(); break;
    case 'consent': if (CONSENT[e.state]) { S.consent = e.state; consentUi(); } break;
    case 'frame':
      if (!isB64(e.jpeg) || S.call === 'ended') break;
      $('phoneimg').src = 'data:image/jpeg;base64,' + e.jpeg; $('phoneimg').hidden = false;
      document.body.classList.add('has-frame'); S.frames.push(Date.now()); S.lastFrame = Date.now();
      break;
    case 'input': {
      if (!isB64(e.jpeg)) break;
      const w = Number(e.w) || 0, h = Number(e.h) || 0;
      const sizeChanged = !S.input || S.input.w !== w || S.input.h !== h;
      S.input = { w, h }; S.inputs.push(Date.now());
      $('input').src = 'data:image/jpeg;base64,' + e.jpeg; $('input').hidden = false; $('eyeNone').hidden = true;
      if (sizeChanged && w && h) { $('eye').style.width = `min(100%, calc(40vh * ${w} / ${h}))`; requestAnimationFrame(drawMarks); }
      break;
    }
    case 'heard': if (typeof e.text === 'string') { addLine(e); mood('thinking', 12000); } break;
    case 'say': if (typeof e.text === 'string') { addLine(e); mood('speaking', Math.min(15000, 900 + e.text.length * 60)); } break;
    case 'step': {
      const text = String(e.text || '');
      const home = !!e.done || /^done\. you made it home/i.test(text), arriving = home && !S.done;
      S.step = text.slice(0, 200); if (home) S.done = true; else addStep(text);
      renderSteps(arriving); nowBox(); if (home) stageMessage(phase());
      break;
    }
    case 'turn':
      S.turns.push({ ...e, _at: Date.now() }); if (S.turns.length > 40) S.turns.shift();
      renderTurns(); drawMarks(); eyeNote(); status();
      break;
    default: break;
  }
}

// ---------- the socket ----------
let delay = 600;
function connect() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}`); } catch { retry(); return; }
  sock = ws;
  ws.onopen = () => { S.sock = true; S.everConnected = true; delay = 600; status(); nowBox(); emit({ type: '_sock', open: true }); };
  ws.onmessage = m => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    if (!e || typeof e !== 'object' || typeof e.type !== 'string') return;
    try { handle(e); } catch (err) { console.warn('[ody] event', e.type, err); }
    emit(e);
  };
  ws.onclose = () => { const was = S.sock; S.sock = false; if (was) emit({ type: '_sock', open: false }); retry(); };
}
function retry() { S.retryAt = Date.now() + delay; status(); nowBox(); setTimeout(connect, delay); delay = Math.min(delay * 1.6, 4000); }

// ---------- layout: swap the phone and the hologram, the tester drawer ----------
function setSwap(on) {
  document.body.classList.toggle('swapped', on);
  for (const b of document.querySelectorAll('[data-swap]')) b.setAttribute('aria-pressed', String(on));
  $('phone').setAttribute('aria-label', on ? 'The caller’s camera, large' : 'The caller’s camera');
  dispatchEvent(new Event('ody:layout'));
  store.set('ody.swap', on ? '1' : '');
}
export const swapped = () => document.body.classList.contains('swapped');
for (const b of document.querySelectorAll('[data-swap]')) b.addEventListener('click', () => setSwap(!swapped()));

let testerBack = null;
function setTester(on, { focus = true } = {}) {
  const panel = $('panel');
  if (on === !panel.hidden) return;
  panel.hidden = !on;
  $('t-tester').setAttribute('aria-expanded', String(on));
  if (on) { testerBack = document.activeElement; requestAnimationFrame(() => { drawMarks(); if (focus) $('panelclose').focus(); }); }
  else if (focus) (testerBack?.isConnected && testerBack !== document.body ? testerBack : $('t-tester')).focus();
  store.set('ody.tester', on ? '1' : '');
}
$('t-tester').addEventListener('click', () => setTester($('panel').hidden));
$('panelclose').addEventListener('click', () => setTester(false));
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 't') setTester($('panel').hidden);
  else if (k === 'v') setSwap(!swapped());
  else if (k === 'escape' && !$('panel').hidden) setTester(false);
  else return;
  e.preventDefault();
});
addEventListener('resize', () => { renderSteps(); drawMarks(); });

renderLog(); renderTurns(); drawMarks(); nowBox(); renderSteps(); status();
if (store.get('ody.swap')) setSwap(true);
if (store.get('ody.tester')) setTester(true, { focus: false });
setInterval(() => { status(); eyeNote(); }, 1000);
connect();

// for tests: the shell's view of the call
window.odyShell = { phase, state: () => ({ phase: phase(), call: S.call, step: S.step, done: S.done, steps: [...S.steps], lines: S.lines.length, swapped: swapped(), tester: !$('panel').hidden }) };
