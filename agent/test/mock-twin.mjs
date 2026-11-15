// Fake call for the Ody app (the 3D twin + the phone view + the rail), no API keys, LiveKit or phone needed:
//   node test/mock-twin.mjs [--waiting] [--loop] [--end] [--part raspberry-pi-4] [--custom] [--video [photo.jpg]]
//                           [--scan-demo] [--scan <dir>] [--port 8798]
// Serves the app through the real live.mjs server on http://localhost:8798/ (also /twin; never 8790, which the live
// agent uses) and replays: UNO R4 WiFi recognised -> ring on the USB-C port -> wire 13 -> breadboard J10 -> voice
// commands (explode, assemble, rotate, stop) -> warning on a 5V-GND short -> done. Holds the last state unless --loop.
//   --video      streams the caller's camera (a photo with a hand-held wobble, marks drawn by overlay.mjs)
//   --scan-demo  adds two "scan this" objects (a computer mouse, a mug) after the warning
//   --custom     a board Ody has no model for, described by its headers (model 'custom'), then a wire from one pin
//   --end        ends the call after the last beat (the "call ended, recap ready" state)
//   --circuit    a voice circuit build through circuit.mjs (no brain): UNO -> "add a distance sensor" -> "add an LED on
//                pin 6" -> "add a servo" -> "remove the LED", one {type:'circuit'} event per change, as agent.mjs sends them
//   --parts      UNO R4 WiFi, then voice: explode, select "the wifi module", remove it, combine, and a mock analysis
//                (the real one comes from the agent after the page's {type:'analyze'}); --board uno-r3 for the R3
//   --interior [dir]  "scan this" for each <name>.case.json in dir (default: the research test's output), then the
//                researched interior for it a moment later ({type:'interior', id, interior}), as agent.mjs sends them
const args = process.argv.slice(2);
const has = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const PORT = Number(opt('--port', 8798));
if (PORT === 8790) { console.error('8790 is the live agent; pick another port'); process.exit(2); }
process.env.MENTOR_MONITOR_PORT = String(PORT);
// createLiveServer, never startLive: a mock must not publish its fake call to the always-on hub (the live laptop page)
const { createLiveServer } = await import('../live.mjs');
const live = await createLiveServer();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gap = Number(process.env.MOCK_GAP_MS || 6000);

// ---------- optional caller video ----------
let marksNow = [], caption = '', inCall = false;
if (has('--video')) {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const { render, outJpeg, frameJpeg } = await import('../overlay.mjs');
  const here = p => fileURLToPath(new URL(p, import.meta.url));
  const photo = [opt('--video'), here('../../../mentor-film/assets/uno-desk.jpg'), here('qa/photo.jpg')].find(p => p && existsSync(p));
  if (photo) {
    const img = await loadImage(await readFile(photo));
    const CW = Math.round(Math.min(img.width, img.height * 0.5625)), CH = Math.round(CW / 0.5625);
    const X0 = Math.round((img.width - CW) / 2);
    const cam = createCanvas(CW, CH), cg = cam.getContext('2d');
    let tick = 0;
    setInterval(async () => {
      if (!inCall) return;
      const t = Date.now(), dx = Math.round(Math.sin(t / 900) * 8), dy = Math.round(Math.cos(t / 1300) * 6);
      cg.fillStyle = '#000'; cg.fillRect(0, 0, CW, CH);
      cg.drawImage(img, X0 + dx, Math.max(0, (img.height - CH) / 2) + dy, CW, Math.min(CH, img.height), 0, 0, CW, CH);
      const d = cg.getImageData(0, 0, CW, CH), f = { data: new Uint8Array(d.data.buffer), width: CW, height: CH };
      render(f, marksNow, { caption, tick: tick++, speaking: false });
      live.send({ type: 'frame', jpeg: (await outJpeg()).toString('base64') });
      if (tick % 2 === 0) { const j = await frameJpeg(f, 480); live.send({ type: 'input', jpeg: j.jpeg.toString('base64'), w: f.width, h: f.height }); }
    }, 500);
    console.log(`[mock] streaming the caller's camera from ${photo}`);
  } else console.warn('[mock] --video: no photo found, no video');
}

