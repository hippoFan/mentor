// QA: monitor ws/http hardening, run against startLive() on :8794 in-process.
import WebSocket from 'ws';
process.env.MENTOR_MONITOR_PORT = '8794';
const { startLive } = await import('../../live.mjs');
const live = await startLive();
const tryWs = (origin, hostHdr) => new Promise(res => {
  const o = { headers: hostHdr ? { Host: hostHdr } : {} }; if (origin !== null) o.origin = origin;
  const ws = new WebSocket('ws://127.0.0.1:8794', o);
  ws.on('open', () => { res('OPEN'); ws.close(); }); ws.on('error', e => res('rejected: ' + e.message)); setTimeout(() => res('timeout'), 3000);
});
console.log('good origin localhost     ', await tryWs('http://localhost:8794'));
console.log('good origin 127.0.0.1     ', await tryWs('http://127.0.0.1:8794'));
console.log('no origin                 ', await tryWs(null));
console.log('evil origin               ', await tryWs('http://evil.example'));
console.log('rebinding host            ', await tryWs('http://localhost:8794', 'evil.example:8794'));
console.log('origin w/ different port  ', await tryWs('http://localhost:8790'));
import('node:http').then(()=>{});
const { request } = await import('node:http');
const get = (p, host) => new Promise(res => { const r = request({ host: '127.0.0.1', port: 8794, path: p, headers: { Host: host || 'localhost:8794' } }, x => { res(x.statusCode); x.resume(); }); r.end(); });
for (const p of ['/', '/twin', '/twin/../../.env', '/twin/..%2f..%2f.env', '/data/uno-pins.json', '/runs/', '/%2e%2e/.env', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/../../../../package.json']) console.log('GET', p.padEnd(55), await get(p));
console.log('GET / evil host', await get('/', 'evil.example'));
// >4 clients
const cs = []; for (let i = 0; i < 6; i++) cs.push(await new Promise(r => { const w = new WebSocket('ws://127.0.0.1:8794', { origin: 'http://localhost:8794' }); w.on('open', () => r(w)); w.on('error', () => r(null)); }));
console.log('6 clients: connected', cs.filter(Boolean).length);
cs.forEach(c => c?.close()); await new Promise(r => setTimeout(r, 1000));
const big = await new Promise(r => { const w = new WebSocket('ws://127.0.0.1:8794', { origin: 'http://localhost:8794' }); w.on('open', () => w.send('x'.repeat(8000))); w.on('close', c => r('closed ' + c)); setTimeout(() => r('still open'), 2000); });
console.log('8 KB message from client:', big);
await live.close(); process.exit(0);
