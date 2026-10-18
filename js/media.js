// Media attached to clues. A ref is one of:
//   { kind: 'file', id, mime }      blob stored in IndexedDB
//   { kind: 'url', url, mime }      link to an image/audio/video on the web
//   { kind: 'youtube', vid, start } YouTube video
import * as db from './db.js?v=1792358422380';
import { uid } from './util.js?v=1792358422380';

const urlCache = new Map();

const EXT_MIME = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
};
export function guessMime(name = '') {
  const m = /\.([a-z0-9]+)(?:$|[?#])/i.exec(name);
  return (m && EXT_MIME[m[1].toLowerCase()]) || '';
}

export function kindOf(ref) {
  if (!ref) return null;
  if (ref.kind === 'youtube') return 'youtube';
  const m = ref.mime || '';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'image';
}

export const KIND_LABEL = { image: 'Картинка', audio: 'Аудио', video: 'Видео', youtube: 'YouTube' };
export const KIND_ICON = { image: '🖼', audio: '🎵', video: '🎬', youtube: '▶' };

export async function srcOf(ref) {
  if (!ref) return null;
  if (ref.kind === 'url') return ref.url;
  if (ref.kind === 'file') {
    if (urlCache.has(ref.id)) return urlCache.get(ref.id);
    const rec = await db.getMedia(ref.id);
    if (!rec) return null;
    const u = URL.createObjectURL(rec.blob);
    urlCache.set(ref.id, u);
    return u;
  }
  return null;
}

function ytId(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
    if (m) return m[2];
  }
  return null;
}
function ytStart(u) {
  const t = u.searchParams.get('t') || u.searchParams.get('start');
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

export function parseLink(s) {
  s = (s || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  const vid = ytId(u);
  if (vid) return { kind: 'youtube', vid, start: ytStart(u) };
  if (!['http:', 'https:', 'data:'].includes(u.protocol)) return null;
  const mime = u.protocol === 'data:' ? (s.slice(5).split(/[;,]/)[0] || 'image/png') : guessMime(u.pathname) || 'image/*';
  return { kind: 'url', url: s, mime };
}

async function compressImage(file, force) {
  const MAX = 1920;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  if (!force && scale === 1 && file.size < 1.5e6) { bmp.close?.(); return null; }
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  let out = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.86));
  if (!out || out.type !== 'image/webp') out = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.86));
  if (!out || (!force && out.size >= file.size)) return null;
  return out;
}

export async function storeFile(file) {
  let blob = file;
  let mime = file.type || guessMime(file.name);
  if (!/^(image|audio|video)\//.test(mime)) throw new Error('Можно добавить только картинку, аудио или видео');
  if (/^image\/(jpeg|png|webp|bmp)$/.test(mime) || /heic|heif/.test(mime)) {
    try {
      const c = await compressImage(file, /heic|heif/.test(mime));
      if (c) { blob = c; mime = c.type; }
    } catch {
      if (/heic|heif/.test(mime)) throw new Error('Этот браузер не умеет открывать HEIC. Сохрани фото как JPG');
    }
  }
  if (blob.size > 60e6) throw new Error('Файл слишком большой (больше 60 МБ)');
  const id = uid('m');
  await db.putMedia({ id, blob, mime, name: file.name || '' });
  navigator.storage?.persist?.().catch(() => {});
  return { kind: 'file', id, mime };
}

export function dropRef(ref) {
  if (ref?.kind !== 'file') return;
  db.deleteMedia(ref.id).catch(() => {});
  const u = urlCache.get(ref.id);
  if (u) { URL.revokeObjectURL(u); urlCache.delete(ref.id); }
}

export async function copyRef(ref) {
  if (!ref) return null;
  if (ref.kind !== 'file') return { ...ref };
  const rec = await db.getMedia(ref.id);
  if (!rec) return null;
  const id = uid('m');
  await db.putMedia({ ...rec, id });
  return { ...ref, id };
}

const blobToDataURL = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

// For export: embed stored files as data URLs.
export async function toPortable(ref) {
  if (ref?.kind !== 'file') return ref || null;
  const rec = await db.getMedia(ref.id);
  if (!rec) return null;
  return { kind: 'file', mime: ref.mime, data: await blobToDataURL(rec.blob), ...(ref.phone === false ? { phone: false } : {}) };
}

export async function fromPortable(p) {
  if (!p) return null;
  if (p.kind !== 'file') return p;
  if (!p.data) return null;
  const blob = await (await fetch(p.data)).blob();
  const id = uid('m');
  const mime = p.mime || blob.type;
  await db.putMedia({ id, blob, mime, name: '' });
  return { kind: 'file', id, mime, ...(p.phone === false ? { phone: false } : {}) };
}

export const ytThumb = (vid) => `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

// Builds a DOM node for a ref. `thumb` gives a lightweight preview (for the editor).
export async function mediaEl(ref, { autoplay = false, thumb = false } = {}) {
  const k = kindOf(ref);
  if (k === 'youtube') {
    if (thumb) {
      const d = document.createElement('div');
      d.className = 'media-yt-thumb';
      d.innerHTML = `<img src="${ytThumb(ref.vid)}" alt=""><span>▶</span>`;
      return d;
    }
    const f = document.createElement('iframe');
    f.className = 'media-yt';
    f.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(ref.vid)}?autoplay=${autoplay ? 1 : 0}&start=${ref.start || 0}&rel=0&playsinline=1`;
    f.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture';
    f.allowFullscreen = true;
    return f;
  }
  const src = await srcOf(ref);
  if (!src) {
    const s = document.createElement('div');
    s.className = 'media-missing';
    s.textContent = 'Файл не найден';
    return s;
  }
  if (k === 'image') {
    const img = new Image();
    img.className = 'media-img';
    img.alt = '';
    // SVGs may lack width/height; in a flex layout they then collapse to nothing.
    if (/svg/.test(ref.mime || '')) img.classList.add('nosize');
    img.src = src;
    return img;
  }
  if (k === 'audio') {
    const d = document.createElement('div');
    d.className = 'media-audio';
    d.innerHTML = '<div class="media-audio-icon">🎵</div>';
    const a = document.createElement('audio');
    a.src = src;
    a.controls = true;
    a.preload = 'auto';
    if (autoplay) a.autoplay = true;
    d.append(a);
    return d;
  }
  const v = document.createElement('video');
  v.className = 'media-video';
  v.src = src;
  v.controls = true;
  v.playsInline = true;
  v.preload = thumb ? 'metadata' : 'auto';
  if (autoplay) v.autoplay = true;
  return v;
}
