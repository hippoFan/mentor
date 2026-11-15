// Schematics: the circuit Ody is building (circuit.mjs) as a real schematic, a routed PCB and KiCad files, redrawn after
// every circuit change, whether it came by voice on a call or typed to Argos.
//
// The board is a carrier PCB: one header row that plugs into the dev board's own pins (only the pins this build uses, all
// grounds on one pin), plus every part on the board itself: each LED with its 220 ohm resistor, and a pin header for each
// module (sensor, servo, knob, button) in the module's own pin order. tscircuit places the parts, autoroutes the copper,
// and converts it to KiCad (.kicad_sch, .kicad_pcb, .kicad_pro) and to SVG drawings.
//
// On demand only: The Forge's Schematic button (POST /argos/designs/<id>/schematic, argos/server.mjs) draws it, never a
// circuit change by itself. tscircuit is optional (agent/blueprint, `cd agent/blueprint && npm ci`). Without it,
// blueprint() returns null and the route still returns the netlist.
//
//   const bp = await blueprint(state);   // { schematicSvg, pcbSvg, kicad: { sch, pcb, pro }, traces, errors, ms } | null
//   await drawingsAvailable()            // is tscircuit installed?
//   circuitKey(state)                    // what the drawing depends on (board + parts + wires), for the route's cache
import { createHash } from 'node:crypto';
import { boardPins, PROFILES } from './circuit.mjs';

const LIB = new URL('./blueprint/node_modules/', import.meta.url);
let mods = null, missing = false;
async function load() {
  if (mods || missing) return mods;
  try {
    const at = p => import(new URL(p, LIB).href);
    const [core, react, svg, kicad] = await Promise.all([
      at('@tscircuit/core/dist/index.js'), at('react/index.js'), at('circuit-to-svg/dist/index.js'), at('circuit-json-to-kicad/dist/index.js'),
    ]);
    mods = { RootCircuit: core.RootCircuit, h: (react.default || react).createElement, svg, kicad };
  } catch (e) {
    missing = true;
    console.warn(`[blueprint] drawings off: tscircuit isn't installed (cd agent/blueprint && npm ci): ${String(e.message).slice(0, 120)}`);
  }
  return mods;
}

/** True when tscircuit is installed in agent/blueprint. */
export async function drawingsAvailable() { return !!(await load()); }

/** A short hash of what the drawing depends on: the board, each part (id, kind, colour) and each wire. */
export function circuitKey(state) {
  const parts = (state?.components || []).map(c => [c.id, c.part, c.color || '']);
  const wires = (state?.connections || []).map(w => [w.from, w.to, w.via || '']);
  return createHash('sha256').update(JSON.stringify([state?.board || '', parts, wires])).digest('hex').slice(0, 16);
}

const HEADER = { 'hc-sr04': 'Distance sensor', dht22: 'Temperature sensor', 'servo-sg90': 'Servo', mpu6050: 'Motion sensor', potentiometer: 'Knob', 'pushbutton-12mm': 'Button', 'pushbutton-6mm': 'Button' };
const ref = id => id.toUpperCase().replace(/[^A-Z0-9]/g, '');
const lbl = s => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, 'P$1');
const keyOf = w => w.from.slice(w.from.indexOf('.') + 1);

/**
 * The nets: every board pin with what it feeds (an LED through its resistor). Needs no tscircuit.
 * @returns {{name: string, nodes: {ref: string, pin: string}[]}[]}  ref 'BOARD' is the dev board, 'R_<id>' an LED's resistor
 */
export function netlist(state) {
  const t = boardPins(state.board);
  const nets = new Map();
  const add = (name, node) => { if (!nets.has(name)) nets.set(name, []); nets.get(name).push(node); };
  for (const w of state.connections || []) {
    const k = keyOf(w), comp = w.to.slice(0, w.to.indexOf('.')), pin = w.to.slice(w.to.indexOf('.') + 1);
    const name = t.pins[k]?.caps.has('gnd') ? 'GND' : t.pins[k]?.name || k;
    if (w.via) { const r = `R_${comp}`; add(name, { ref: 'BOARD', pin: t.pins[k]?.name || k }); add(name, { ref: r, pin: '1' }); add(`${comp}_${pin}`, { ref: r, pin: '2' }); add(`${comp}_${pin}`, { ref: comp, pin }); }
    else { add(name, { ref: 'BOARD', pin: t.pins[k]?.name || k }); add(name, { ref: comp, pin }); }
  }
  const dedupe = a => a.filter((x, i) => a.findIndex(y => y.ref === x.ref && y.pin === x.pin) === i);
  return [...nets].map(([name, nodes]) => ({ name, nodes: dedupe(nodes) }));
}

