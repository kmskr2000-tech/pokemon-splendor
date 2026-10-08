// Firebase Realtime Database multiplayer.
// Uses Firebase RTDB for BOTH signaling and message delivery.
// No WebRTC — this bypasses NAT/firewall issues entirely.
// Game messages go through Firebase (slightly slower but reliable).
//
// Same room interface as PeerRoom so NetSession works unchanged:
//   hostCreate() -> code | guestJoin(code, onRetry) | cancelJoin()
//   send / sendTo / broadcast / onmessage / onjoin / onleave / close
//
// RTDB layout:
//   pkmspl-rooms/{CODE}/
//     created: timestamp
//     hostName: string
//     guests/{guestId}/: { name, joinedAt }
//     msgs/
//       toHost/{pushId}: { from: guestId, data: msgString }
//       toGuest/{guestId}/{pushId}: { data: msgString }

import { parseMsg } from './protocol.js?v=1791458692';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
const ROOMS_PATH = 'pkmspl-rooms';

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

/** List available rooms for the lobby. Returns [{code, title, hostName, playerCount, created}]. */
export async function listRooms() {
  const db = getDb();
  const snap = await db.ref(ROOMS_PATH).once('value');
  const rooms = [];
  if (!snap.exists()) return rooms;
  const now = Date.now();
  const MAX_AGE_MS = 30 * 60 * 1000; // 30 min
  snap.forEach((child) => {
    const code = child.key;
    const r = child.val() || {};
    // Skip started games and stale ghost rooms.
    if (r.started) return;
    if (r.created && now - r.created > MAX_AGE_MS) return;
    const guests = r.guests ? Object.keys(r.guests).length : 0;
    rooms.push({
      code,
      title: r.title || '제목 없음',
      hostName: r.hostName || '?',
      playerCount: 1 + guests, // host + guests
      created: r.created || 0,
    });
  });
  // Newest first.
  rooms.sort((a, b) => b.created - a.created);
  return rooms;
}

/** Watch room list changes. Returns unsubscribe function. */
export function watchRooms(cb) {
  const db = getDb();
  const ref = db.ref(ROOMS_PATH);
  const handler = (snap) => {
    const rooms = [];
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 min
    if (snap.exists()) {
      snap.forEach((child) => {
        const code = child.key;
        const r = child.val() || {};
        if (r.started) return;
        if (r.created && now - r.created > MAX_AGE_MS) return;
        const guests = r.guests ? Object.keys(r.guests).length : 0;
        rooms.push({
          code,
          title: r.title || '제목 없음',
          hostName: r.hostName || '?',
          playerCount: 1 + guests,
          created: r.created || 0,
        });
      });
      rooms.sort((a, b) => b.created - a.created);
    }
    cb(rooms);
  };
  ref.on('value', handler);
  return () => { try { ref.off('value', handler); } catch {} };
}

