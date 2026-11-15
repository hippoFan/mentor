// Fake call for the 3D twin, no API keys, LiveKit or phone needed:
//   node test/mock-twin.mjs [--waiting] [--loop] [--port 8798]
// Serves twin.html (and the call view) through the real live.mjs server on http://localhost:8798/twin (never 8790,
// which the live agent uses) and replays: UNO R4 WiFi recognised → ring on the USB-C port → wire 13 → breadboard J10
// → warning on a 5V–GND short → done. Holds the last state unless --loop.
const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const PORT = portAt >= 0 ? Number(args[portAt + 1]) : 8798;
if (PORT === 8790) { console.error('8790 is the live agent; pick another port'); process.exit(2); }
process.env.MENTOR_MONITOR_PORT = String(PORT);
const { startLive } = await import('../live.mjs');
const live = await startLive();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gap = Number(process.env.MOCK_GAP_MS || 6000);

// corners A, B, C, D of the board in the camera picture (0..1), roughly what the brain returns for a board held flat
const board = { model: 'uno-r4-wifi', corners: [[0.2, 0.18], [0.82, 0.2], [0.8, 0.66], [0.22, 0.64]] };
const turn = (marks, step, say, extra = {}) => {
  live.send({ type: 'turn', brain: 'gemini', model: 'gemini-2.5-flash', ms: 1800, marks, board, step, done: false, ...extra });
  live.send({ type: 'step', text: step, ...(extra.done ? { done: true } : {}) });
  live.send({ type: 'say', text: say, ms: 1800 });
};
const mk = (label, kind, pin = '', pin2 = '', x = 0.5, y = 0.5, x2 = -1, y2 = -1) => ({ label, kind, x, y, x2, y2, pin, pin2 });

async function call() {
  live.send({ type: 'call', state: 'live', since: Date.now() });
  live.send({ type: 'brain', brain: 'gemini' });
  live.send({ type: 'step', text: 'Show me your project' });
  await sleep(gap);
  live.send({ type: 'heard', text: "It's an Arduino, the new one with Wi-Fi." });
  live.send({ type: 'part', model: 'uno-r4-wifi', label: 'Arduino UNO R4 WiFi' });
  turn([mk('USB-C port', 'circle', '', '', 0.24, 0.3)], 'Plug the USB-C cable into your laptop', 'That is an UNO R4 WiFi. Plug the USB-C cable in here.');
  await sleep(gap);
  live.send({ type: 'heard', text: 'Where does the LED wire go?' });
  turn([mk('Pin 13 → breadboard J10', 'wire', '13', '', 0.4, 0.2, 0.9, 0.4)], 'Jumper from pin 13 to breadboard J10', 'Run a jumper from pin 13 into hole J10 on the breadboard.');
  await sleep(gap);
  live.send({ type: 'heard', text: 'I also put a wire from 5V to GND.' });
  turn([mk('Short: 5V to GND', 'warn', '5V', 'GND', 0.5, 0.62, 0.53, 0.62)], 'Stop: remove the 5V to GND wire', 'Stop, that wire shorts 5V to ground. Pull it out before you power on.');
  await sleep(gap);
  live.send({ type: 'heard', text: "It's blinking!" });
  turn([mk('L LED', 'circle', '', '', 0.4, 0.25)], 'Upload Blink from File, Examples, Basics', 'That is it. You made it home.', { done: true });
}

console.log(`[mock] twin on http://localhost:${PORT}/twin`);
const scanAt = args.indexOf('--scan');
if (scanAt >= 0) {   // --scan <dir>: replay every <name>.scan.json there (written by test/scan-test.mjs) as "scan this" turns
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = args[scanAt + 1];
  const files = (await readdir(dir)).filter(f => f.endsWith('.scan.json')).sort();
  live.send({ type: 'call', state: 'live', since: Date.now() });
  live.send({ type: 'brain', brain: 'claude-code' });
  for (const [i, f] of files.entries()) {
    const { spec, photo, crop } = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    live.send({ type: 'heard', text: 'Scan this.' });
    live.send({ type: 'scan', id: i + 1, at: Date.now(), spec, photo, crop });
    live.send({ type: 'say', text: `Got it. It's on your laptop.` });
    console.log(`[mock] scan ${f}: ${spec.name}`);
    await sleep(Number(process.env.MOCK_SCAN_GAP_MS || 300));
  }
  console.log('[mock] holding the last state');
} else if (args.includes('--waiting')) { /* stay in the waiting state */ }
else if (args.includes('--loop')) for (;;) { await sleep(2000); await call(); await sleep(gap * 2); live.send({ type: 'call', state: 'ended' }); await sleep(4000); }
else { await sleep(1500); await call(); console.log('[mock] holding the last state'); }