/** The tscircuit element tree for this project (h = React.createElement), or null when there's nothing to draw. */
export function circuitTree(state, h) {
  const t = boardPins(state.board);
  if (!t || !state.components?.length) return null;
  const used = [...new Set(state.connections.map(keyOf))];
  const boardNames = [...new Set(used.map(k => (t.pins[k]?.caps.has('gnd') ? 'GND' : t.pins[k]?.name || k)))];
  const pinLabels = Object.fromEntries(boardNames.map((n, i) => [`pin${i + 1}`, lbl(n)]));
  const kids = [h('chip', { name: 'J1', footprint: `pinrow${boardNames.length}`, pinLabels, pcbX: -14, pcbY: 0, pcbRotation: 90, schX: -6, schY: 0 })];
  const traces = [];
  const net = k => `.J1 > .${lbl(t.pins[k]?.caps.has('gnd') ? 'GND' : t.pins[k]?.name || k)}`;
  let x = -4;
  state.components.forEach((c, i) => {
    const prof = PROFILES[c.part], R = ref(c.id);
    if (!prof) return;
    if (c.part === 'led-5mm') {
      kids.push(h('resistor', { name: `R${R}`, resistance: '220', footprint: '0805', pcbX: x, pcbY: 6, schX: 0, schY: 3 - i * 2.2 }));
      kids.push(h('led', { name: R, color: c.color || 'red', footprint: '0805', pcbX: x, pcbY: -2, schX: 3, schY: 3 - i * 2.2 }));
      traces.push([`.R${R} > .pin2`, `.${R} > .anode`]);
      for (const w of state.connections.filter(w => w.to.startsWith(`${c.id}.`))) {
        const pin = w.to.slice(w.to.indexOf('.') + 1);
        traces.push(pin === 'A' ? [net(keyOf(w)), `.R${R} > .pin1`] : [net(keyOf(w)), `.${R} > .cathode`]);
      }
      x += 6;
      return;
    }
    const pins = prof.order;
    kids.push(h('chip', { name: R, footprint: `pinrow${pins.length}`, pinLabels: Object.fromEntries(pins.map((p, j) => [`pin${j + 1}`, lbl(p)])),
      pcbX: x + 3, pcbY: 10, schX: 4, schY: 3 - i * 2.2, manufacturerPartNumber: HEADER[c.part] || prof.label }));
    for (const w of state.connections.filter(w => w.to.startsWith(`${c.id}.`))) traces.push([net(keyOf(w)), `.${R} > .${lbl(w.to.slice(w.to.indexOf('.') + 1))}`]);
    x += Math.max(6, pins.length * 2.54 + 3);
  });
  const width = Math.max(40, Math.ceil(x + 24)), height = 34;
  return h('board', { width: `${width}mm`, height: `${height}mm` }, ...kids, ...traces.map(([from, to]) => h('trace', { from, to })));
}

/** Schematic + routed PCB + KiCad files for the current project, or null (tscircuit not installed, or nothing to draw). */
export async function blueprint(state, { timeout = 20_000 } = {}) {
  const m = await load();
  if (!m) return null;
  const t0 = Date.now();
  const tree = circuitTree(state, m.h);
  if (!tree) return null;
  const run = (async () => {
    const c = new m.RootCircuit();
    c.add(tree);
    await c.renderUntilSettled();
    const json = c.getCircuitJson();
    const kicad = {};
    for (const [k, C] of [['sch', 'CircuitJsonToKicadSchConverter'], ['pcb', 'CircuitJsonToKicadPcbConverter'], ['pro', 'CircuitJsonToKicadProConverter']]) {
      try { const cv = new m.kicad[C](json, { projectName: 'ody-circuit' }); cv.runUntilFinished(); kicad[k] = cv.getOutputString(); } catch (e) { kicad[k] = null; console.warn(`[blueprint] KiCad ${k}: ${e.message}`); }
    }
    return {
      schematicSvg: m.svg.convertCircuitJsonToSchematicSvg(json), pcbSvg: m.svg.convertCircuitJsonToPcbSvg(json), kicad,
      traces: json.filter(x => x.type === 'pcb_trace').length, errors: json.filter(x => /error/.test(x.type)).map(x => x.message).slice(0, 5), ms: Date.now() - t0,
    };
  })();
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), timeout); });
  return Promise.race([run, late]).catch(e => { console.warn(`[blueprint] ${e.message}`); return null; }).finally(() => clearTimeout(timer));
}
