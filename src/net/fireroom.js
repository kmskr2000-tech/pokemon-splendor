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

import { parseMsg } from './protocol.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
const ROOMS_PATH = 'pkmspl-rooms';

// Presence: heartbeat every HB_INTERVAL_MS; a peer is considered gone when its
// last heartbeat is older than HB_TIMEOUT_MS (host) / HOST_STALE_MS (guests
// watching the host). onDisconnect handlers give fast detection on clean socket
// loss; heartbeats cover the rest.
const HB_INTERVAL_MS = 15000;
// Timeouts tolerate mobile background throttling (timers can stall ~1 min).
const GUEST_TIMEOUT_MS = 90000;
const HOST_STALE_MS = 90000;

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
  const { rooms, dead } = classifyRooms(snap);
  sweepDeadRooms(db, dead);
  return rooms;
}

/** Watch room list changes. Returns unsubscribe function. */
export function watchRooms(cb) {
  const db = getDb();
  const ref = db.ref(ROOMS_PATH);
  const handler = (snap) => {
    const { rooms, dead } = classifyRooms(snap);
    sweepDeadRooms(db, dead);
    cb(rooms);
  };
  ref.on('value', handler);
  return () => { try { ref.off('value', handler); } catch {} };
}

// Room liveness: a room is listed only while its host is alive.
// Hosts heartbeat every HB_INTERVAL_MS; HOST_FRESH_MS tolerates missed beats.
export const HOST_FRESH_MS = 90000;
// Dead rooms are deleted after this much total silence (protects
// host-promotion and rejoin races; husks with no timestamps go immediately).
export const ROOM_SWEEP_MS = 30 * 60 * 1000;

/** Pure: is this room shown in the lobby? (exported for tests) */
export function isRoomJoinable(r, now = Date.now()) {
  if (!r || r.started) return false;
  const hb = r.hostHb || 0;
  if (hb && now - hb < HOST_FRESH_MS) return true;
  // Old clients without heartbeat: show only brand-new rooms.
  const created = r.created || 0;
  if (!hb && created && now - created < HOST_FRESH_MS) return true;
  return false;
}

/** Pure: is this room dead and safe to delete? (exported for tests) */
export function isRoomDead(r, now = Date.now()) {
  if (!r) return true;
  const hb = r.hostHb || 0;
  if (hb && now - hb < HOST_FRESH_MS) return false; // host alive
  const guests = r.guests || {};
  let last = Math.max(hb, r.created || 0);
  for (const k of Object.keys(guests)) {
    const ghb = guests[k].hb || 0;
    if (ghb && now - ghb < HOST_FRESH_MS) return false; // live guest
    if (ghb > last) last = ghb;
  }
  return now - last > ROOM_SWEEP_MS;
}

/** Split a rooms snapshot into joinable rooms and dead room codes. */
function classifyRooms(snap) {
  const rooms = [];
  const dead = [];
  const now = Date.now();
  if (snap.exists()) {
    snap.forEach((child) => {
      const code = child.key;
      const r = child.val() || {};
      if (isRoomDead(r, now)) {
        dead.push(code);
        return;
      }
      if (!isRoomJoinable(r, now)) return;
      const guests = r.guests ? Object.keys(r.guests).length : 0;
      rooms.push({
        code,
        title: r.title || '제목 없음',
        hostName: r.hostName || '?',
        playerCount: 1 + guests, // host + guests
        created: r.created || 0,
        turnLimitMs: r.turnLimitMs || 45000,
      });
    });
    // Newest first.
    rooms.sort((a, b) => b.created - a.created);
  }
  return { rooms, dead };
}

let _lastSweep = 0;
/** Best-effort deletion of dead rooms (throttled; any client may do it). */
function sweepDeadRooms(db, deadCodes) {
  if (!deadCodes.length) return;
  const now = Date.now();
  if (now - _lastSweep < 60000) return;
  _lastSweep = now;
  for (const code of deadCodes) {
    db.ref(`${ROOMS_PATH}/${code}`).remove().catch(() => {});
  }
}

