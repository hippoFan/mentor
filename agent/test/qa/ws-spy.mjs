// QA: connect to the monitor ws with the allowed Origin and log non-image events (hello replay summarised).
import WebSocket from 'ws';
const port = process.env.MON || '8794';
const ws = new WebSocket(`ws://localhost:${port}`, { origin: `http://localhost:${port}` });
const t0 = Date.now();
ws.on('message', m => {
  const e = JSON.parse(m.toString());
  if (e.type === 'frame' || e.type === 'input') return;
  const s = JSON.stringify(e, (k, v) => (k === 'jpeg' || k === 'photo') ? `<${String(v).length}b>` : v);
  console.log(`[ws ${((Date.now() - t0) / 1000).toFixed(1)}s] ${s.slice(0, process.env.FULL ? 4000 : 400)}`);
});
ws.on('error', e => console.log('ws error', e.message));
ws.on('close', () => { console.log('ws closed'); process.exit(0); });
