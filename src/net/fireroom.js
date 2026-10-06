// Firebase Realtime Database signaling for multiplayer.
// Replaces PeerRoom (PeerJS public server) with Google's infrastructure.
// Game data still goes peer-to-peer over WebRTC DataChannel; Firebase is
// only used to exchange SDP offers/answers and ICE candidates.
//
// Same room interface as PeerRoom so NetSession works unchanged:
//   hostCreate() -> code | guestJoin(code, onRetry) | cancelJoin()
//   send / sendTo / broadcast / onmessage / onjoin / onleave / close
//
// RTDB layout:
//   pkmspl-rooms/{CODE}/
//     created: timestamp
//     handshakes/{guestId}/
//       offer: {type, sdp}            <- guest writes
//       answer: {type, sdp}           <- host writes
//       gc: {pushId: candidate}       <- guest ICE candidates
//       hc: {pushId: candidate}       <- host ICE candidates

import { parseMsg } from './protocol.js?v=1791295102';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
const ROOMS_PATH = 'pkmspl-rooms';
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const JOIN_TIMEOUT_MS = 10000;

export function genCode(len = 6) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

function genId(len = 12) {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

let _db = null;
let _sdkPromise = null;
let _mockDb = null;

/** For tests: inject a mock database. Pass null to reset. */
export function __setMockDb(db) {
  _mockDb = db;
  _db = db;
  if (!db) _sdkPromise = null;
}

async function getDb() {
  if (_db) return _db;
  if (_mockDb) { _db = _mockDb; return _db; }
  if (!_sdkPromise) {
    _sdkPromise = (async () => {
      const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js?v=1791295102');
      const dbMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js?v=1791295102');
      const cfg = (typeof window !== 'undefined' && window.__FIREBASE_CONFIG) || null;
      if (!cfg || !cfg.apiKey) throw new Error('firebase-not-configured');
      const app = appMod.initializeApp(cfg);
      _db = dbMod.getDatabase(app);
      _db._mod = dbMod; // stash for reuse
      return _db;
    })();
  }
  return _sdkPromise;
}

function dbMod(db) { return db._mod; }

function makePC() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}

export class FirebaseRoom {
  constructor({ onmessage = () => {}, onjoin = () => {}, onleave = () => {} } = {}) {
    this.onmessage = onmessage;
    this.onjoin = onjoin;
    this.onleave = onleave;
    this.isHost = false;
    this.closed = false;
    // host: [{pc, dc, guestId, listeners}]
    // guest: single pc/dc to host
    this.peers = [];
    this.code = null;
    this._joinToken = null;
    this._dbRefs = []; // {ref, cb} to detach on close
  }

  _track(ref, cb) {
    const db = this._db;
    const m = dbMod(db);
    m.onValue(ref, cb);
    this._dbRefs.push({ ref, cb });
  }

  _untrackAll() {
    if (!this._db) return;
    const m = dbMod(this._db);
    for (const { ref, cb } of this._dbRefs) {
      try { m.off(ref, 'value', cb); } catch {}
    }
    this._dbRefs = [];
  }

  _wireDataChannel(dc, idx) {
    dc.onmessage = (e) => {
      const m = parseMsg(typeof e.data === 'string' ? e.data : '');
      if (m) this.onmessage(idx, m);
    };
    const gone = () => { if (!this.closed) this.onleave(idx); };
    dc.onclose = gone;
    dc.onerror = gone;
  }

  // ---------- host ----------

  /** Host: create a room, return the 6-char code. */
  async hostCreate() {
    this.isHost = true;
    this._db = await getDb();
    const m = dbMod(this._db);
    for (let i = 0; i < 4; i++) {
      const code = genCode();
      const roomRef = m.ref(this._db, `${ROOMS_PATH}/${code}`);
      const snap = await m.get(roomRef);
      if (snap.exists()) continue; // collision, retry
      await m.set(roomRef, { created: Date.now() });
      this.code = code;
      // Listen for new guest handshakes.
      const hsRef = m.ref(this._db, `${ROOMS_PATH}/${code}/handshakes`);
      this._track(hsRef, (hsSnap) => this._onHandshakes(hsSnap));
      return code;
    }
    throw new Error('room-create-failed');
  }

  async _onHandshakes(hsSnap) {
    if (this.closed || !hsSnap.exists()) return;
    const m = dbMod(this._db);
    hsSnap.forEach((child) => {
      const guestId = child.key;
      const hs = child.val() || {};
      // Skip if we already handle this guest, or no offer yet, or already answered.
      if (this.peers.some((p) => p.guestId === guestId)) return;
      if (!hs.offer || hs.answer) return;
      this._acceptGuest(guestId, hs.offer).catch(() => {});
    });
  }

  async _acceptGuest(guestId, offer) {
    const m = dbMod(this._db);
    const base = `${ROOMS_PATH}/${this.code}/handshakes/${guestId}`;
    const pc = makePC();
    const idx = this.peers.length;
    const peer = { pc, dc: null, guestId };
    this.peers.push(peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        m.push(m.ref(this._db, `${base}/hc`), e.candidate.toJSON()).catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (!this.closed) this.onleave(idx);
      }
    };
    pc.ondatachannel = (e) => {
      peer.dc = e.channel;
      this._wireDataChannel(peer.dc, idx);
      peer.dc.onopen = () => { if (!this.closed) this.onjoin(idx); };
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await m.set(m.ref(this._db, `${base}/answer`), { type: answer.type, sdp: answer.sdp });

    // Listen for guest ICE candidates.
    const gcRef = m.ref(this._db, `${base}/gc`);
    const seen = new Set();
    this._track(gcRef, (snap) => {
      if (!snap.exists()) return;
      snap.forEach((c) => {
        if (seen.has(c.key)) return;
        seen.add(c.key);
        pc.addIceCandidate(new RTCIceCandidate(c.val())).catch(() => {});
      });
    });
  }

