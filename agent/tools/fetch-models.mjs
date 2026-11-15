// Download the local model weights into agent/models/, pinned to an exact Hugging Face commit and
// verified by sha256. Skips files already present with the right hash; writes atomically (tmp + rename).
//   npm run fetch-models
// Licenses / attribution: models/LICENSES.md. Only Apache-2.0 Depth Anything V2 *Small* (Base/Large are CC-BY-NC).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MODELS = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');

const MODEL_FILES = [
  {
    file: 'depth-anything-v2-small.int8.onnx',
    url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_int8.onnx',
    sha256: '01aa7a23de3f4a0ee1a2bb9997e6918104c85a9f95dea46d27b9b3fb0c6b9001',
    bytes: 27258801,
  },
];

async function sha256Of(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function fetchOne({ file, url, sha256, bytes }) {
  const dest = join(MODELS, file);
  const have = await stat(dest).catch(() => null);
  if (have && have.size === bytes && (await sha256Of(dest)) === sha256) {
    console.log(`ok    ${file} already present`);
    return;
  }
  const tmp = `${dest}.${process.pid}.part`;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    const h = createHash('sha256');
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => h.update(c));
    await pipeline(body, createWriteStream(tmp));
    const got = h.digest('hex');
    if (got !== sha256) throw new Error(`sha256 mismatch for ${file}: got ${got}, want ${sha256}`);
    await rename(tmp, dest);
    console.log(`ok    ${file} downloaded (${((await stat(dest)).size / 1e6).toFixed(1)} MB, sha256 verified)`);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

await mkdir(MODELS, { recursive: true });
let failed = 0;
for (const m of MODEL_FILES) {
  try { await fetchOne(m); } catch (e) { failed++; console.error(`FAIL  ${m.file}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
