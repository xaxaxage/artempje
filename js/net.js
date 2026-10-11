// Peer-to-peer networking via PeerJS (WebRTC). The host's browser is the "server":
// it registers a peer id derived from the room code, phones connect to it directly.
// The public PeerJS cloud is used only for the initial handshake.
const PREFIX = 'plyukh-room-v1-';
const PING_MS = 3000;
const DEAD_MS = 11000;

export const randomCode = () => String(Math.floor(1000 + Math.random() * 9000));

const ERR_TEXT = {
  'browser-incompatible': 'Этот браузер не поддерживает WebRTC',
  network: 'Нет связи с сервером соединений. Проверь интернет',
  'server-error': 'Сервер соединений недоступен, попробуй позже',
  'socket-error': 'Нет связи с сервером соединений',
  'socket-closed': 'Связь с сервером соединений прервалась',
  'unavailable-id': 'Этот код комнаты уже занят',
  'peer-unavailable': 'Комната не найдена',
};
export const errText = (e) => ERR_TEXT[e?.type] || e?.message || 'Ошибка соединения';

export class Host {
  constructor({ onData, onClose }) {
    this.onData = onData;
    this.onClose = onClose;
    this.conns = new Set();
  }

  // Resolves with the room code. `wanted` is reused when resuming a game.
  start(wanted) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = (code) => {
        const peer = new Peer(PREFIX + code, { debug: 1 });
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer;
          this.code = code;
          this.ping = setInterval(() => this.heartbeat(), PING_MS);
          resolve(code);
        });
        peer.on('connection', (conn) => this.accept(conn));
        peer.on('disconnected', () => {
          if (!this.destroyed) setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch {} }, 1500);
        });
        peer.on('error', (err) => {
          if (opened) { console.warn('peer error', err.type, err); return; }
          peer.destroy();
          tries++;
          if (err.type === 'unavailable-id') {
            // Our old id may linger for a few seconds after a page reload.
            if (wanted && tries < 8) return setTimeout(() => attempt(code), 1500);
            if (tries < 20) return attempt(randomCode());
          }
          reject(err);
        });
      };
      attempt(wanted || randomCode());
    });
  }

  accept(conn) {
    conn._seen = Date.now();
    conn.on('open', () => { this.conns.add(conn); conn._seen = Date.now(); });
    conn.on('data', (d) => {
      conn._seen = Date.now();
      if (!d || typeof d !== 'object') return;
      if (d.t === 'pong') return;
      if (d.t === 'ping') return this.send(conn, { t: 'pong' });
      this.onData(conn, d);
    });
    const closed = () => {
      if (conn._closed) return;
      conn._closed = true;
      this.conns.delete(conn);
      this.onClose(conn);
    };
    conn.on('close', closed);
    conn.on('error', closed);
    conn._kill = closed;
  }

  heartbeat() {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (now - c._seen > DEAD_MS) { try { c.close(); } catch {} c._kill(); continue; }
      this.send(c, { t: 'ping' });
    }
  }

  send(conn, msg) {
    try { if (conn.open) conn.send(msg); } catch {}
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.ping);
    for (const c of this.conns) { try { c.close(); } catch {} }
    try { this.peer?.destroy(); } catch {}
  }
}

export class Client {
  constructor(code, { onOpen, onData, onStatus, onNoRoom }) {
    Object.assign(this, { code, onOpen, onData, onStatus, onNoRoom });
    this.everOpen = false;
  }

  connect() {
    if (this.stopped) return;
    // Events from a previous attempt must not touch the current one.
    const gen = (this.gen = (this.gen || 0) + 1);
    this.cleanup();
    const live = () => gen === this.gen && !this.stopped;
    this.onStatus?.('connecting');
    const peer = (this.peer = new Peer({ debug: 1 }));
    this.openTimer = setTimeout(() => live() && this.lost(), 15000);
    peer.on('open', () => {
      if (!live()) return;
      const conn = (this.conn = peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' }));
      conn.on('open', () => {
        if (!live()) return;
        clearTimeout(this.openTimer);
        this.everOpen = true;
        this.last = Date.now();
        this.onStatus?.('online');
        this.onOpen?.();
      });
      conn.on('data', (d) => {
        if (!live()) return;
        this.last = Date.now();
        if (!d || typeof d !== 'object') return;
        if (d.t === 'ping') return this.send({ t: 'pong' });
        if (d.t === 'pong') return;
        this.onData(d);
      });
      conn.on('close', () => live() && this.lost());
      conn.on('error', () => live() && this.lost());
    });
    peer.on('error', (err) => {
      if (!live()) return;
      clearTimeout(this.openTimer);
      if (err.type === 'peer-unavailable' && !this.everOpen) { this.stop(); this.onNoRoom?.(); return; }
      this.lost();
    });
    clearInterval(this.watch);
    this.watch = setInterval(() => {
      if (this.conn?.open && Date.now() - this.last > DEAD_MS) this.lost();
    }, 2000);
  }

  lost() {
    if (this.stopped || this.retry) return;
    this.onStatus?.('lost');
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 2000);
  }

  send(m) {
    try { if (this.conn?.open) { this.conn.send(m); return true; } } catch {}
    return false;
  }

  cleanup() {
    clearTimeout(this.openTimer);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = null;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.watch);
    this.cleanup();
  }
}