export class FirebaseRoom {
  constructor({ onmessage = () => {}, onjoin = () => {}, onleave = () => {}, onhostback = () => {}, onroomdeleted = () => {}, onsuperseded = () => {}, onreconnect = () => {} } = {}) {
    this.onreconnect = onreconnect;
    this.onmessage = onmessage;
    this.onjoin = onjoin;
    this.onleave = onleave;
    this.onhostback = onhostback;       // guest: a new host took over after host-gone
    this.onroomdeleted = onroomdeleted; // guest: room node deleted (host ended it)
    this.onsuperseded = onsuperseded;   // host: another client claimed hostId (split-brain)
    this.isHost = false;
    this.closed = false;
    this.peers = []; // host: [{guestId, name, removed?}], guest: [{guestId: 'host'}]
    this.code = null;
    this.myGuestId = null;
    this._joinToken = null;
    this._dbRefs = [];
    this._seenMsgs = new Set();
    this._guestHb = {}; // host: guestId -> last heartbeat timestamp
    this._hostId = null;
    this._hbTimer = null;
    this._hostGoneFired = false;
    this._sawHostGone = false;
    this._roomGoneFired = false;
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
  async hostCreate(hostName = '', title = '', turnLimitMs = 45000) {
    this.isHost = true;
    this.turnLimitMs = turnLimitMs;
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
        turnLimitMs,
      });
      this.code = code;
      // Host presence: unique hostId + heartbeat. If this client disconnects,
      // the server marks hostGone=hostId so a guest can take over.
      this._hostId = genId();
      await roomRef.update({ hostId: this._hostId, hostHb: Date.now(), hostGone: null });
      try {
        db.ref(`${ROOMS_PATH}/${code}/hostGone`).onDisconnect().set(this._hostId);
      } catch {}
      this._startHostHeartbeat();
      this._startPresenceRecovery();
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
    if (this.closed) return;
    const seen = new Set();
    if (snap.exists()) {
      snap.forEach((child) => {
        const guestId = child.key;
        seen.add(guestId);
        const g = child.val() || {};
        this._guestHb[guestId] = g.hb || 0;
        if (this.peers.some((p) => p.guestId === guestId && !p.removed)) return;
        const idx = this.peers.length;
        this.peers.push({ guestId, name: g.name || '?' });
        if (!this.closed) this.onjoin(idx);
      });
    }
    // Detect removed guests. Keep the slot (marked removed) so peer indices
    // stay stable for the session's peerToPlayer mapping.
    for (let i = 0; i < this.peers.length; i++) {
      const p = this.peers[i];
      if (!p.removed && !seen.has(p.guestId)) {
        p.removed = true;
        delete this._guestHb[p.guestId];
        if (!this.closed) this.onleave(i);
      }
    }
  }

  /** Host heartbeat + guest staleness sweep + split-brain guard. */
  _startHostHeartbeat() {
    this._stopHeartbeat();
    const db = this._db;
    const code = this.code;
    if (!db || !code) return;
    this._hbTimer = setInterval(async () => {
      if (this.closed || !this.isHost) return;
      try {
        // Write the beat first so a slow/failed guard read can't starve guests' staleness check.
        if (this.closed || !this.isHost) return;
        db.ref(`${ROOMS_PATH}/${code}/hostHb`).set(Date.now()).catch(() => {});
        // Split-brain guard: if another client claimed hostId, step down.
        const idSnap = await db.ref(`${ROOMS_PATH}/${code}/hostId`).once('value');
        if (idSnap.val() !== this._hostId) {
          this._stopHeartbeat();
          try { this.onsuperseded(); } catch {}
          return;
        }
        // Sweep stale guests (heartbeat backup for missed onDisconnect).
        const now = Date.now();
        for (let i = 0; i < this.peers.length; i++) {
          const p = this.peers[i];
          if (p.removed) continue;
          const hb = this._guestHb[p.guestId] || 0;
          if (hb && now - hb > GUEST_TIMEOUT_MS) {
            p.removed = true;
            delete this._guestHb[p.guestId];
            try { this.onleave(i); } catch {}
          }
        }
        // Recheck closed right before the write: close() may have removed the
        // room while the async sweep above was running (avoids husk rooms).
        if (this.closed || !this.isHost) return;
        await db.ref(`${ROOMS_PATH}/${code}/hostHb`).set(now);
      } catch {}
    }, HB_INTERVAL_MS);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }

  /** Immediate heartbeat (tab resumed / network back). */
  _pingNow() {
    const db = this._db;
    if (!db || !this.code || this.closed) return;
    const now = Date.now();
    try {
      if (this.isHost) db.ref(`${ROOMS_PATH}/${this.code}/hostHb`).set(now).catch(() => {});
      else if (this.myGuestId) db.ref(`${ROOMS_PATH}/${this.code}/guests/${this.myGuestId}/hb`).set(now).catch(() => {});
    } catch {}
  }

  /**
   * Recover presence after a transient socket drop. The server fires our
   * onDisconnect handlers (guest entry removed / hostGone set) even when the
   * client reconnects a few seconds later, so re-assert presence on reconnect
   * and resume instantly when the tab becomes visible again.
   */
  _startPresenceRecovery() {
    this._stopPresenceRecovery();
    const db = this._db;
    if (!db) return;
    const connRef = db.ref('.info/connected');
    let first = true;
    const connCb = (snap) => {
      if (this.closed) return;
      if (snap.val() !== true) return;
      if (first) { first = false; return; }
      this._restorePresence().catch(() => {});
    };
    connRef.on('value', connCb);
    this._presence = { connRef, connCb };
    if (typeof document !== 'undefined') {
      this._onVisible = () => {
        if (document.visibilityState === 'visible') this._pingNow();
      };
      this._onOnline = () => this._pingNow();
      document.addEventListener('visibilitychange', this._onVisible);
      window.addEventListener('online', this._onOnline);
      window.addEventListener('pageshow', this._onOnline);
    }
  }

  _stopPresenceRecovery() {
    if (this._presence) {
      try { this._presence.connRef.off('value', this._presence.connCb); } catch {}
      this._presence = null;
    }
    if (typeof document !== 'undefined' && this._onVisible) {
      document.removeEventListener('visibilitychange', this._onVisible);
      window.removeEventListener('online', this._onOnline);
      window.removeEventListener('pageshow', this._onOnline);
      this._onVisible = this._onOnline = null;
    }
  }

  async _restorePresence() {
    const db = this._db;
    const code = this.code;
    if (!db || !code || this.closed) return;
    if (this.isHost) {
      // Only reclaim if we are still the registered host (not superseded).
      const idSnap = await db.ref(`${ROOMS_PATH}/${code}/hostId`).once('value');
      if (idSnap.val() !== this._hostId || this.closed) return;
      await db.ref(`${ROOMS_PATH}/${code}`).update({ hostGone: null, hostHb: Date.now() });
      try { db.ref(`${ROOMS_PATH}/${code}/hostGone`).onDisconnect().set(this._hostId); } catch {}
    } else if (this.myGuestId) {
      const ref = db.ref(`${ROOMS_PATH}/${code}/guests/${this.myGuestId}`);
      const snap = await ref.once('value');
      if (this.closed) return;
      const wasRemoved = !snap.exists();
      if (wasRemoved) {
        await ref.set({ name: this._guestName || '', joinedAt: Date.now(), hb: Date.now() });
      } else {
        await ref.child('hb').set(Date.now());
      }
      try { ref.onDisconnect().remove(); } catch {}
      // Host may have handed our seat to AI: ask to be re-seated (session sends HELLO+rejoin).
      if (wasRemoved) { try { this.onreconnect(); } catch {} }
    }
  }

  _stopHeartbeat() {
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
    }
  }

  /** Host: record which playerIndex a guest sits at (used for promotion mapping). */
  async setGuestPlayerIndex(peerIdx, playerIndex) {
    if (!this.isHost || !this.code || !this._db) return;
    const peer = this.peers[peerIdx];
    if (!peer || peer.removed) return;
    try {
      await this._db.ref(`${ROOMS_PATH}/${this.code}/guests/${peer.guestId}/playerIndex`).set(playerIndex);
    } catch {}
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
        const roomData = roomSnap.val() || {};
        this.turnLimitMs = roomData.turnLimitMs || 45000;

        const guestId = genId();
        this.myGuestId = guestId;
        this.code = clean;
        this.peers = [{ guestId: 'host' }];

        // Register as guest.
        await db.ref(`${ROOMS_PATH}/${clean}/guests/${guestId}`).set({
          name: '',
          joinedAt: Date.now(),
          hb: Date.now(),
        });
        // Fast disconnect detection: server removes our entry on socket loss.
        try {
          db.ref(`${ROOMS_PATH}/${clean}/guests/${guestId}`).onDisconnect().remove();
        } catch {}
        // Heartbeat (backup for missed onDisconnect).
        this._stopHeartbeat();
        this._hbTimer = setInterval(() => {
          if (this.closed || this.isHost) return;
          db.ref(`${ROOMS_PATH}/${clean}/guests/${guestId}/hb`).set(Date.now()).catch(() => {});
        }, HB_INTERVAL_MS);
        if (this._hbTimer.unref) this._hbTimer.unref();
        this._startPresenceRecovery();

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
          if (this.closed) return;
          if (!snap.exists()) {
            // Room deleted: the host ended it. (Only after a successful join.)
            if (this._joinToken === null && !this.isHost && !this._roomGoneFired) {
              this._roomGoneFired = true;
              setTimeout(() => { if (!this.closed) { try { this.onroomdeleted(); } catch {} } }, 0);
            }
            return;
          }
          if (this._joinToken !== null && this._joinToken !== joinToken) return;
          const r = snap.val() || {};
          if (r.started && r.startInfo && !this._startFallbackDone) {
            this._startFallbackDone = true;
            const si = r.startInfo;
            // Simulate receiving START message.
            this.onmessage(0, { t: 'start', seed: si.seed, names: si.names, aiNames: si.aiNames || [], turnLimitMs: si.turnLimitMs });
          }
          // Host presence (guest only, after join). onleave(0) = host gone.
          if (!this.isHost && this._joinToken === null) {
            const now = Date.now();
            const goneExplicit = !!(r.hostGone && r.hostId && r.hostGone === r.hostId);
            const hbStale = !!(r.hostHb && now - r.hostHb > HOST_STALE_MS);
            const hostAlive = !goneExplicit && r.hostHb && now - r.hostHb < HB_INTERVAL_MS * 2;
            if ((goneExplicit || hbStale) && !this._hostGoneFired) {
              this._hostGoneFired = true;
              this._sawHostGone = true;
              setTimeout(() => { if (!this.closed && !this.isHost) { try { this.onleave(0); } catch {} } }, 0);
            } else if (hostAlive && this._sawHostGone) {
              // A new host took over (possibly us via promotion on another tab —
              // here it means someone else did).
              this._sawHostGone = false;
              this._hostGoneFired = false;
              setTimeout(() => { if (!this.closed && !this.isHost) { try { this.onhostback(); } catch {} } }, 0);
            }
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
    this._guestName = name;
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

  /** Guest: try to claim the host lock after the old host is gone. Only one guest wins. */
  async tryAcquireHostLock() {
    if (this.isHost || !this.code || !this._db || !this.myGuestId) return false;
    try {
      const ref = this._db.ref(`${ROOMS_PATH}/${this.code}/hostLock`);
      const res = await ref.transaction((cur) => {
        const now = Date.now();
        if (!cur || now - (cur.at || 0) > 20000) {
          return { holder: this.myGuestId, at: now };
        }
        return undefined; // abort: someone else holds a fresh lock
      });
      return !!(res && res.committed);
    } catch {
      return false;
    }
  }

  /**
   * Host: persist the authoritative game snapshot.
   * Written after every applied action, before its broadcast, so the snapshot
   * is always a superset of what any guest has seen. A successor host adopts
   * this snapshot when its own lockstep mirror diverged.
   */
  async writeSnapshot(state, h, n) {
    if (!this.isHost || !this.code || !this._db) return;
    const payload = { state, h: h || null, n: n || 0, at: Date.now() };
    const ref = this._db.ref(`${ROOMS_PATH}/${this.code}/snapshot`);
    try {
      await ref.set(payload);
    } catch {
      // One retry: a blip here must not silently break the superset invariant.
      try { await ref.set(payload); } catch {}
    }
  }

  /** Guest (promoting): read the last authoritative snapshot, if any. */
  async readSnapshot() {
    if (this.isHost || !this.code || !this._db) return null;
    try {
      const snap = await this._db.ref(`${ROOMS_PATH}/${this.code}/snapshot`).once('value');
      return snap.exists() ? snap.val() : null;
    } catch {
      return null;
    }
  }

  /**
   * Guest: take over as host after winning the host lock.
   * Rebuilds the peer list from the live guest roster, starts host heartbeat
   * and inbox listeners. Returns { playerIndex -> peerIdx } for the session.
   */
  async promoteToHost(hostName = '') {
    if (this.isHost || !this.code || !this._db || !this.myGuestId) throw new Error('promote-failed');
    const db = this._db;
    const code = this.code;
    this.isHost = true;
    this._untrackAll();
    this._stopHeartbeat();
    this._hostId = genId();
    // Rebuild peers from the current guest list (skip self and stale entries).
    const snap = await db.ref(`${ROOMS_PATH}/${code}/guests`).once('value');
    this.peers = [];
    this._guestHb = {};
    this._seenMsgs = new Set();
    const guestMap = {};
    const now = Date.now();
    if (snap.exists()) {
      snap.forEach((child) => {
        const gid = child.key;
        if (gid === this.myGuestId) return;
        const g = child.val() || {};
        const pIdx = g.playerIndex;
        if (!Number.isInteger(pIdx) || pIdx < 0) return;
        if (g.hb && now - g.hb > GUEST_TIMEOUT_MS) return;
        const pi = this.peers.length;
        this.peers.push({ guestId: gid, name: g.name || '?' });
        this._guestHb[gid] = g.hb || 0;
        guestMap[pIdx] = pi;
      });
    }
    // Host listeners.
    this._track(db.ref(`${ROOMS_PATH}/${code}/guests`), (s) => this._onGuests(s));
    this._track(db.ref(`${ROOMS_PATH}/${code}/msgs/toHost`), (s) => this._onHostInbox(s));
    // Claim host presence; releasing the lock implicitly.
    await db.ref(`${ROOMS_PATH}/${code}`).update({
      hostId: this._hostId,
      hostGone: null,
      hostHb: Date.now(),
      hostName: hostName || '?',
      hostLock: null,
    });
    try {
      db.ref(`${ROOMS_PATH}/${code}/hostGone`).onDisconnect().set(this._hostId);
    } catch {}
    this._startHostHeartbeat();
    this._startPresenceRecovery();
    this._hostGoneFired = false;
    this._sawHostGone = false;
    this._roomGoneFired = false;
    return guestMap;
  }

  /** Cancel an in-progress guestJoin. */
  cancelJoin() {
    this._joinToken = Symbol('cancelled');
    this._stopHeartbeat();
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
        if (!peer || peer.removed) return;
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
    this._stopHeartbeat();
    this._stopPresenceRecovery();
    this._untrackAll();
    if (this._db && this.code) {
      try {
        // Cancel presence handlers first so they don't fire after close.
        await this._db.ref(`${ROOMS_PATH}/${this.code}/hostGone`).onDisconnect().cancel();
      } catch {}
      try {
        await this._db.ref(`${ROOMS_PATH}/${this.code}/guests/${this.myGuestId}`).onDisconnect().cancel();
      } catch {}
    }
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
