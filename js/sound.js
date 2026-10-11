// Tiny WebAudio synth: no sound files to host.
let ctx;
export const sound = { on: true };

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, at, dur, { type = 'sine', vol = 0.16, slide = 0 } = {}) {
  const c = ac();
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const S = {
  open: () => { tone(988, 0, 0.1, { type: 'triangle' }); tone(1319, 0.08, 0.14, { type: 'triangle' }); },
  buzz: () => { tone(523, 0, 0.09, { type: 'square', vol: 0.1 }); tone(784, 0.08, 0.2, { type: 'square', vol: 0.1 }); },
  correct: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.075, 0.24, { type: 'triangle' })),
  wrong: () => { tone(233, 0, 0.42, { type: 'sawtooth', vol: 0.1, slide: 110 }); tone(220, 0, 0.42, { type: 'square', vol: 0.05, slide: 104 }); },
  timeup: () => [660, 560, 440].forEach((f, i) => tone(f, i * 0.17, 0.15, { type: 'square', vol: 0.08 })),
  dd: () => [392, 523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, i * 0.06, 0.35, { type: 'triangle', vol: 0.12 })),
  join: () => { tone(660, 0, 0.08); tone(990, 0.07, 0.14); },
  win: () => [523, 523, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, [0, 0.12, 0.24, 0.36, 0.6, 0.78, 0.9, 1.05][i], i === 7 ? 0.7 : 0.16, { type: 'triangle', vol: 0.14 })),
};

export function play(name) {
  if (!sound.on) return;
  try { S[name]?.(); } catch {}
}

// Browsers only allow audio after a user gesture; call this from one.
export function unlock() { try { ac(); } catch {} }
