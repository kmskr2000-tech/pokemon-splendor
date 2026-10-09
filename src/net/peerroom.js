// PeerJS transport for local multiplayer: one short code instead of manual
// offer/answer copy-paste. Signaling goes through PeerJS's free public server;
// game data stays peer-to-peer over WebRTC (same as the manual transport).
// Implements the same room interface as NetRoom (webrtc.js) so NetSession
// works unchanged: send / sendTo / broadcast / onmessage / onjoin / onleave.

import { parseMsg } from './protocol.js?v=1791552480';

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
      const timer = setTimeout(() => {
        try { peer.destroy(); } catch {}
        reject(new Error('peer-timeout'));
      }, 8000);
      peer.on('open', () => { clearTimeout(timer); resolve(peer); });
      peer.on('error', (e) => {
        clearTimeout(timer);
        try { peer.destroy(); } catch {}
        reject(e);
      });
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
  async guestJoin(code, onRetry = null) {
    this.isHost = false;
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4,8}$/.test(clean)) throw new Error('bad code');
    // Retry up to 2 times: the public PeerJS server is flaky in peak hours.
    // Each attempt is guarded by a token so late events from an old attempt are ignored.
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const myAttempt = Symbol('attempt');
      this._joinAttempt = myAttempt;
      try {
        if (attempt > 1 && onRetry) onRetry(attempt);
        // Fresh peer each attempt (old one may be in a bad state).
        try { this.peer && this.peer.destroy(); } catch {}
        this.peer = null;
        this.peer = await this._openPeer();
        if (this._joinAttempt !== myAttempt) throw new Error('cancelled');
        const conn = this.peer.connect(ID_PREFIX + clean, { reliable: true });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect-timeout')), 8000);
          conn.on('open', () => {
            if (this._joinAttempt !== myAttempt) return; // stale attempt
            clearTimeout(timer);
            resolve();
          });
          conn.on('error', (e) => {
            if (this._joinAttempt !== myAttempt) return; // stale attempt
            clearTimeout(timer);
            // Distinguish "room not found" from network issues.
            if (e && e.type === 'peer-unavailable') {
              const err = new Error('room-not-found');
              err.cause = e;
              reject(err);
            } else {
              reject(e);
            }
          });
        });
        if (this._joinAttempt !== myAttempt) throw new Error('cancelled');
        this._wire(conn);
        this._joinAttempt = null;
        return;
      } catch (e) {
        if (e && e.message === 'room-not-found') throw e; // don't retry a wrong code
        if (e && e.message === 'cancelled') throw e;
        lastErr = e;
        try { this.peer && this.peer.destroy(); } catch {}
        this.peer = null;
        // Wait a bit before retrying.
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    this._joinAttempt = null;
    throw lastErr || new Error('connect-failed');
  }

  /** Cancel an in-progress guestJoin (e.g. user pressed cancel). */
  cancelJoin() {
    this._joinAttempt = Symbol('cancelled');
    try { this.peer && this.peer.destroy(); } catch {}
    this.peer = null;
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