// corners A, B, C, D of the board in the camera picture (0..1), roughly what the brain returns for a board held flat
const board = { model: 'uno-r4-wifi', corners: [[0.2, 0.18], [0.82, 0.2], [0.8, 0.66], [0.22, 0.64]] };
const turn = (marks, step, say, extra = {}) => {
  marksNow = marks; caption = step;
  live.send({ type: 'turn', brain: 'gemini', model: 'gemini-2.5-flash', ms: 1800, marks, board: extra.board || board, step, done: false, ...extra });
  live.send({ type: 'step', text: step, ...(extra.done ? { done: true } : {}) });
  live.send({ type: 'say', text: say, ms: 1800 });
};
const mk = (label, kind, pin = '', pin2 = '', x = 0.5, y = 0.5, x2 = -1, y2 = -1) => ({ label, kind, x, y, x2, y2, pin, pin2 });
const twin = async (action, ms = 2600) => { live.send({ type: 'heard', text: `Ody, ${action} it.` }); live.send({ type: 'twin', action }); console.log(`[mock] voice: ${action}`); await sleep(ms); };
// --replay: the call is a recorded session being replayed; --consent: the caller is asked to agree first (stays 'asked')
const start = () => {
  inCall = true;
  live.send({ type: 'call', state: 'live', since: Date.now(), ...(has('--replay') ? { replay: true, label: 'Replay of a real Ody call' } : {}) });
  live.send({ type: 'brain', brain: 'gemini' });
  if (has('--consent')) live.send({ type: 'consent', state: 'asked' });
};
const end = () => { inCall = false; live.send({ type: 'call', state: 'ended' }); console.log('[mock] call ended'); };

async function scanDemo() {
  const { sanitizeScan } = await import('../scan.mjs');
  const objs = [
    { name: 'Wireless mouse', category: 'computer accessory', dims_mm: { w: 62, d: 112, h: 38 }, confidence: 0.74, parts: [
      { name: 'Shell', shape: 'capsule', size_mm: { x: 60, y: 108, z: 34 }, position_mm: { x: 0, y: 0, z: 17 }, color: '#2b2d33', material: 'plastic' },
      { name: 'Left button', shape: 'rounded_box', size_mm: { x: 27, y: 40, z: 4 }, position_mm: { x: -14, y: 30, z: 34 }, color: '#3a3d45', material: 'plastic' },
      { name: 'Right button', shape: 'rounded_box', size_mm: { x: 27, y: 40, z: 4 }, position_mm: { x: 14, y: 30, z: 34 }, color: '#3a3d45', material: 'plastic' },
      { name: 'Scroll wheel', shape: 'cylinder', size_mm: { x: 8, y: 14, z: 14 }, position_mm: { x: 0, y: 28, z: 37 }, rotation_deg: { x: 0, y: 90, z: 0 }, color: '#8a8f98', material: 'rubber' }] },
    { name: 'Coffee mug', category: 'kitchenware', dims_mm: { w: 120, d: 85, h: 95 }, confidence: 0.81, parts: [
      { name: 'Body', shape: 'cylinder', size_mm: { x: 82, y: 82, z: 95 }, position_mm: { x: 0, y: 0, z: 47 }, color: '#e9e4da', material: 'plastic' },
      { name: 'Handle', shape: 'torus', size_mm: { x: 42, y: 12, z: 50 }, position_mm: { x: 50, y: 0, z: 50 }, rotation_deg: { x: 90, y: 0, z: 0 }, color: '#e9e4da', material: 'plastic' }] },
  ];
  for (const [i, raw] of objs.entries()) {
    live.send({ type: 'heard', text: 'Scan this.' });
    live.send({ type: 'scan', id: i + 1, at: Date.now(), spec: sanitizeScan(raw), photo: '', crop: null });
    live.send({ type: 'say', text: `Got it, a ${raw.name.toLowerCase()}. It's on your laptop.` });
    console.log(`[mock] scan: ${raw.name}`);
    await sleep(gap);
  }
}

