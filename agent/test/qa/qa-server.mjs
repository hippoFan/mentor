// Adversarial feed on :8795 -- unknown events, junk marks, long transcript. node test/qa/qa-server.mjs [--hold]
process.env.MENTOR_MONITOR_PORT = '8795';
const { startLive } = await import('../../live.mjs');
const live = await startLive(); const sleep = ms => new Promise(r => setTimeout(r, ms));
live.send({ type: 'call', state: 'live', since: Date.now() });
live.send({ type: 'brain', brain: 'gemini' });
live.send({ type: 'step', text: 'Show me your project' });
live.send({ type: 'totally-unknown', foo: { bar: 1 } });
live.send({ type: 'frame' });                       // frame with no jpeg
live.send({ type: 'turn', marks: null });           // no marks, no ms
live.send({ type: 'turn', marks: [{ label: null, kind: 'weird', x: 5, y: -3, pin: 'ZZ99' }], board: { model: 'nope', corners: [[0, 0]] } });
live.send({ type: 'turn', marks: [{ label: 'A'.repeat(300), kind: 'circle', x: 0.5, y: 0.5, x2: -1, y2: -1, pin: '13' }], board: { model: 'uno-r4-wifi', corners: [[.2, .2], [.8, .2], [.8, .7], [.2, .7]] }, ms: 99999, step: 'x'.repeat(400) });
live.send({ type: 'step', text: 'This is a very long step that goes on and on and on '.repeat(8) });
live.send({ type: 'scan', id: 1 });                 // scan with no spec
live.send({ type: 'part' });
live.send({ type: 'heard', text: '<img src=x onerror=alert(1)> <b>bold</b>' });
for (let i = 0; i < 70; i++) { live.send({ type: i % 2 ? 'say' : 'heard', text: `Line ${i}: ` + 'long transcript words '.repeat(i % 7 ? 6 : 40), ms: 1500 }); live.send({ type: 'step', text: 'Step number ' + i }); }
console.log('[qa] feed sent'); await sleep(1e9);
