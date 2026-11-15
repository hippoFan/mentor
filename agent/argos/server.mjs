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
//   POST   /argos/import?name=<file.ext>      raw file body  -> design
//   GET    /argos/keys   POST /argos/keys {name, value}
//   GET    /argos/usage                       ElevenLabs credits + this hub's Argos call counts
import { randomBytes } from 'node:crypto';
import { createChat } from './chat.mjs';
import { deleteDesign, designFile, FORGE, getDesign, importFile, listDesigns, saveRefined, saveScan } from './forge.mjs';
import { keyStatus, setKey } from './keys.mjs';
import { providers, PROVIDER_IDS } from './providers.mjs';
import { MODES, refine } from './refine.mjs';
import { compileScad, scanToScad } from './scad.mjs';
import { STT, transcribe } from './stt.mjs';

const FILE_TYPES = { 'source.scad': 'text/plain; charset=utf-8', 'model.stl': 'model/stl', 'model.obj': 'text/plain; charset=utf-8',
  'model.glb': 'model/gltf-binary', 'photo.jpg': 'image/jpeg', 'spec.json': 'application/json; charset=utf-8' };
const cap = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(JSON.stringify(body));
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

  async function startRefine({ instruction, designId, mode = 'single', provider, code }) {
    const design = await getDesign(designId);
    if (!design) throw Object.assign(new Error('Pick a design first.'), { status: 404 });
    if (running >= 2) throw Object.assign(new Error('Two refinements are already running. Wait for one to finish.'), { status: 429 });
    let src = typeof code === 'string' && code.trim() ? code : null;
    if (!src) src = (await designFile(designId, 'source.scad'))?.toString('utf8') || null;
    if (!src && design.kind === 'scan') { const spec = await designFile(designId, 'spec.json'); if (spec) src = scanToScad(JSON.parse(spec)); }
    if (!src) throw Object.assign(new Error(design.outside
      ? `This ${design.format?.toUpperCase() || ''} file was made outside Ody and has no OpenSCAD source, so Argos can't edit it yet. Import a .scad file to refine it.`
      : 'This design has no OpenSCAD source to refine.'), { status: 422 });
    const jobId = randomBytes(6).toString('hex');
    const m = MODES.includes(mode) ? mode : 'single';
    jobs.set(jobId, { state: 'running', designId });
    running++; counts.refine++; if (m === 'multicode') counts.multicode++;
    send({ type: 'argos', kind: 'refine', jobId, state: 'started', mode: m, designId, instruction: cap(instruction, 300) });
    void refine({ code: src, instruction, mode: m, provider, design: { name: design.name, parts: design.parts },
      onProgress: step => send({ type: 'argos', kind: 'refine', jobId, state: 'step', step }) })
      .then(async r => {
        counts.modelCalls += r.calls || 0;
        if (!r.ok) { jobs.set(jobId, { state: 'failed' }); send({ type: 'argos', kind: 'refine', jobId, state: 'failed', error: cap(r.error, 300), steps: r.steps }); return; }
        const saved = await saveRefined({ parent: designId, name: `${design.name} (refined)`, code: r.code, stl: r.stl, summary: r.summary, caveats: r.caveats, mode: m, provider: r.provider });
        jobs.set(jobId, { state: 'done', designId: saved.id });
        send({ type: 'argos', kind: 'refine', jobId, state: 'done', design: saved, summary: r.summary, caveats: r.caveats, calls: r.calls, ms: r.ms });
      })
      .catch(e => { jobs.set(jobId, { state: 'failed' }); send({ type: 'argos', kind: 'refine', jobId, state: 'failed', error: cap(e?.message || e, 200) }); })
      .finally(() => { running--; });
    return { jobId };
  }

  const chat = createChat({ send, startRefine });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname, method = req.method;
    try {
      if (method === 'GET' && p === '/argos/state') {
        return json(res, 200, { providers: providers(), keys: keyStatus(), call: callLive(), designs: (await listDesigns()).length, modes: MODES, counts });
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
        return res.writeHead(200, { 'content-type': FILE_TYPES[m[2]], 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${m[1]}-${m[2]}"` }).end(body);
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
        const b = await readJson(req);
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
      if (e?.type === 'scan' && e.spec) void saveScan(e).then(d => d && send({ type: 'argos', kind: 'design', design: d })).catch(err => console.warn('[argos] save scan failed', err?.message));
      if (e?.type === 'circuit' && e.state) chat.setCircuit(e.state);
    },
    /** Validated page messages (live.mjs): Argos keeps the latest 3D stage parts for "remove the reset button". */
    onPageMessage(m) { if (m?.type === 'parts') chat.setParts(m.parts); },
  };
}
