// Firebase Realtime Database signaling for multiplayer.
// Replaces PeerRoom (PeerJS public server) with Google's infrastructure.
// Game data still goes peer-to-peer over WebRTC DataChannel; Firebase is
// only used to exchange SDP offers/answers and ICE candidates.
//
// Uses the Firebase compat SDK loaded via <script> tags in index.html
// (firebase-app-compat.js + firebase-database-compat.js).
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

import { parseMsg } from './protocol.js?v=1791447014';

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
let _mockDb = null;

/** For tests: inject a mock database. Pass null to reset. */
export function __setMockDb(db) {
  _mockDb = db;
  _db = db;
}

function getDb() {
  if (_db) return _db;
  if (_mockDb) { _db = _mockDb; return _db; }
  // Firebase compat SDK loaded via <script> tags in index.html.
  const fb = (typeof window !== 'undefined' && window.firebase) || null;
  const cfg = (typeof window !== 'undefined' && window.__FIREBASE_CONFIG) || null;
  if (!fb) throw new Error('firebase-sdk-not-loaded');
  if (!cfg || !cfg.apiKey || cfg.apiKey === 'YOUR_API_KEY') throw new Error('firebase-not-configured');
  if (!fb.apps || fb.apps.length === 0) {
    fb.initializeApp(cfg);
  }
  _db = fb.database();
  return _db;
}

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
    // host: [{pc, dc, guestId}]
    // guest: single pc/dc to host
    this.peers = [];
    this.code = null;
    this._joinToken = null;
    this._dbRefs = []; // {ref, cb} to detach on close
  }

  _track(ref, cb) {
    ref.on('value', cb);
    this._dbRefs.push({ ref, cb });
  }

  _untrackAll() {
    for (const { ref, cb } of this._dbRefs) {
      try { ref.off('value', cb); } catch {}
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
    const db = getDb();
    if (db === _mockDb && _mockDb && _mockDb.__isMock) {
      // Test mock path (not used in production).
      throw new Error('mock-use-override');
    }
    for (let i = 0; i < 4; i++) {
      const code = genCode();
      const roomRef = db.ref(`${ROOMS_PATH}/${code}`);
      const snap = await roomRef.once('value');
      if (snap.exists()) continue; // collision, retry
      await roomRef.set({ created: Date.now() });
      this.code = code;
      this._db = db;
      // Listen for new guest handshakes.
      const hsRef = db.ref(`${ROOMS_PATH}/${code}/handshakes`);
      this._track(hsRef, (hsSnap) => this._onHandshakes(hsSnap));
      return code;
    }
    throw new Error('room-create-failed');
  }

  _onHandshakes(hsSnap) {
    if (this.closed || !hsSnap.exists()) return;
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
    const db = this._db;
    const base = `${ROOMS_PATH}/${this.code}/handshakes/${guestId}`;
    const pc = makePC();
    const idx = this.peers.length;
    const peer = { pc, dc: null, guestId };
    this.peers.push(peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        db.ref(`${base}/hc`).push(e.candidate.toJSON()).catch(() => {});
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
    await db.ref(`${base}/answer`).set({ type: answer.type, sdp: answer.sdp });

    // Listen for guest ICE candidates.
    const gcRef = db.ref(`${base}/gc`);
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
    const db = getDb();
    this._db = db;

    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = Symbol('join');
      this._joinToken = token;
      let pc = null;
      let guestId = null;
      try {
        if (attempt > 1 && onRetry) onRetry(attempt);
        // Room must exist.
        const roomSnap = await db.ref(`${ROOMS_PATH}/${clean}`).once('value');
        if (!roomSnap.exists()) throw new Error('room-not-found');

        guestId = genId();
        const base = `${ROOMS_PATH}/${clean}/handshakes/${guestId}`;
        pc = makePC();
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
            db.ref(`${base}/gc`).push(e.candidate.toJSON()).catch(() => {});
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await db.ref(`${base}/offer`).set({ type: offer.type, sdp: offer.sdp });

        // Wait for host's answer.
        const answerRef = db.ref(`${base}/answer`);
        const answerPromise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect-timeout')), JOIN_TIMEOUT_MS);
          const cb = async (snap) => {
            if (!snap.exists()) return;
            if (this._joinToken !== token) return;
            clearTimeout(timer);
            answerRef.off('value', cb);
            try {
              const a = snap.val();
              await pc.setRemoteDescription(new RTCSessionDescription(a));
              resolve();
            } catch (e) { reject(e); }
          };
          answerRef.on('value', cb);
          this._dbRefs.push({ ref: answerRef, cb });
        });

        // Listen for host ICE candidates.
        const hcRef = db.ref(`${base}/hc`);
        const seen = new Set();
        const hcCb = (snap) => {
          if (!snap.exists() || this._joinToken !== token) return;
          snap.forEach((c) => {
            if (seen.has(c.key)) return;
            seen.add(c.key);
            pc.addIceCandidate(new RTCIceCandidate(c.val())).catch(() => {});
          });
        };
        hcRef.on('value', hcCb);
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
          if (guestId) await db.ref(`${ROOMS_PATH}/${clean}/handshakes/${guestId}`).remove();
          if (pc) pc.close();
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

  // ---------- messaging ----------

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
    if (this.isHost && this.code && this._db && this._db !== _mockDb) {
      try {
        await this._db.ref(`${ROOMS_PATH}/${this.code}`).remove();
      } catch {}
    }
    this.code = null;
  }
}
