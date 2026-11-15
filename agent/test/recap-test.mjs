// Voyage-log recap test, no brain and no texting (--no-send semantics): builds the page from a real run folder's
// recap.json + step images with fixed stories, screenshots it with headless Chrome, and checks serve-recaps.mjs.
//   node test/recap-test.mjs [../runs/<real run>] [screenshot dir]
// Writes ../runs/_test-voyage-home/ and ../runs/_test-voyage-sea/ (runs/ is git-ignored).
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recapText, writeRecapPage, wokwiDiagram, externalLedPins, buildLegs } from '../recap.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const RUNS = resolve(here, '../runs');
const src = resolve(process.argv[2] || `${RUNS}/2026-11-15-02-11-7b7bfe84edc3`) + '/';
const shots = resolve(process.argv[3] || '/home/plopee/.playwright-mcp/mentor-recap');
const CHROME = process.env.CHROME || '/home/plopee/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failed++; };

const saved = JSON.parse(await readFile(`${src}recap.json`, 'utf8'));
const steps = saved.recap || [];
// The home story is a full voyage: the same real pictures, relabelled as four legs (three turns each).
const LEGS = [['Connect USB cable', 'Found the USB-C port and plugged the board in'], ['Open the Arduino IDE', 'Picked Arduino Uno R4 Minima and the right port'],
  ['Wire the LED to pin 9', 'Long leg to pin 9 through a 220 ohm resistor, short leg to GND'], ['Upload the sketch', 'Uploaded; the LED blinks twice a second']];
const voyage = steps.map((s, i) => { const [step, note] = LEGS[Math.min(3, Math.floor(i / 3))]; return { ...s, step, note }; });

const BLINK = `void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(1000);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(1000);\n}\n`;
const EXTERNAL = `const int ledPin = 9; // LED + 220 ohm resistor\n\nvoid setup() {\n  pinMode(ledPin, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(ledPin, HIGH);\n  delay(500);\n  digitalWrite(ledPin, LOW);\n  delay(500);\n}\n`;
const stories = {
  // Reached home, external LED on pin 9; an injected tag in the title checks escaping.
  home: { done: true, story: { title: 'A blinking LED <script>alert(1)</script>', code: EXTERNAL,
    summary: 'You plugged in your Arduino Uno R4, wired an LED with a resistor to pin 9, and uploaded a sketch that blinks it twice a second.',
    next: 'Change the delay to 100 and watch it flicker.' } },
  // Still at sea (the real run: never got the cable in), onboard-LED Blink.
  sea: { done: false, story: { title: 'Arduino onboard LED setup', code: BLINK,
    summary: 'We identified your Arduino board and found the USB-C port. We were getting the board powered so we could upload the blink program.',
    next: 'Plug the USB-C cable into your board and connect it to your computer.' } },
};

for (const [name, { done, story }] of Object.entries(stories)) {
  const steps = name === 'home' ? voyage : saved.recap || [];
  const dir = `${RUNS}/_test-voyage-${name}/`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const f of await readdir(src)) if (/^step-\d+\.png$/.test(f)) await copyFile(src + f, dir + f);
  const local = steps.map(s => ({ ...s, image: dir + s.image.split('/').pop() }));
  await writeRecapPage(dir, story, local, { done });
  const html = await readFile(`${dir}index.html`, 'utf8');
  const text = recapText(story, local, `https://example.invalid/_test-voyage-${name}/`, { done });
  ok(!html.includes('<script'), `${name}: model text is escaped`);
  ok(!/<link|<script|src="(https?:)?\/\/|url\(/i.test(html) && (html.match(/https?:\/\//g) || []).length === 1, `${name}: no external resources (one Wokwi link)`);
  ok(html.includes('Home: ') === done, `${name}: home leg ${done ? 'shown' : 'absent'}`);
  ok(existsSync(`${dir}sketch.ino`) && existsSync(`${dir}diagram.json`), `${name}: sketch.ino + diagram.json written`);
  ok(text.length <= 4000 && text.includes('Your voyage:') && text.includes('Fair winds. Ody') && text.includes('/_test-voyage-'), `${name}: iMessage text (${text.length} chars)`);
  ok(text.includes('Home: ') === done, `${name}: iMessage home line`);
  if (name === 'sea') console.log('---- iMessage (sea) ----\n' + text + '\n------------------------');
}
ok(buildLegs(steps).length === 1, `12 identical turns collapse into 1 leg (got ${buildLegs(steps).length})`);
ok(buildLegs(voyage).length === 4, `voyage of 12 turns on 4 steps gives 4 legs`);
ok(wokwiDiagram(BLINK).parts.length === 1, 'onboard Blink diagram is just the Uno');
const ext = wokwiDiagram(EXTERNAL);
ok(ext.parts.some(p => p.type === 'wokwi-led') && ext.parts.some(p => p.type === 'wokwi-resistor') && ext.connections.some(c => c[0] === 'uno:9'), 'external LED diagram wires pin 9');
ok(externalLedPins('int leds[] = {2, 3, 4};\nvoid setup(){ for(int i=0;i<3;i++) pinMode(leds[i], OUTPUT); }').join() === '2,3,4', 'array of LED pins detected');

