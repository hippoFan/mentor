// Is the Chert line ready?  npm run status   (needs CHERT_API_KEY + CHERT_PROJECT_ID in ../.env)
// Prints each line's id, number and every readiness/media flag. Another team saw audio_ready:false on a trial
// line (no audio either way); if you see that, ask Chert for another line before debugging the agent.
import { chertLines } from './recap.mjs';

if (!process.env.CHERT_API_KEY || !process.env.CHERT_PROJECT_ID) {
  console.error('Set CHERT_API_KEY (Developer page, starts with ftk_) and CHERT_PROJECT_ID in mentor/.env');
  process.exit(3);
}
let lines;
try { lines = await chertLines(); }
catch (error) {
  console.error(`Chert said: ${String(error.message).slice(0, 200)}`);
  // Shape only, never values.
  const k = process.env.CHERT_API_KEY, p = process.env.CHERT_PROJECT_ID;
  const odd = v => /[\s"'<>]/.test(v) ? 'HAS SPACES/QUOTES' : 'clean';
  console.error(`  key: starts "${k.slice(0, 4)}", ${k.length} chars, ${odd(k)}   (expected: starts "ftk_")`);
  console.error(`  project id: ${p.length} chars, ${odd(p)}, looks like a UUID? ${/^[0-9a-f-]{32,36}$/i.test(p)}`);
  process.exit(1);
}
if (!lines.length) console.log('No lines on this project yet.');
for (const l of lines) {
  const flags = Object.entries(l).filter(([k, v]) => typeof v === 'boolean' || /ready|status|video|audio|capture|media|state|plan/i.test(k));
  console.log(`line ${l.id}  ${l.phone_number || l.number || l.handle || ''}`);
  for (const [k, v] of flags) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  if (l.audio_ready === false) console.log('  !! audio_ready is false: calls will be silent. Ask Chert (Gary) for another line.');
}
