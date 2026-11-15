// Argos's HTTP routes, mounted on the laptop page's own server (live.mjs, via hub.mjs) under /argos/. Same rules as the
// page: 127.0.0.1 only, Host checked by live.mjs, and every non-GET request must come from the page's own Origin.
// Long work (refinement) answers 202 with a job id and streams progress to the page as {type:'argos'} events.
//
//   GET    /argos/state                       providers, keys (masked), call status, design count
//   POST   /argos/chat      {text, provider?, designId?}
//   POST   /argos/stt       raw audio body (audio/webm|ogg|mp4|wav)  -> {text}
//   POST   /argos/refine    {designId, instruction, mode: single|multicode, provider?, code?}  -> 202 {jobId}
//   GET    /argos/designs                     list (newest first)
//   GET    /argos/designs/<id>/<file>         source.scad | model.stl | model.obj | model.glb | photo.jpg | spec.json
//   DELETE /argos/designs/<id>
//   POST   /argos/designs/<id>/schematic      draw that design's circuit (tscircuit): schematic + routed PCB + KiCad + netlist
//   GET    /argos/designs/<id>/schematic/<f>  schematic.svg | pcb.svg | netlist.json | ody-circuit.kicad_sch|_pcb|_pro
//   POST   /argos/import?name=<file.ext>      raw file body  -> design
//   GET    /argos/keys                        which keys are set + last 4 characters (never a key)
//   POST   /argos/keys      {name, value}     set/clear one allowlisted key in .env (write-only, page Origin only, keys.mjs)
//   GET    /argos/usage                       ElevenLabs credits + this hub's Argos call counts
import { randomBytes } from 'node:crypto';
import { blueprint, circuitKey, drawingsAvailable, netlist } from '../blueprint.mjs';
import { createChat } from './chat.mjs';
import { deleteDesign, designCircuit, designFile, FORGE, getDesign, importFile, listDesigns, LIVE_CIRCUIT_ID, pruneCallScans, saveRefined, saveScan,
  saveSchematic, SCHEMATIC_FILES, schematicFile, schematicInfo } from './forge.mjs';
import { keyStatus, setKey } from './keys.mjs';
import { providers, PROVIDER_IDS } from './providers.mjs';
import { MODES, refine } from './refine.mjs';
import { compileScad, scanToScad } from './scad.mjs';
import { STT, transcribe } from './stt.mjs';

const FILE_TYPES = { 'source.scad': 'text/plain; charset=utf-8', 'model.stl': 'model/stl', 'model.obj': 'text/plain; charset=utf-8',
  'model.glb': 'model/gltf-binary', 'photo.jpg': 'image/jpeg', 'spec.json': 'application/json; charset=utf-8' };
// POST /argos/keys: only the page this server serves (http://localhost:PORT or 127.0.0.1:PORT), never another site.
const pagePort = () => Number(process.env.MENTOR_MONITOR_PORT || 8790);
function pageOrigin(req) {
  const port = pagePort(), ok = [`localhost:${port}`, `127.0.0.1:${port}`];
  const origin = String(req.headers.origin || ''), hostHdr = String(req.headers.host || '');
  if (!ok.includes(hostHdr) || !ok.map(h => `http://${h}`).includes(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin';
}
const keyHits = [];
function keyBudget(max = 60, ms = 60_000) {   // at most 60 key changes a minute
  const now = Date.now(); while (keyHits.length && now - keyHits[0] > ms) keyHits.shift();
  if (keyHits.length >= max) return false; keyHits.push(now); return true;
}
// Schematics: tscircuit output is trusted as little as model output. Each file is size-capped; SVGs lose scripts, event
// attributes, foreignObject and javascript: links before they're saved and again before they're served, and are served
// with a sandbox CSP (the page shows them with <img>, which runs nothing anyway).
const SCHEMATIC = { maxFile: 6 * 1024 * 1024, timeout: 30_000 };
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";
const cleanSvg = s => String(s)
  .replace(/<script[\s\S]*?(?:<\/script\s*>|$)/gi, '').replace(/<foreignObject[\s\S]*?(?:<\/foreignObject\s*>|$)/gi, '')
  .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/((?:xlink:)?href\s*=\s*["']?)\s*javascript:/gi, '$1#');
const cap = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// same-origin CORP: another website can't embed a design's photo or files, even with a guessed id.
const HDR = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...HDR }).end(JSON.stringify(body));
async function readJson(req, max = 16 * 1024) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('JSON only'), { status: 415 });
  try { return JSON.parse(String(await readBody(req, max))); } catch (e) { throw Object.assign(new Error('bad JSON'), { status: e.status || 400 }); }
}