export class FirebaseRoom {
  constructor({ onmessage = () => {}, onjoin = () => {}, onleave = () => {} } = {}) {
    this.onmessage = onmessage;
    this.onjoin = onjoin;
    this.onleave = onleave;
    this.isHost = false;
    this.closed = false;
    this.peers = []; // host: [{guestId, name}], guest: [{guestId: 'host'}]
    this.code = null;
    this.myGuestId = null;
    this._joinToken = null;
    this._dbRefs = [];
    this._seenMsgs = new Set();
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

  // ---------- host ----------

  /** Host: create a room, return the 6-char code. */
  async hostCreate(hostName = '', title = '') {
    this.isHost = true;
    const db = getDb();
    this._db = db;
    for (let i = 0; i < 4; i++) {
      const code = genCode();
      const roomRef = db.ref(`${ROOMS_PATH}/${code}`);
      const snap = await roomRef.once('value');
      if (snap.exists()) continue;
      await roomRef.set({
        created: Date.now(),
        title: title || `${hostName}의 방`,
        hostName: hostName || '?',
      });
      this.code = code;
      // Listen for new guests.
      const guestsRef = db.ref(`${ROOMS_PATH}/${code}/guests`);
      this._track(guestsRef, (s) => this._onGuests(s));
      // Listen for messages from guests.
      const inboxRef = db.ref(`${ROOMS_PATH}/${code}/msgs/toHost`);
      this._track(inboxRef, (s) => this._onHostInbox(s));
      return code;
    }
    throw new Error('room-create-failed');
  }

  _onGuests(snap) {
    if (this.closed || !snap.exists()) return;
    snap.forEach((child) => {
      const guestId = child.key;
      const g = child.val() || {};
      if (this.peers.some((p) => p.guestId === guestId)) return;
      const idx = this.peers.length;
      this.peers.push({ guestId, name: g.name || '?' });
      if (!this.closed) this.onjoin(idx);
    });
  }

  _onHostInbox(snap) {
    if (this.closed || !snap.exists()) return;
    snap.forEach((child) => {
      const key = child.key;
      if (this._seenMsgs.has(key)) return;
      const m = child.val() || {};
      let idx = this.peers.findIndex((p) => p.guestId === m.from);
      // Guest may send HELLO before we processed their guests/ entry.
      // Register them on the fly so the message isn't lost.
      if (idx < 0 && m.from) {
        idx = this.peers.length;
        this.peers.push({ guestId: m.from, name: '?' });
        if (!this.closed) this.onjoin(idx);
      }
      if (idx >= 0) {
        this._seenMsgs.add(key);
        const parsed = parseMsg(typeof m.data === 'string' ? m.data : '');
        if (parsed) this.onmessage(idx, parsed);
      }
      // Clean up delivered message (only if we handled it).
      if (idx >= 0) child.ref.remove().catch(() => {});
    });
  }

  // ---------- guest ----------

  /** Guest: join with the host's code. Resolves when host acknowledges. */
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
      try {
        if (attempt > 1 && onRetry) onRetry(attempt);
        const roomSnap = await db.ref(`${ROOMS_PATH}/${clean}`).once('value');
        if (!roomSnap.exists()) throw new Error('room-not-found');

        const guestId = genId();
        this.myGuestId = guestId;
        this.code = clean;
        this.peers = [{ guestId: 'host' }];

        // Register as guest.
        await db.ref(`${ROOMS_PATH}/${clean}/guests/${guestId}`).set({
          name: '',
          joinedAt: Date.now(),
        });

        // Listen for messages from host.
        const inboxRef = db.ref(`${ROOMS_PATH}/${clean}/msgs/toGuest/${guestId}`);
        const seen = new Set();
        const joinToken = token; // capture for closure
        const cb = (snap) => {
          // Skip if join was cancelled (token changed to a different symbol).
          // After successful join, _joinToken is null, which is fine.
          if (!snap.exists() || this.closed) return;
          if (this._joinToken !== null && this._joinToken !== joinToken) return;
          snap.forEach((child) => {
            if (seen.has(child.key)) return;
            seen.add(child.key);
            const m = child.val() || {};
            const parsed = parseMsg(typeof m.data === 'string' ? m.data : '');
            if (parsed) this.onmessage(0, parsed);
            child.ref.remove().catch(() => {});
          });
        };
        inboxRef.on('value', cb);
        this._dbRefs.push({ ref: inboxRef, cb });

        // Fallback: if host started the game but START msg was missed,
        // the room's startInfo will trigger beginGame via onmessage.
        const roomRef = db.ref(`${ROOMS_PATH}/${clean}`);
        const startCb = (snap) => {
          if (!snap.exists() || this.closed) return;
          if (this._joinToken !== null && this._joinToken !== joinToken) return;
          const r = snap.val() || {};
          if (r.started && r.startInfo && !this._startFallbackDone) {
            this._startFallbackDone = true;
            const si = r.startInfo;
            // Simulate receiving START message.
            this.onmessage(0, { t: 'start', seed: si.seed, names: si.names, aiNames: si.aiNames || [] });
          }
        };
        roomRef.on('value', startCb);
        this._dbRefs.push({ ref: roomRef, cb: startCb });

        // Wait for host to acknowledge (host writes welcome via normal message flow).
        // We consider join successful once the inbox listener is active.
        // The session's HELLO/WELCOME exchange happens via onmessage.
        this._joinToken = null;

        // Notify session that we're connected (triggers HELLO).
        setTimeout(() => { if (!this.closed) this.onjoin(0); }, 0);
        return;
      } catch (e) {
        if (e && (e.message === 'room-not-found' || e.message === 'cancelled')) {
          this._joinToken = null;
          throw e;
        }
        lastErr = e;
        try {
          if (this.myGuestId) await db.ref(`${ROOMS_PATH}/${clean}/guests/${this.myGuestId}`).remove();
        } catch {}
        this.peers = [];
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    this._joinToken = null;
    throw lastErr || new Error('connect-failed');
  }

  /** Guest: set display name (called by session after join). */
  async setGuestName(name) {
    if (this.isHost || !this.code || !this.myGuestId || !this._db) return;
    try {
      await this._db.ref(`${ROOMS_PATH}/${this.code}/guests/${this.myGuestId}/name`).set(name);
    } catch {}
  }

  /** Host: mark room as started (removes from lobby, fallback for START msg). */
  async markStarted(startInfo) {
    if (!this.isHost || !this.code || !this._db) return;
    try {
      await this._db.ref(`${ROOMS_PATH}/${this.code}`).update({
        started: true,
        startInfo: startInfo || null,
      });
    } catch {}
  }

  /** Cancel an in-progress guestJoin. */
  cancelJoin() {
    this._joinToken = Symbol('cancelled');
    this._cleanupGuest();
  }

  async _cleanupGuest() {
    if (!this.isHost && this.code && this.myGuestId && this._db) {
      try {
        await this._db.ref(`${ROOMS_PATH}/${this.code}/guests/${this.myGuestId}`).remove();
      } catch {}
    }
  }

  // ---------- messaging ----------

  async sendTo(i, msg) {
    if (this.closed || !this._db || !this.code) return;
    const db = this._db;
    try {
      if (this.isHost) {
        const peer = this.peers[i];
        if (!peer) return;
        await db.ref(`${ROOMS_PATH}/${this.code}/msgs/toGuest/${peer.guestId}`).push({ data: msg });
      } else {
        // Guest sends to host.
        await db.ref(`${ROOMS_PATH}/${this.code}/msgs/toHost`).push({ from: this.myGuestId, data: msg });
      }
    } catch {}
  }

  async broadcast(msg, except = -1) {
    if (!this.isHost) { await this.send(msg); return; }
    const promises = [];
    this.peers.forEach((_, i) => {
      if (i !== except) promises.push(this.sendTo(i, msg));
    });
    await Promise.all(promises);
  }

  async send(msg) {
    await this.sendTo(0, msg);
  }

  async close() {
    this.closed = true;
    this._joinToken = Symbol('closed');
    this._untrackAll();
    if (!this.isHost) {
      await this._cleanupGuest();
    } else if (this.code && this._db) {
      try {
        await this._db.ref(`${ROOMS_PATH}/${this.code}`).remove();
      } catch {}
    }
    this.peers = [];
    this.code = null;
    this.myGuestId = null;
  }
}
