// The Forge's store: every design on this laptop, in ../designs/<id>/ (git-ignored, local only).
//   from a call    each scan Ody makes is saved automatically (the hub sees the 'scan' event), with its photo
//   refined        each successful Argos refinement is saved as a new version (OpenSCAD source + STL), linked to its parent
//   imported       files the user brings from their own computer (STL, OBJ, GLB, OpenSCAD). Marked outside: true,
//                  because Ody can't guarantee that CAD made elsewhere converts or edits cleanly.
//
//   await saveScan(event)  await saveRefined({...})  await importFile(name, buf)  await listDesigns()  await getDesign(id)
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { scanToScad } from './scad.mjs';
import { KEEP_DAYS } from '../consent.mjs';

import { pathToFileURL } from 'node:url';
// ARGOS_DESIGNS_DIR moves the store (tests use a scratch folder).
export const DESIGNS = process.env.ARGOS_DESIGNS_DIR ? pathToFileURL(process.env.ARGOS_DESIGNS_DIR.replace(/\/?$/, '/')) : new URL('../../designs/', import.meta.url);
export const FORGE = { maxImport: 15 * 1024 * 1024, maxDesigns: 500, nameLen: 60 };
export const IMPORT_TYPES = { stl: 'model/stl', obj: 'model/obj', glb: 'model/gltf-binary', scad: 'text/plain' };
export const OUTSIDE_NOTE = 'Made outside Ody. Viewing and exporting work; AI edits may not convert this file cleanly.';

const cap = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>"'`\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ID = /^[a-z0-9-]{8,40}$/;
const newId = kind => `${new Date().toISOString().slice(0, 10)}-${kind}-${randomBytes(4).toString('hex')}`;
const dir = id => new URL(`${id}/`, DESIGNS);

async function write(id, meta, files) {
  await mkdir(dir(id), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(new URL(name, dir(id)), body);
  await writeFile(new URL('meta.json', dir(id)), JSON.stringify({ ...meta, id }, null, 2));
  return { ...meta, id };
}

/**
 * Retention (PRIVACY.md): designs saved from a call (its scans, with the camera photo) are deleted after KEEP_DAYS
 * (ODY_KEEP_DAYS, default 7), like the call folder. Refinements and imports the laptop user made are kept. Never throws.
 * @returns {Promise<string[]>} the ids deleted
 */
export async function pruneCallScans({ days = KEEP_DAYS, now = Date.now() } = {}) {
  const keep = Math.max(1, Number(days) || 7) * 86_400_000, deleted = [];
  let ids = [];
  try { ids = (await readdir(DESIGNS)).filter(d => ID.test(d)); } catch { return deleted; }
  for (const id of ids) {
    const meta = await getDesign(id);
    if (meta?.source !== 'call' || !(now - Number(meta.at) > keep)) continue;
    try { await rm(dir(id), { recursive: true, force: true }); deleted.push(id); } catch { /* try again next time */ }
  }
  if (deleted.length) console.log(`[argos] deleted ${deleted.length} call scan(s) older than ${days} days`);
  return deleted;
}

/** Saves a call's scan ({type:'scan', spec, photo}) as a design with editable OpenSCAD. */
export async function saveScan(ev) {
  if (!ev?.spec?.parts) return null;
  void pruneCallScans();
  const spec = ev.spec, id = newId('scan');
  const files = { 'spec.json': JSON.stringify(spec), 'source.scad': scanToScad(spec) };
  if (typeof ev.photo === 'string' && ev.photo.length < 4_000_000) files['photo.jpg'] = Buffer.from(ev.photo, 'base64');
  return write(id, { kind: 'scan', name: cap(spec.name, FORGE.nameLen) || 'Scan', at: Date.now(), source: 'call',
    parts: spec.parts.map(p => cap(p.name, 40)).slice(0, 60), dims: spec.dims_mm || null, outside: false,
    files: Object.keys(files), estimate: 'AI estimate from one camera view' }, files);
}

/** Saves a refinement result as a new version. */
export async function saveRefined({ parent, name, code, stl, summary, caveats = [], mode, provider }) {
  const id = newId('refined');
  const files = { 'source.scad': String(code) };
  if (stl) files['model.stl'] = stl;
  return write(id, { kind: 'refined', name: cap(name, FORGE.nameLen) || 'Refined design', at: Date.now(), source: 'argos',
    parent: ID.test(parent || '') ? parent : null, summary: cap(summary, 300), caveats: caveats.map(c => cap(c, 160)).slice(0, 4),
    mode: cap(mode, 12), provider: cap(provider, 12), outside: false, files: Object.keys(files) }, files);
}

/** Imports a file from the user's computer. Throws a user-readable Error if the file isn't acceptable. */
export async function importFile(filename, buf) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (!IMPORT_TYPES[ext]) throw new Error('Ody can import .stl, .obj, .glb and .scad files.');
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('The file is empty.');
  if (buf.length > FORGE.maxImport) throw new Error(`The file is larger than ${FORGE.maxImport / 1024 / 1024} MB.`);
  if (ext === 'glb' && buf.subarray(0, 4).toString('latin1') !== 'glTF') throw new Error('That .glb file is not a valid glTF binary.');
  if (ext === 'stl' && buf.length < 84) throw new Error('That .stl file is too short to be a model.');
  if ((ext === 'obj' || ext === 'scad') && buf.includes(0)) throw new Error(`That .${ext} file isn't plain text.`);
  const name = cap(String(filename).replace(/\.[^.]+$/, ''), FORGE.nameLen) || 'Imported design';
  const file = ext === 'scad' ? 'source.scad' : `model.${ext}`;
  return write(newId('import'), { kind: 'imported', name, at: Date.now(), source: 'computer', format: ext,
    outside: true, note: OUTSIDE_NOTE, files: [file] }, { [file]: buf });
}

/** All designs, newest first (metadata only). */
export async function listDesigns() {
  let ids = [];
  try { ids = (await readdir(DESIGNS)).filter(d => ID.test(d)); } catch { return []; }
  const out = [];
  for (const id of ids.slice(-FORGE.maxDesigns)) {
    try { out.push(JSON.parse(await readFile(new URL('meta.json', dir(id)), 'utf8'))); } catch { /* half-written: skip */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** One design's metadata, or null. */
export async function getDesign(id) {
  if (!ID.test(String(id))) return null;
  try { return JSON.parse(await readFile(new URL('meta.json', dir(id)), 'utf8')); } catch { return null; }
}

/** One of a design's files (only names it lists), or null. */
export async function designFile(id, name) {
  const meta = await getDesign(id);
  if (!meta || !meta.files?.includes(name)) return null;
  try { return await readFile(new URL(name, dir(id))); } catch { return null; }
}

export async function deleteDesign(id) {
  if (!(await getDesign(id))) return false;
  await rm(dir(id), { recursive: true, force: true });
  return true;
}
