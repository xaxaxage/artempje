// Delivers clue media from the host's browser to phones.
// Links (http, YouTube) are loaded by the phone itself; stored files and data: URLs are streamed
// over the JSON data channel in small base64 chunks (PeerJS rejects JSON messages over ~16 KB).
import * as db from './db.js?v=1791795754282';
import { kindOf } from './media.js?v=1791795754282';

const CHUNK = 9000; // bytes per message: 12 000 base64 chars, well under the limit
const PREFETCH_MAX = 15e6; // bigger files are only sent when their clue is opened
const keyCache = new Map(); // data URL -> key

function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + s.length.toString(36);
}

// Key for media that has to be transferred; null when the phone can load it by itself.
export function mediaKey(ref) {
  if (!ref) return null;
  if (ref.kind === 'file') return 'f:' + ref.id;
  if (ref.kind === 'url' && ref.url.startsWith('data:')) {
    let k = keyCache.get(ref.url);
    if (!k) { k = 'd:' + strHash(ref.url); keyCache.set(ref.url, k); }
    return k;
  }
  return null;
}

// What a phone needs to know to show a ref.
export function describe(ref) {
  if (!ref) return null;
  const k = kindOf(ref);
  if (ref.kind === 'youtube') return { k, vid: ref.vid, start: ref.start || 0 };
  const key = mediaKey(ref);
  return key ? { k, key } : { k, url: ref.url };
}

const toB64 = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backlog = (conn) => (conn.dataChannel?.bufferedAmount || 0) + (conn.bufferSize || 0) * 16000;

export class MediaSender {
  constructor(send) {
    this.send = send;
    this.refs = new Map();
    this.blobs = new Map();
  }

  state(conn) {
    return (conn._media ||= { sent: new Set(), queue: [], urgent: new Set(), current: null, preempt: false, running: false });
  }

  // The phone already has these (it keeps its cache across reconnects).
  have(conn, keys) {
    const st = this.state(conn);
    for (const k of keys || []) st.sent.add(k);
  }

  // Queue a ref for one phone. `urgent`: its clue is on screen right now, so it jumps the queue.
  want(conn, ref, urgent = false) {
    const key = mediaKey(ref);
    if (!key) return;
    this.refs.set(key, ref);
    const st = this.state(conn);
    if (st.sent.has(key) || st.current === key) return;
    const i = st.queue.indexOf(key);
    if (i >= 0) {
      if (!urgent || i === 0) return;
      st.queue.splice(i, 1);
    }
    if (urgent) {
      st.urgent.add(key);
      st.queue.unshift(key);
      if (st.current) st.preempt = true;
    } else {
      st.queue.push(key);
    }
    this.pump(conn);
  }

  async blob(key) {
    if (this.blobs.has(key)) return this.blobs.get(key);
    const ref = this.refs.get(key);
    let b = null;
    try {
      if (ref?.kind === 'file') b = (await db.getMedia(ref.id))?.blob || null;
      else if (ref) b = await (await fetch(ref.url)).blob();
    } catch {}
    if (b) this.blobs.set(key, b);
    return b;
  }

  async pump(conn) {
    const st = this.state(conn);
    if (st.running) return;
    st.running = true;
    try {
      while (conn.open && st.queue.length) {
        const key = st.queue.shift();
        if (st.sent.has(key)) continue;
        const blob = await this.blob(key);
        if (!blob || (blob.size > PREFETCH_MAX && !st.urgent.has(key))) continue;
        st.current = key;
        st.preempt = false;
        this.send(conn, { t: 'm0', key, mime: blob.type || this.refs.get(key)?.mime || '', size: blob.size });
        let aborted = false;
        for (let off = 0; off < blob.size; off += CHUNK) {
          while (conn.open && backlog(conn) > 256e3 && !st.preempt) await sleep(25);
          if (!conn.open || st.preempt) { aborted = true; break; }
          this.send(conn, { t: 'm1', key, d: toB64(new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer())) });
        }
        st.current = null;
        if (aborted) {
          // A more urgent file arrived: start this one over later.
          if (conn.open) { this.send(conn, { t: 'mx', key }); st.queue.push(key); }
          continue;
        }
        this.send(conn, { t: 'm2', key });
        st.sent.add(key);
      }
    } finally {
      st.running = false;
    }
  }
}

// Phone side: assembles incoming chunks into object URLs.
export class MediaReceiver {
  constructor(onChange) {
    this.onChange = onChange;
    this.urls = new Map();
    this.parts = new Map();
  }

  // Returns true when the message was a media message.
  handle(d) {
    switch (d.t) {
      case 'm0':
        this.parts.set(d.key, { mime: d.mime, size: d.size, got: 0, chunks: [] });
        this.onChange(d.key);
        return true;
      case 'm1': {
        const p = this.parts.get(d.key);
        if (!p) return true;
        const bin = atob(d.d);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        p.chunks.push(u8);
        p.got += u8.length;
        this.onChange(d.key, true);
        return true;
      }
      case 'm2': {
        const p = this.parts.get(d.key);
        if (!p) return true;
        this.urls.set(d.key, URL.createObjectURL(new Blob(p.chunks, { type: p.mime })));
        this.parts.delete(d.key);
        this.onChange(d.key);
        return true;
      }
      case 'mx':
        this.parts.delete(d.key);
        this.onChange(d.key);
        return true;
    }
    return false;
  }

  url(key) { return this.urls.get(key) || null; }

  progress(key) {
    const p = this.parts.get(key);
    return p && p.size ? p.got / p.size : 0;
  }

  keys() { return [...this.urls.keys()]; }
}
