// PeerJS transport for local multiplayer: one short code instead of manual
// offer/answer copy-paste. Signaling goes through PeerJS's free public server;
// game data stays peer-to-peer over WebRTC (same as the manual transport).
// Implements the same room interface as NetRoom (webrtc.js) so NetSession
// works unchanged: send / sendTo / broadcast / onmessage / onjoin / onleave.

import { parseMsg } from './protocol.js?v=1791286273';

const ID_PREFIX = 'pkmspl-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I

export function genCode(len = 6) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

export class PeerRoom {
  // peerCtor defaults to window.Peer (loaded via <script>); injectable for tests.
  constructor({ onmessage = () => {}, onjoin = () => {}, onleave = () => {} } = {}, peerCtor = null) {
    this.onmessage = onmessage;
    this.onjoin = onjoin;
    this.onleave = onleave;
    this.peerCtor = peerCtor || (typeof window !== 'undefined' ? window.Peer : null);
    this.peer = null;
    this.conns = [];
    this.isHost = false;
    this.closed = false;
  }

  _wire(conn) {
    const idx = this.conns.length;
    this.conns.push(conn);
    conn.on('data', (data) => {
      const m = parseMsg(typeof data === 'string' ? data : '');
      if (m) this.onmessage(idx, m);
    });
    const gone = () => { if (!this.closed) this.onleave(idx); };
    conn.on('close', gone);
    conn.on('error', gone);
    if (conn.open) this.onjoin(idx);
    else conn.on('open', () => this.onjoin(idx));
  }

  _openPeer(id) {
    if (!this.peerCtor) throw new Error('PeerJS not loaded');
    return new Promise((resolve, reject) => {
      const peer = new this.peerCtor(id);
      const timer = setTimeout(() => reject(new Error('peer-timeout')), 15000);
      peer.on('open', () => { clearTimeout(timer); resolve(peer); });
      peer.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Host: claim a short code. Retries on collision. Returns the code. */
  async hostCreate() {
    this.isHost = true;
    let lastErr = null;
    for (let i = 0; i < 4; i++) {
      const code = genCode();
      try {
        this.peer = await this._openPeer(ID_PREFIX + code);
        break;
      } catch (e) {
        lastErr = e;
        if (e && e.type !== 'unavailable-id') throw e;
        this.peer = null;
      }
    }
    if (!this.peer) throw lastErr || new Error('peer-failed');
    this.peer.on('connection', (conn) => this._wire(conn));
    return this.peer.id.slice(ID_PREFIX.length);
  }

  /** Guest: connect with the host's short code. Resolves when the channel opens. */
  async guestJoin(code) {
    this.isHost = false;
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4,8}$/.test(clean)) throw new Error('bad code');
    this.peer = await this._openPeer();
    const conn = this.peer.connect(ID_PREFIX + clean, { reliable: true });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect-timeout')), 15000);
      conn.on('open', () => { clearTimeout(timer); resolve(); });
      conn.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this._wire(conn);
  }

  sendTo(i, msg) {
    const c = this.conns[i];
    if (c && c.open) c.send(msg);
  }

  broadcast(msg, except = -1) {
    this.conns.forEach((c, i) => { if (i !== except) this.sendTo(i, msg); });
  }

  send(msg) {
    this.sendTo(0, msg);
  }

  close() {
    this.closed = true;
    for (const c of this.conns) { try { c.close(); } catch {} }
    try { this.peer && this.peer.destroy(); } catch {}
    this.conns = [];
    this.peer = null;
  }
}