/**
 * @param {{send: (e: object) => void, callLive?: () => boolean}} io
 * @returns {{route: (req, res) => Promise<void>, onPublished: (e: object) => void, onPageMessage: (m: object) => void}}
 */
export function createArgos({ send, callLive = () => false }) {
  const jobs = new Map();   // jobId -> {state, designId}
  const counts = { chat: 0, refine: 0, multicode: 0, stt: 0, modelCalls: 0 };
  let running = 0;
  // Privacy (PRIVACY.md): a call's scans are kept like its call folder, deleted after KEEP_DAYS, and none are saved once
  // the caller said "stop recording" or declined. Reset when a new call goes live.
  let saveScans = true;
  void pruneCallScans();

  // create: true (from chat only, "make a phone stand 80 mm wide") starts a new design from scratch, with no parent.
  async function startRefine({ instruction, designId, mode = 'single', provider, code, create = false, name = '' }) {
    const design = create ? { name: cap(name, 40) || 'New design', parts: [] } : await getDesign(designId);
    if (!design) throw Object.assign(new Error('Pick a design first.'), { status: 404 });
    if (running >= 2) throw Object.assign(new Error('Two refinements are already running. Wait for one to finish.'), { status: 429 });
    let src = create ? '' : typeof code === 'string' && code.trim() ? code : null;
    if (!src && !create) src = (await designFile(designId, 'source.scad'))?.toString('utf8') || null;
    if (!src && !create && design.kind === 'scan') { const spec = await designFile(designId, 'spec.json'); if (spec) src = scanToScad(JSON.parse(spec)); }
    if (!src && !create) throw Object.assign(new Error(design.outside
      ? `This ${design.format?.toUpperCase() || ''} file was made outside Ody and has no OpenSCAD source, so Argos can't edit it yet. Import a .scad file to refine it.`
      : 'This design has no OpenSCAD source to refine.'), { status: 422 });
    const jobId = randomBytes(6).toString('hex');
    const m = MODES.includes(mode) ? mode : 'single';
    jobs.set(jobId, { state: 'running', designId: create ? null : designId });
    running++; counts.refine++; if (m === 'multicode') counts.multicode++;
    send({ type: 'argos', kind: 'refine', jobId, state: 'started', mode: m, designId: create ? null : designId, instruction: cap(instruction, 300), ...(create ? { create: true } : {}) });
    void refine({ code: src, instruction, mode: m, provider, create, design: { name: design.name, parts: design.parts },
      onProgress: step => send({ type: 'argos', kind: 'refine', jobId, state: 'step', step }) })
      .then(async r => {
        counts.modelCalls += r.calls || 0;
        if (!r.ok) { jobs.set(jobId, { state: 'failed' }); send({ type: 'argos', kind: 'refine', jobId, state: 'failed', error: cap(r.error, 300), steps: r.steps }); return; }
        const saved = await saveRefined({ parent: create ? null : designId, name: create ? design.name : `${design.name} (refined)`, code: r.code, stl: r.stl, summary: r.summary, caveats: r.caveats, mode: m, provider: r.provider });
        jobs.set(jobId, { state: 'done', designId: saved.id });
        send({ type: 'argos', kind: 'refine', jobId, state: 'done', design: saved, summary: r.summary, caveats: r.caveats, calls: r.calls, ms: r.ms });
      })
      .catch(e => { jobs.set(jobId, { state: 'failed' }); send({ type: 'argos', kind: 'refine', jobId, state: 'failed', error: cap(e?.message || e, 200) }); })
      .finally(() => { running--; });
    return { jobId };
  }

  const chat = createChat({ send, startRefine });

  // POST /argos/designs/<id>/schematic: on demand only. The same circuit again returns the saved run at once.
  // One run at a time (tscircuit routes on this process's thread, ~1-2 s): requests queue, so a second click on the same
  // circuit gets the first one's saved result; more than 3 waiting -> 429.
  let queue = Promise.resolve(), waiting = 0;
  function queueSchematic(id) {
    if (waiting >= 3) throw Object.assign(new Error('Schematics are already being drawn. Try again in a moment.'), { status: 429 });
    waiting++;
    const run = queue.then(() => drawSchematic(id)).finally(() => { waiting--; });
    queue = run.catch(() => {});
    return run;
  }
  async function drawSchematic(id) {
    const live = id === LIVE_CIRCUIT_ID;
    if (!live && !(await getDesign(id))) throw Object.assign(new Error('That design is gone.'), { status: 404 });
    const st = live ? chat.circuit : await designCircuit(id);
    if (!st?.components?.length) throw Object.assign(new Error('This design has no circuit to draw yet.'), { status: 422 });
    const nets = netlist(st), key = circuitKey(st), base = `/argos/designs/${id}/schematic/`;
    const out = (info, extra = {}) => {
      const url = f => (info.files.includes(f) ? base + f : null);
      return { schematicUrl: url('schematic.svg'), pcbUrl: url('pcb.svg'), netlistUrl: url('netlist.json'),
        kicad: { sch: url('ody-circuit.kicad_sch'), pcb: url('ody-circuit.kicad_pcb'), pro: url('ody-circuit.kicad_pro') },
        netlist: nets, traces: info.traces, errors: info.errors, ms: info.ms, ...extra };
    };
    const prev = await schematicInfo(id);
    if (prev?.key === key && prev.files?.includes('schematic.svg')) return out(prev, { cached: true });
    if (!(await drawingsAvailable())) throw Object.assign(new Error('Schematics need the optional drawing library (cd agent/blueprint && npm ci).'), { status: 503, netlist: nets });
    const bp = await blueprint(st, { timeout: SCHEMATIC.timeout });
    if (!bp) throw Object.assign(new Error("Ody couldn't draw this circuit (it failed or took too long). Try again."), { status: 504, netlist: nets });
    const fit = s => (typeof s === 'string' && Buffer.byteLength(s) <= SCHEMATIC.maxFile ? s : null);
    const files = { 'schematic.svg': fit(bp.schematicSvg) && cleanSvg(bp.schematicSvg), 'pcb.svg': fit(bp.pcbSvg) && cleanSvg(bp.pcbSvg),
      'ody-circuit.kicad_sch': fit(bp.kicad?.sch), 'ody-circuit.kicad_pcb': fit(bp.kicad?.pcb), 'ody-circuit.kicad_pro': fit(bp.kicad?.pro),
      'netlist.json': JSON.stringify({ board: st.board, nets }, null, 2) };
    if (!files['schematic.svg']) throw Object.assign(new Error('The schematic came out too large to save.'), { status: 413, netlist: nets });
    const info = { key, traces: Number(bp.traces) || 0, errors: (bp.errors || []).map(e => cap(e, 200)).slice(0, 5), ms: Number(bp.ms) || 0, at: Date.now() };
    await saveSchematic(id, files, info);
    return out({ ...info, files: Object.keys(files).filter(n => files[n]) });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname, method = req.method;
    try {
      if (method === 'GET' && p === '/argos/state') {
        return json(res, 200, { providers: providers(), keys: keyStatus(), call: callLive(), designs: (await listDesigns()).length, modes: MODES, counts, uptime: Math.round(process.uptime()) });
      }
      if (method === 'POST' && p === '/argos/chat') {
        const b = await readJson(req);
        const provider = PROVIDER_IDS.includes(b.provider) ? b.provider : undefined;
        const design = b.designId ? await getDesign(b.designId) : null;
        counts.chat++;
        return json(res, 200, await chat.say(b.text, { provider, designId: design?.id, design }));
      }
      if (method === 'POST' && p === '/argos/stt') {
        const buf = await readBody(req, STT.maxBytes);
        counts.stt++;
        const r = await transcribe(buf, req.headers['content-type']);
        return json(res, 200, r);
      }
      if (method === 'POST' && p === '/argos/refine') {
        const b = await readJson(req, 80 * 1024);
        return json(res, 202, await startRefine({ instruction: cap(b.instruction, 600), designId: String(b.designId || ''), mode: b.mode,
          provider: PROVIDER_IDS.includes(b.provider) ? b.provider : undefined, code: typeof b.code === 'string' ? b.code : undefined }));
      }
      if (method === 'GET' && p === '/argos/designs') return json(res, 200, { designs: await listDesigns() });
      let m = p.match(/^\/argos\/designs\/([a-z0-9-]{8,40})\/([a-z]+\.[a-z]+)$/);
      if (method === 'GET' && m) {
        const body = await designFile(m[1], m[2]);
        if (!body || !FILE_TYPES[m[2]]) return json(res, 404, { error: 'not found' });
        return res.writeHead(200, { 'content-type': FILE_TYPES[m[2]], ...HDR,
          'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${m[1]}-${m[2]}"` }).end(body);
      }
      m = p.match(/^\/argos\/designs\/([a-z0-9-]{8,40})\/schematic\/([a-z-]+\.(?:svg|json|kicad_sch|kicad_pcb|kicad_pro))$/);
      if (method === 'GET' && m) {
        const type = SCHEMATIC_FILES[m[2]], body = type && await schematicFile(m[1], m[2]);
        if (!body) return json(res, 404, { error: 'not found' });
        const svg = type === 'image/svg+xml';
        return res.writeHead(200, { 'content-type': type, ...HDR, ...(svg ? { 'content-security-policy': SVG_CSP } : {}),
          'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${m[2]}"` }).end(svg ? cleanSvg(body) : body);
      }
      m = p.match(/^\/argos\/designs\/([a-z0-9-]{8,40})\/schematic$/);
      if (method === 'POST' && m) {
        req.resume();
        if (!pageOrigin(req)) return json(res, 403, { error: 'Only the Ody page on this laptop can draw schematics.' });
        try { return json(res, 200, await queueSchematic(m[1])); }
        catch (e) { return json(res, e?.status || 400, { error: cap(e?.message || 'failed', 300), ...(e?.netlist ? { netlist: e.netlist } : {}) }); }
      }
      m = p.match(/^\/argos\/designs\/([a-z0-9-]{8,40})$/);
      if (method === 'DELETE' && m) return json(res, (await deleteDesign(m[1])) ? 200 : 404, {});
      m = p.match(/^\/argos\/designs\/([a-z0-9-]{8,40})\/compile$/);
      if (method === 'POST' && m) {   // (re)build an STL from a design's OpenSCAD source, e.g. a scan before any refinement
        const src = (await designFile(m[1], 'source.scad'))?.toString('utf8');
        if (!src) return json(res, 422, { error: 'This design has no OpenSCAD source.' });
        const c = await compileScad(src);
        if (!c.ok) return json(res, 422, { error: c.error });
        const d = await getDesign(m[1]);
        const saved = await saveRefined({ parent: m[1], name: d.name, code: src, stl: c.stl, summary: 'Built from the original design.', mode: 'build' });
        return json(res, 200, { design: saved, ms: c.ms });
      }
      if (method === 'POST' && p === '/argos/import') {
        const buf = await readBody(req, FORGE.maxImport);
        const d = await importFile(url.searchParams.get('name') || '', buf);
        send({ type: 'argos', kind: 'design', design: d });
        return json(res, 200, { design: d });
      }
      if (method === 'GET' && p === '/argos/keys') return json(res, 200, { keys: keyStatus(), providers: providers() });
      if (method === 'POST' && p === '/argos/keys') {
        // Write-only key entry from the Main page (keys.mjs): this page's Origin and Host only (live.mjs checks too),
        // same-origin fetch, JSON <= 2 KB, an allowlisted name, a validated value. Never echoes or logs the value.
        if (!pageOrigin(req)) { req.resume(); return json(res, 403, { error: 'Only the Ody page on this laptop can set keys.' }); }
        if (Number(req.headers['content-length']) > 2 * 1024) { req.resume(); return json(res, 413, { error: 'Too large.' }); }
        const b = await readJson(req, 2 * 1024);
        if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => k !== 'name' && k !== 'value')) return json(res, 400, { error: 'Send {name, value} only.' });
        if (!keyBudget()) return json(res, 429, { error: 'Too many changes. Wait a minute.' });
        return json(res, 200, { key: await setKey(String(b.name || ''), b.value), providers: providers() });
      }
      if (method === 'GET' && p === '/argos/usage') {
        let eleven = null;
        try { const { elevenUsage } = await import('../usage.mjs'); eleven = await elevenUsage(); } catch { /* no key or offline */ }
        return json(res, 200, { eleven, argos: counts });
      }
      if (method === 'GET' && p.startsWith('/argos/jobs/')) {
        const j = jobs.get(p.slice(12));
        return json(res, j ? 200 : 404, j || {});
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e?.status || 400;
      return json(res, status, { error: cap(e?.message || 'failed', 300) });
    }
  }

  return {
    route,
    /** Every event a call publishes (hub.mjs): scans become Forge designs; the call's circuit seeds Argos's. */
    onPublished(e) {
      if (e?.type === 'call' && e.state === 'live') saveScans = true;
      if (e?.type === 'consent' && (e.state === 'no-recording' || e.state === 'declined')) saveScans = false;
      if (e?.type === 'scan' && e.spec && saveScans) void saveScan(e).then(d => d && send({ type: 'argos', kind: 'design', design: d })).catch(err => console.warn('[argos] save scan failed', err?.message));
      if (e?.type === 'circuit' && e.state) chat.setCircuit(e.state);
    },
    /** Validated page messages (live.mjs): Argos keeps the latest 3D stage parts for "remove the reset button". */
    onPageMessage(m) { if (m?.type === 'parts') chat.setParts(m.parts); },
  };
}
