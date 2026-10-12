// Room-code trap: room 6666 never exists. The join page pretends to connect, the screen slowly goes dark,
// and after a pause Foxy (keyed off his green screen in WebGL) jumps out with the scream at full loudness.
// The scream (assets/screamer.wav) is normalized and soft-clipped to be as loud as a file can be.
export const SCARE_CODE = '6666';

const VIDEO = new URL('../assets/screamer.mp4', import.meta.url).href;
const SOUND = new URL('../assets/screamer.wav', import.meta.url).href;

let ctx = null;
let videoBlob = null; // Promise<string> object URL, so playback starts without network delays
let soundBytes = null; // Promise<ArrayBuffer|null>
let current = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts downloading early (no sound needed yet), e.g. when the trap code is typed.
export function prefetch() {
  videoBlob ||= fetch(VIDEO).then((r) => r.blob()).then((b) => URL.createObjectURL(b)).catch(() => VIDEO);
  soundBytes ||= fetch(SOUND).then((r) => r.arrayBuffer()).catch(() => null);
}

// Must be called inside a tap/submit handler: browsers unlock sound only during a user gesture.
export function arm() {
  prefetch();
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // iPhone: ignore the silent switch
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    const s = ctx.createBufferSource(); // the classic iOS unlock: play one silent sample now
    s.buffer = ctx.createBuffer(1, 1, 22050);
    s.connect(ctx.destination);
    s.start(0);
  } catch { ctx = null; }
}

async function decodedSound() {
  const bytes = await soundBytes;
  if (!ctx || !bytes) return null;
  // Callback form: older Safari has no promise-returning decodeAudioData.
  return new Promise((res) => ctx.decodeAudioData(bytes.slice(0), res, () => res(null))).catch(() => null);
}

function playSound(buf) {
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

// Dims the page to black, waits, screams. Resolves true when it's over (the overlay then fades by itself),
// false if stop() cancelled it.
export async function scare() {
  stop();
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
  const token = { abort: () => { aborted = true; el.remove(); } };
  current = token;

  const canvas = el.querySelector('canvas');
  const draw = webglKeyer(canvas) || canvasKeyer(canvas);

  el.getBoundingClientRect();
  el.classList.add('dark'); // the lights slowly go out
  const [src, buf] = await Promise.all([videoBlob, decodedSound(), sleep(1600)]);
  video.src = src;
  await Promise.race([new Promise((r) => { video.oncanplaythrough = r; video.onerror = r; }), sleep(4000)]);
  await sleep(1200 + Math.random() * 1600); // ...and nothing happens. Lean closer.
  if (aborted) return false;

  let raf = 0;
  const loop = () => { if (video.readyState >= 2) draw(video); if (!video.ended) raf = requestAnimationFrame(loop); };
  if (buf) {
    await video.play().catch(() => {});
    playSound(buf);
  } else {
    video.muted = false; // no Web Audio: let the video itself scream
    video.volume = 1;
    await video.play().catch(() => { video.muted = true; return video.play().catch(() => {}); });
  }
  loop();
  el.classList.add('boo');
  try { navigator.vibrate?.([350, 60, 350, 60, 700]); } catch {}

  await sleep(1750);
  cancelAnimationFrame(raf);
  el.classList.add('over'); // cut to black
  await sleep(450);
  if (current === token) current = null;
  if (aborted) return false;
  el.classList.add('gone');
  setTimeout(() => el.remove(), 600);
  return true;
}
