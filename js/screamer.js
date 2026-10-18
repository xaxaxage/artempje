// Random jump scare. Now and then, when a question opens in a game (or while a board is being made),
// Foxy (keyed off his green screen in WebGL) jumps out of a dark background with the scream at full
// loudness, no warning. Then the game is back as if nothing happened.
// The scream (assets/screamer.wav) is normalized and soft-clipped to be as loud as a file can be.
import { store } from './util.js?v=1792356188689';

const VIDEO = new URL('../assets/screamer.mp4', import.meta.url).href;
const SOUND = new URL('../assets/screamer.wav', import.meta.url).href;

// Chance per opened question (game) or opened clue editor; set in the game settings, shared with the editor.
export const CHANCE = { off: 0, rare: 0.06, often: 0.15 };
export function level() {
  const v = store.get('plyukh-settings', {}).scare;
  return v in CHANCE ? v : 'rare';
}

let ctx = null;
let videoBlob = null; // Promise<string> object URL, so playback starts without network delays
let soundBytes = null; // Promise<ArrayBuffer|null>
let current = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function prefetch() {
  videoBlob ||= fetch(VIDEO).then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch(() => VIDEO);
  soundBytes ||= fetch(SOUND).then((r) => r.arrayBuffer()).catch(() => null);
}

// Browsers allow sound only after the page was tapped or clicked: unlock our audio on every such gesture
// until it runs, so a scare much later can still scream.
function unlock() {
  if (ctx?.state === 'running') return;
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const s = ctx.createBufferSource(); // the classic iOS unlock: play one silent sample now
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  } catch { ctx = null; }
}
for (const e of ['pointerdown', 'keydown', 'touchend']) addEventListener(e, unlock, true);

async function decodedSound() {
  const bytes = await soundBytes;
  if (!ctx || !bytes) return null;
  // Callback form: older Safari has no promise-returning decodeAudioData.
  return new Promise((res) => ctx.decodeAudioData(bytes.slice(0), res, () => res(null))).catch(() => null);
}

function playSound(buf) {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // iPhone: past the silent switch
  ctx.resume();
  const g = ctx.createGain();
  g.connect(ctx.destination);
  const s = ctx.createBufferSource();
  s.buffer = buf;
  // The clip is under a second: loop the scream part once more while the last frame shakes.
  s.loop = true;
  s.loopStart = 0.2;
  s.loopEnd = 0.88;
  s.connect(g);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(1, t);
  g.gain.setValueAtTime(1, t + 1.55);
  g.gain.linearRampToValueAtTime(0, t + 1.75);
  s.start(t);
  s.stop(t + 1.8);
}

// ---------- chroma key ----------
function webglKeyer(canvas) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }'));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `precision mediump float; varying vec2 uv; uniform sampler2D t;
    void main() {
      vec4 c = texture2D(t, uv);
      float other = max(c.r, c.b);
      float a = 1. - smoothstep(.04, .2, c.g - other); // how green the pixel is
      c.g = min(c.g, other);                             // remove the green glow on the edges
      gl_FragColor = vec4(c.rgb * a, a);
    }`));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return (video) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

function canvasKeyer(canvas) {
  canvas.width = 480;
  canvas.height = 270;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  return (video) => {
    g.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const other = Math.max(d[i], d[i + 2]);
      const key = (d[i + 1] - other) / 255;
      d[i + 3] = 255 * (1 - Math.min(1, Math.max(0, (key - 0.04) / 0.16)));
      d[i + 1] = Math.min(d[i + 1], other);
    }
    g.putImageData(img, 0, 0);
  };
}

// ---------- the scare ----------
export function stop() {
  current?.abort();
}

// Loads quietly (the overlay stays hidden), then BOO at once. The overlay then fades away by itself.
export async function scare() {
  if (current) return false;
  prefetch();
  let aborted = false;
  const el = document.createElement('div');
  el.className = 'scare';
  el.innerHTML = '<div class="scare-stage"><canvas width="1280" height="720"></canvas></div><div class="scare-red"></div>';
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, preload: 'auto' });
  video.setAttribute('playsinline', '');
  video.className = 'scare-src';
  el.append(video);
  document.body.append(el);
  const token = { abort: () => { aborted = true; el.remove(); if (current === token) current = null; } };
  current = token;
  const finish = (ok) => { if (current === token) current = null; return ok; };

  const canvas = el.querySelector('canvas');
  const draw = webglKeyer(canvas) || canvasKeyer(canvas);

  const [src, buf] = await Promise.all([videoBlob, decodedSound()]);
  video.src = src;
  if (!buf) { video.muted = false; video.volume = 1; } // no Web Audio: let the video itself scream
  // Show it the moment playback starts (phones may ignore preloading, so don't wait for "can play through").
  await Promise.race([video.play().catch(() => { video.muted = true; return video.play(); }).catch(() => {}), sleep(3000)]);
  if (aborted) return finish(false);

  let raf = 0;
  const loop = () => { if (video.readyState >= 2) draw(video); if (!video.ended) raf = requestAnimationFrame(loop); };
  if (buf) playSound(buf);
  loop();
  el.classList.add('boo');
  try { navigator.vibrate?.([350, 60, 350, 60, 700]); } catch {}

  await sleep(1750);
  cancelAnimationFrame(raf);
  if (aborted) return finish(false);
  el.classList.add('gone');
  setTimeout(() => el.remove(), 600);
  return finish(true);
}
