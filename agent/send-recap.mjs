// Builds the voyage-log page (+ Wokwi sketch.ino/diagram.json) and sends the recap for one finished call:  node --env-file=../.env send-recap.mjs <runDir> [--no-send]
// The agent starts this detached when a call ends; you can re-run it by hand (it re-sends the iMessage).
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createBrain } from './brain.mjs';
import { reachedHome, recapText, sendRecap, writeRecapPage } from './recap.mjs';

const runDir = resolve(process.argv[2] || '') + '/';
const noSend = process.argv.includes('--no-send');
const saved = JSON.parse(await readFile(`${runDir}recap.json`, 'utf8'));
const brain = await createBrain({ task: saved.task || '', provider: saved.provider });
try { brain.messages = JSON.parse(await readFile(`${runDir}conversation.json`, 'utf8')); } catch { /* no turns */ }

let story = null;
try { story = await brain.finish(); } catch (e) { console.error('[recap] summary failed:', e?.status || '', e?.message || e); }
// "Home" leg only when the brain said the task was done during the call.
const done = reachedHome(brain.messages);
await writeRecapPage(runDir, story, saved.recap || [], { done });
const base = process.env.MENTOR_PUBLIC_URL?.replace(/\/$/, '');
const pageUrl = base ? `${base}/${basename(runDir)}/` : '';
const text = recapText(story, saved.recap || [], pageUrl, { done });
await writeFile(`${runDir}imessage.txt`, text);
console.log(`[recap] page ${runDir}index.html${pageUrl ? ` (${pageUrl})` : ''}`);
if (noSend) { console.log('[recap] --no-send: not texting'); process.exit(0); }
const result = await sendRecap(text);
console.log(`[recap] ${result.sent ? 'sent' : 'NOT sent'}: ${result.why || ''}`);
await writeFile(`${runDir}send-result.json`, JSON.stringify(result, null, 2));