async function call() {
  start();
  live.send({ type: 'step', text: 'Show me your project' });
  live.send({ type: 'say', text: "Hi, I'm Ody. Show me what you're building." });
  await sleep(gap);
  live.send({ type: 'heard', text: "It's an Arduino, the new one with Wi-Fi." });
  live.send({ type: 'part', model: 'uno-r4-wifi', label: 'Arduino UNO R4 WiFi' });
  turn([mk('USB-C port', 'circle', '', '', 0.24, 0.3)], 'Plug the USB-C cable into your laptop', 'That is an UNO R4 WiFi. Plug the USB-C cable in here.');
  await sleep(gap);
  live.send({ type: 'heard', text: 'Where does the LED wire go?' });
  turn([mk('Pin 13 → breadboard J10', 'wire', '13', '', 0.4, 0.2, 0.9, 0.4)], 'Jumper from pin 13 to breadboard J10', 'Run a jumper from pin 13 into hole J10 on the breadboard.');
  await sleep(gap);
  await twin('explode', 3000); await twin('assemble', 2600); await twin('rotate', 4000); await twin('stop', 1500);
  live.send({ type: 'heard', text: 'I also put a wire from 5V to GND.' });
  turn([mk('Short: 5V to GND', 'warn', '5V', 'GND', 0.5, 0.62, 0.53, 0.62), mk('Pin 13', 'circle', '13', '', 0.4, 0.2), mk('GND', 'circle', 'GND', '', 0.45, 0.2)],
    'Stop: remove the 5V to GND wire', 'Stop, that wire shorts 5V to ground. Pull it out before you power on.');
  await sleep(gap);
  if (has('--scan-demo')) await scanDemo();
  live.send({ type: 'heard', text: "It's blinking!" });
  turn([mk('L LED', 'circle', '', '', 0.4, 0.25)], 'Upload Blink from File, Examples, Basics', 'That is it. You made it home.', { done: true });
  live.send({ type: 'step', text: 'Done. You made it home.', done: true });
}

// --part <id>: a library board (twin/parts.json) recognised, then one turn with a wire from one of its pins to the
// breadboard and a ring on a signature part. Corners are a plausible quad; the twin only needs the model and pin names.
const PART_TURNS = {
  'raspberry-pi-4': [mk('GPIO17 → breadboard J10', 'wire', 'GPIO17', 'breadboard J10', 0.3, 0.2), mk('USB-C power', 'circle', '', '', 0.3, 0.8)],
  'esp32-devkit-v1': [mk('D5 → breadboard J10', 'wire', 'D5', 'breadboard J10', 0.7, 0.4), mk('BOOT button', 'circle', '', '', 0.6, 0.85)],
  'esp32-devkitc': [mk('GPIO5 → breadboard J10', 'wire', 'GPIO5', 'breadboard J10', 0.7, 0.4), mk('EN button', 'circle', '', '', 0.4, 0.85)],
  'nodemcu-esp8266': [mk('D5 → breadboard J10', 'wire', 'D5', 'breadboard J10', 0.7, 0.4), mk('FLASH button', 'circle', '', '', 0.6, 0.85)],
  'arduino-nano': [mk('Pin 13 → breadboard J10', 'wire', '13', 'breadboard J10', 0.2, 0.6), mk('Reset button', 'circle', '', '', 0.4, 0.5)],
  'arduino-mega-2560': [mk('Pin 22 → breadboard J10', 'wire', '22', 'breadboard J10', 0.8, 0.3), mk('ATmega2560 chip', 'circle', '', '', 0.5, 0.5)],
  'raspberry-pi-pico': [mk('GP15 → breadboard J10', 'wire', 'GP15', 'breadboard J10', 0.2, 0.8), mk('BOOTSEL button', 'circle', '', '', 0.5, 0.2)],
  'raspberry-pi-pico-w': [mk('GP15 → breadboard J10', 'wire', 'GP15', 'breadboard J10', 0.2, 0.8), mk('Wi-Fi chip', 'circle', '', '', 0.5, 0.8)],
  custom: [mk('PWMA → breadboard J10', 'wire', 'PWMA', 'breadboard J10', 0.3, 0.2), mk('STBY', 'circle', 'STBY', '', 0.6, 0.2)],
};
// A motor-driver breakout Ody has no model for: two 8-pin rows (2.54 mm pitch) and a 2-pin power header, in board mm.
const row = (y, names, x0 = 6.11) => names.map((label, i) => ({ x: x0 + i * 2.54, y, label }));
const CUSTOM = { model: 'custom', label: 'TB6612 motor driver', size_mm: { w: 32, h: 24 }, headers: [
  { name: 'Top', holes: row(3, ['PWMA', 'AIN2', 'AIN1', 'STBY', 'BIN1', 'BIN2', 'PWMB', 'GND']) },
  { name: 'Bottom', holes: row(21, ['VM', 'VCC', 'GND', 'AO1', 'AO2', 'BO2', 'BO1', 'GND']) },
  { name: 'Power', holes: [{ x: 28.5, y: 10.73, label: 'V+' }, { x: 28.5, y: 13.27, label: 'V-' }] } ] };
