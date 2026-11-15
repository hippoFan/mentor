// ?handsim=1: a stand-in for the camera + hand tracker (twin/hands.js) that feeds scripted synthetic landmarks
// through the same gesture pipeline at 30 Hz, so tests and demos run with no camera. ?handsim=deny acts like a
// blocked camera. Nothing here touches a camera or the network.
import { synthHand } from './gestures.js';

/** Same contract as startHands: onHands(hands, tMs, info); returns { video: null, stop, play, hold, sim: true }. */
export async function startHands({ onHands, deny = false }) {
  if (deny) throw new DOMException('Permission denied', 'NotAllowedError');
  let queue = [], current = [], info = { aspect: 1, lowLight: false, detectMs: 1 }, done = null;
  const toHands = spec => spec.map(([pose, cx, cy, size, o]) => ({ landmarks: synthHand(pose, cx, cy, size, o) }));
  const tick = () => {
    if (queue.length) {
      const f = queue.shift();
      if (Array.isArray(f)) current = f; else { if (f.hands) current = f.hands; if (f.lowLight != null) info = { ...info, lowLight: !!f.lowLight }; }
      if (!queue.length && done) { const d = done; done = null; setTimeout(d, 0); }
    }
    onHands(toHands(current), performance.now(), info);
  };
  const timer = setInterval(tick, 33);
  return {
    video: null, sim: true,
    /** frames: [[spec, ...], ...] or [{ hands, lowLight }, ...]; spec = [pose, cx, cy, size, opts]. Resolves when played. */
    play(frames) { queue = [...frames]; return new Promise(res => { done = res; if (!queue.length) { done = null; res(); } }); },
    /** Keep showing these hands (or none) until the next play / hold. */
    hold(spec, extra = {}) { queue = []; current = spec || []; if (extra.lowLight != null) info = { ...info, lowLight: !!extra.lowLight }; },
    stop() { clearInterval(timer); queue = []; current = []; onHands([], performance.now(), info); },
  };
}
