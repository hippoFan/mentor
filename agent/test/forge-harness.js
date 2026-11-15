// Test harness for The Forge: one page socket with shell.js-style subscribe() (late subscribers get the hello and every
// event since), the ornament sprite inlined, and an openRefine() stand-in that records its calls for the test.
import { mountForge } from '/twin/forge.js';

const listeners = new Set(); let history = [];
function subscribe(fn) {
  listeners.add(fn);
  for (const e of history) { try { fn(e); } catch (err) { console.warn('[harness] listener', err); } }
  return () => listeners.delete(fn);
}
function emit(e) {
  if (e.type === 'hello') history = [e]; else { history.push(e); if (history.length > 400) history.splice(1, 1); }
  for (const fn of listeners) { try { fn(e); } catch (err) { console.warn('[harness] listener', err); } }
}
function connect() {
  const ws = new WebSocket(`ws://${location.host}/`);
  ws.onmessage = m => { try { emit(JSON.parse(m.data)); } catch { /* not JSON */ } };
  ws.onclose = () => setTimeout(connect, 1000);
}

window.__refineCalls = [];
async function start() {
  try {   // the sprite is our own static file, same origin
    const svg = await (await fetch('/twin/ornaments.svg')).text();
    document.getElementById('sprite').innerHTML = svg;
  } catch { /* ornaments are decoration */ }
  connect();
  window.__forge = mountForge(document.getElementById('page-forge'), { subscribe, openRefine: id => { window.__refineCalls.push(id); } });
}
start();