// Screenshots: phone + desktop, light and dark.
if (existsSync(CHROME)) {
  await mkdir(shots, { recursive: true });
  const shot = (name, w, h, out, dark) => spawnSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${w},${h}`, ...(dark ? ['--force-dark-mode', '--blink-settings=preferredColorScheme=0'] : []),
    `--screenshot=${shots}/${out}`, `file://${RUNS}/_test-voyage-${name}/index.html`], { stdio: 'ignore', timeout: 30_000 });
  shot('home', 390, 844, 'phone-home.png');
  shot('home', 390, 3200, 'phone-home-full.png');
  shot('home', 390, 3200, 'phone-home-full-dark.png', true);
  shot('sea', 390, 2600, 'phone-sea-full.png');
  shot('home', 1280, 800, 'desktop-home.png');
  shot('home', 1280, 2400, 'desktop-home-full.png');
  console.log(`screenshots in ${shots}/`);
} else console.log(`SKIP screenshots: no Chrome at ${CHROME}`);

// serve-recaps.mjs on a spare port: traversal and dotfiles 404, page 200, Wokwi files as attachments, private JSON 404.
const port = Number(process.env.RECAP_TEST_PORT || 20000 + Math.floor(Math.random() * 20000));
const server = spawn(process.execPath, ['serve-recaps.mjs'], { cwd: here, env: { ...process.env, RECAP_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { server.stdout.once('data', res); server.once('exit', c => rej(new Error(`server exited ${c}`))); });
const base = `http://127.0.0.1:${port}`;
const raw = path => new Promise(res => {   // raw request so ../ is not normalised away by the client
  import('node:http').then(({ request }) => request({ host: '127.0.0.1', port, path }, r => { r.resume(); r.on('end', () => res(r)); }).end());
});
try {
  for (const p of ['/../agent/package.json', '/..%2fagent%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/_test-voyage-home/../../agent/recap.mjs'])
    ok((await raw(p)).statusCode === 404, `404 traversal ${p}`);
  for (const p of ['/_test-voyage-home/.env', '/.env', '/_test-voyage-home/.hidden.html'])
    ok((await raw(p)).statusCode === 404, `404 dotfile ${p}`);
  for (const p of ['/2026-11-15-02-11-7b7bfe84edc3/recap.json', '/2026-11-15-02-11-7b7bfe84edc3/conversation.json', '/2026-11-15-02-11-7b7bfe84edc3/frames/001-in.jpg'])
    ok((await raw(p)).statusCode === 404, `404 private ${p}`);
  const page = await fetch(`${base}/_test-voyage-home/`);
  ok(page.status === 200 && page.headers.get('content-type').startsWith('text/html') && !!page.headers.get('content-security-policy'), 'page 200 with CSP');
  const img = await fetch(`${base}/_test-voyage-home/step-01.png`);
  ok(img.status === 200 && img.headers.get('content-type') === 'image/png', 'step image 200');
  for (const [f, t] of [['sketch.ino', 'text/plain'], ['diagram.json', 'application/json']]) {
    const r = await fetch(`${base}/_test-voyage-home/${f}`);
    const body = await r.text();
    ok(r.status === 200 && r.headers.get('content-type').startsWith(t) && r.headers.get('content-disposition') === `attachment; filename="${f}"`
      && r.headers.get('x-content-type-options') === 'nosniff' && body.length > 10, `${f} served as attachment (${t})`);
  }
  ok((await fetch(`${base}/_test-voyage-home/`, { method: 'POST' })).status === 405, 'POST 405');
} finally { server.kill(); }

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
