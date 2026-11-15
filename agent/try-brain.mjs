// Test the brain on a still photo, no call needed:  npm run try-brain -- photo.jpg "how do I make it blink?"
// Writes <photo>.mentor.png with the marks drawn on (pin marks snapped to the board, as in a call). Each run is one paid request.
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createBrain } from './brain.mjs';
import { render, snapshotPng, frameJpeg } from './overlay.mjs';
import { createMarkTracker } from './tracker.mjs';

const [photo, ...words] = process.argv.slice(2);
if (!photo) { console.error('usage: npm run try-brain -- <photo> "<what you would say>"'); process.exit(2); }
const img = await loadImage(await readFile(photo));
const c = createCanvas(img.width, img.height); c.getContext('2d').drawImage(img, 0, 0);
const d = c.getContext('2d').getImageData(0, 0, img.width, img.height);
const frame = { data: new Uint8Array(d.data.buffer), width: img.width, height: img.height };
const brain = await createBrain({ task: process.env.MENTOR_TASK || '' });
console.log(`brain: ${brain.provider}`);
const reply = await brain.turn(words.join(' ') || 'What am I looking at?', await frameJpeg(frame));
console.log(JSON.stringify(reply, null, 2));
const tracker = createMarkTracker();
tracker.seed(frame, reply.marks, reply.board);
console.log(`board registered: ${tracker.board ? 'yes' : 'no'}`);
render(frame, tracker.update(frame), { caption: reply.step });
await writeFile(`${photo}.mentor.png`, await snapshotPng());
console.log(`wrote ${photo}.mentor.png`);
await brain.close?.();