  // ---------- guest ----------

  /** Guest: join with the host's code. Resolves when the DataChannel opens. */
  async guestJoin(code, onRetry = null) {
    this.isHost = false;
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4,8}$/.test(clean)) throw new Error('bad code');
    this._db = await getDb();
    const m = dbMod(this._db);

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = Symbol('join');
      this._joinToken = token;
      try {
        if (attempt > 1 && onRetry) onRetry(attempt);
        // Room must exist.
        const roomSnap = await m.get(m.ref(this._db, `${ROOMS_PATH}/${clean}`));
        if (!roomSnap.exists()) throw new Error('room-not-found');

        const guestId = genId();
        const base = `${ROOMS_PATH}/${clean}/handshakes/${guestId}`;
        const pc = makePC();
        const dc = pc.createDataChannel('game');
        const peer = { pc, dc, guestId };
        this.peers = [peer];

        const openPromise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect-timeout')), JOIN_TIMEOUT_MS);
          dc.onopen = () => {
            if (this._joinToken !== token) return;
            clearTimeout(timer);
            resolve();
          };
          dc.onerror = (e) => {
            if (this._joinToken !== token) return;
            clearTimeout(timer);
            reject(e);
          };
          pc.onconnectionstatechange = () => {
            if (this._joinToken !== token) return;
            if (pc.connectionState === 'failed') {
              clearTimeout(timer);
              reject(new Error('connect-timeout'));
            }
          };
        });

        this._wireDataChannel(dc, 0);

        pc.onicecandidate = (e) => {
          if (e.candidate && this._joinToken === token) {
            m.push(m.ref(this._db, `${base}/gc`), e.candidate.toJSON()).catch(() => {});
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await m.set(m.ref(this._db, `${base}/offer`), { type: offer.type, sdp: offer.sdp });

        // Wait for host's answer.
        const answerRef = m.ref(this._db, `${base}/answer`);
        const answerPromise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect-timeout')), JOIN_TIMEOUT_MS);
          const cb = async (snap) => {
            if (!snap.exists()) return;
            if (this._joinToken !== token) return;
            clearTimeout(timer);
            m.off(answerRef, 'value', cb);
            try {
              const a = snap.val();
              await pc.setRemoteDescription(new RTCSessionDescription(a));
              resolve();
            } catch (e) { reject(e); }
          };
          m.onValue(answerRef, cb);
          this._dbRefs.push({ ref: answerRef, cb });
        });

        // Listen for host ICE candidates.
        const hcRef = m.ref(this._db, `${base}/hc`);
        const seen = new Set();
        const hcCb = (snap) => {
          if (!snap.exists() || this._joinToken !== token) return;
          snap.forEach((c) => {
            if (seen.has(c.key)) return;
            seen.add(c.key);
            pc.addIceCandidate(new RTCIceCandidate(c.val())).catch(() => {});
          });
        };
        m.onValue(hcRef, hcCb);
        this._dbRefs.push({ ref: hcRef, cb: hcCb });

        await answerPromise;
        if (this._joinToken !== token) throw new Error('cancelled');
        await openPromise;
        if (this._joinToken !== token) throw new Error('cancelled');
        this._joinToken = null;
        this.code = clean;
        return;
      } catch (e) {
        if (e && (e.message === 'room-not-found' || e.message === 'cancelled')) {
          this._joinToken = null;
          throw e;
        }
        lastErr = e;
        // Clean up this attempt's handshake node.
        try {
          const p = this.peers[0];
          if (p && p.guestId) await m.remove(m.ref(this._db, `${ROOMS_PATH}/${clean}/handshakes/${p.guestId}`));
          if (p && p.pc) p.pc.close();
        } catch {}
        this.peers = [];
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    this._joinToken = null;
    throw lastErr || new Error('connect-failed');
  }

  /** Cancel an in-progress guestJoin. */
  cancelJoin() {
    this._joinToken = Symbol('cancelled');
    for (const p of this.peers) { try { p.pc && p.pc.close(); } catch {} }
    this.peers = [];
  }

  // ---------- messaging (same as PeerRoom) ----------

  _dc(i) {
    const p = this.peers[i];
    return p && p.dc && p.dc.readyState === 'open' ? p.dc : null;
  }

  sendTo(i, msg) {
    const dc = this._dc(i);
    if (dc) { try { dc.send(msg); } catch {} }
  }

  broadcast(msg, except = -1) {
    this.peers.forEach((_, i) => { if (i !== except) this.sendTo(i, msg); });
  }

  send(msg) {
    this.sendTo(0, msg);
  }

  async close() {
    this.closed = true;
    this._joinToken = Symbol('closed');
    this._untrackAll();
    for (const p of this.peers) { try { p.pc && p.pc.close(); } catch {} }
    this.peers = [];
    // Host removes the room so codes don't linger.
    if (this.isHost && this.code && this._db) {
      try {
        const m = dbMod(this._db);
        await m.remove(m.ref(this._db, `${ROOMS_PATH}/${this.code}`));
      } catch {}
    }
    this.code = null;
  }
}