async function partCall(id) {
  start();
  live.send({ type: 'heard', text: 'What board is this?' });
  live.send(id === 'custom' ? { type: 'part', ...CUSTOM } : { type: 'part', model: id, label: 'Board' });
  live.send({ type: 'step', text: 'Show me your project' });
  await sleep(gap);
  live.send({ type: 'heard', text: 'Where does the LED wire go?' });
  marksNow = PART_TURNS[id] || [];
  live.send({ type: 'turn', brain: 'gemini', model: 'gemini-2.5-flash', ms: 1800, marks: PART_TURNS[id] || [], board: { ...board, model: id }, step: 'Wire the LED', done: false });
  live.send({ type: 'step', text: 'Wire the LED' });
  live.send({ type: 'say', text: 'Run a jumper from that pin into J10 on the breadboard.', ms: 1800 });
}

console.log(`[mock] Ody app on http://localhost:${PORT}/ (and /twin)`);
console.log(`[mock] twin on http://localhost:${PORT}/twin`);   // twin-parts-test.mjs waits for this line
const scanAt = args.indexOf('--scan');
if (has('--parts')) {
  const model = opt('--board', 'uno-r4-wifi');
  await sleep(Number(process.env.MOCK_START_MS || 1500));
  start();
  live.send({ type: 'part', model, label: model === 'uno-r3' ? 'Arduino UNO R3' : 'Arduino UNO R4 WiFi' });
  live.send({ type: 'say', text: 'That is your board. Want to take it apart?' });
  const voice = async (heard, action, target, ms = gap) => { await sleep(ms); live.send({ type: 'heard', text: heard }); live.send({ type: 'twin', action, ...(target ? { target } : {}) }); console.log(`[mock] twin ${action} ${target || ''}`); };
  const wifi = model === 'uno-r3' ? 'the usb chip' : 'the wifi module';
  await voice('Ody, take it apart.', 'explode');
  await voice(`Show me ${wifi}.`, 'select', wifi);
  await voice('Remove it.', 'remove', wifi);
  await voice('Put it back together.', 'combine');
  await sleep(2500);
  live.send(model === 'uno-r3'
    ? { type: 'analysis', id: 1, scope: 'board', board: model, kept: [], removed: [{ id: 'usbchip', name: 'ATmega16U2 USB chip' }], title: 'UNO R3 without its USB chip', works: false,
        summary: 'The ATmega328P still runs a sketch, but nothing on the board can talk USB any more.', pros: ['The main chip and its 16 MHz clock are intact'], cons: ['No USB upload or serial monitor'],
        needs: ['A USB-serial adapter on pins 0 and 1, or an ICSP programmer'], verdict: 'It runs, but you can no longer program it over USB.' }
    : { type: 'analysis', id: 1, scope: 'board', board: model, kept: [], removed: [{ id: 'esp32', name: 'ESP32-S3 Wi-Fi module' }], title: 'UNO R4 without Wi-Fi', works: true,
        summary: 'The RA4M1 runs your sketches on its own; the ESP32-S3 only adds Wi-Fi, Bluetooth and the USB bridge on this board.',
        pros: ['Sketches, pins and the LED matrix still work', 'Draws less power'], cons: ['No Wi-Fi or Bluetooth', 'USB-C upload goes through the RA4M1 bootloader only'],
        needs: ['Upload with the RA4M1’s native USB (double-tap reset)'], verdict: 'It still works as an UNO; it just loses its radio.' });
  console.log('[mock] analysis sent; holding the last state');
} else if (has('--circuit')) {
  const { createProject, apply, fastPlan, circuitEvent, steps, markDone } = await import('../circuit.mjs');
  await sleep(Number(process.env.MOCK_START_MS || 1500));
  start();
  live.send({ type: 'part', model: 'uno-r3', label: 'Arduino UNO R3' });
  let st = createProject({ board: 'uno-r3' });
  for (const heard of ['add a distance sensor', 'add an LED on pin 6', 'add a servo', 'remove the LED']) {
    await sleep(gap);
    for (const x of steps(st)) st = markDone(st, x.id);   // the caller built everything so far
    const plan = fastPlan(st, heard), r = apply(st, plan.actions);
    st = r.state;
    live.send({ type: 'heard', text: `Ody, ${heard}.` });
    live.send({ ...circuitEvent(st, r) });
    live.send({ type: 'say', text: r.say, ms: 900 });
    console.log(`[mock] circuit: ${heard}`);
  }
  await sleep(gap);   // the voice "next" walks the connection guide: step 2
  const all = steps(st), wires = all.filter(x => /^wire:/.test(x.id));
  const pick = wires[1] || wires[0];
  if (pick) { live.send({ type: 'heard', text: 'Ody, next.' }); live.send({ type: 'circuit-step', index: all.indexOf(pick) + 1, total: all.length, step: pick }); console.log(`[mock] circuit-step: ${pick.id}`); }
  console.log('[mock] holding the last state');
} else if (has('--interior')) {
  const { readdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = opt('--interior', `${tmpdir()}/ody-research-out`);
  const files = (await readdir(dir)).filter(f => f.endsWith('.case.json') && (!opt('--only') || f.startsWith(opt('--only')))).sort();
  await sleep(Number(process.env.MOCK_START_MS || 1500));
  start(); live.send({ type: 'brain', brain: 'gemini' });
  for (const [i, f] of files.entries()) {
    const { scan, photo, crop, interior } = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    const id = i + 1;
    live.send({ type: 'heard', text: 'Scan this.' });
    live.send({ type: 'scan', id, at: Date.now(), spec: scan, photo: photo || '', crop });
    live.send({ type: 'say', text: `Got it, it's on your laptop. I'll look up what's inside.` });
    await sleep(Number(process.env.MOCK_RESEARCH_MS || 2500));
    if (interior) { live.send({ type: 'interior', id, interior }); console.log(`[mock] interior ${f}: ${interior.layers.length} layers`); }
    await sleep(gap);
  }
  console.log('[mock] holding the last state');
} else if (scanAt >= 0) {   // --scan <dir>: replay every <name>.scan.json there (written by test/scan-test.mjs) as "scan this" turns
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = args[scanAt + 1];
  const files = (await readdir(dir)).filter(f => f.endsWith('.scan.json')).sort();
  start(); live.send({ type: 'brain', brain: 'claude-code' });
  for (const [i, f] of files.entries()) {
    const { spec, photo, crop } = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
    live.send({ type: 'heard', text: 'Scan this.' });
    live.send({ type: 'scan', id: i + 1, at: Date.now(), spec, photo, crop });
    live.send({ type: 'say', text: `Got it. It's on your laptop.` });
    console.log(`[mock] scan ${f}: ${spec.name}`);
    await sleep(Number(process.env.MOCK_SCAN_GAP_MS || 300));
  }
  console.log('[mock] holding the last state');
} else if (has('--part') || has('--custom')) {
  const id = has('--custom') ? 'custom' : opt('--part');
  await sleep(Number(process.env.MOCK_START_MS || 1500)); await partCall(id);
  if (has('--end')) { await sleep(gap); end(); }
  console.log('[mock] holding the last state');
} else if (has('--waiting')) { /* stay in the waiting state */ }
else if (has('--loop')) for (;;) { await sleep(2000); await call(); await sleep(gap * 2); end(); await sleep(4000); }
else { await sleep(1500); await call(); if (has('--end')) { await sleep(gap); end(); } console.log('[mock] holding the last state'); }
