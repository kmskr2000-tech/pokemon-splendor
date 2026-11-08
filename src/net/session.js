// Multiplayer session: owns the NetRoom, the lockstep protocol flow, and the
// multiplayer controller. main.js only renders `session` state and forwards taps.

import { CARDS } from '../data/cards.js';
import { createController } from '../ui/controller.js';
import { NetRoom } from './webrtc.js';
import { FirebaseRoom, writeMatch } from './fireroom.js';
import { buildResults, cleanPid } from './stats.js';
import { MSG, makeMsg, stateHash } from './protocol.js';
import * as walletApi from '../wallet/wallet.js';
import { currentUser } from '../wallet/auth.js';

// Default wallet adapter (real Firebase). Tests inject a fake via opts.wallet.
const defaultWallet = {
  getUser: () => currentUser(),
  createEscrow: walletApi.createEscrow,
  payEntry: walletApi.payEntry,
  placeBet: walletApi.placeBet,
  startRoom: walletApi.startRoom,
  reportResult: walletApi.reportResult,
  cancelRoom: walletApi.cancelRoom,
  watchEscrow: walletApi.watchEscrow,
};

const MAX_PLAYERS = 4;
export const EMOTES = ['😂', '🖕', '⏰', '중국인'];
const EMOTE_COOLDOWN_MS = 2500;
// Host waits this long past the shown deadline before forcing a timeout, so an
// action sent at the last second (Firebase relay ~1-2s) still counts.
const TIMEOUT_GRACE_MS = 2500;
const DEFAULT_TURN_LIMIT_MS = 45 * 1000; // 45 seconds per turn

export class NetSession {
  // cb: { onRender(), onGameStart(ctrl), onGameEnd(), onNotice(msg) }
  // opts.usePeer: true = short-code via PeerJS (default), false = manual offer/answer.
  constructor(cb, opts = {}) {
    this.cb = cb;
    this.usePeer = opts.usePeer !== false;
    this.myPid = cleanPid(opts.pid);
    this.writeMatch = opts.writeMatch || writeMatch; // injectable for tests
    this.wallet = opts.wallet || defaultWallet; // money ops (Cloud Functions); injectable for tests
    this.reset();
  }

  reset() {
    this.role = null; // 'host' | 'guest' | 'spectator'
    this.phase = 'menu'; // menu|hostname|hostoffer|hostlobby|guestname|guestjoin|guestanswer|guestlobby|spectlobby|busy|playing
    this.room = null;
    this.myName = '';
    this.myIndex = -1;
    this.names = [];
    this.seed = 0;
    this.offerCode = '';
    this.answerCode = '';
    this.turnDeadline = 0; // timestamp when current turn expires
    this.turnLimitMs = DEFAULT_TURN_LIMIT_MS; // per-room setting chosen by host
    this._turnTimer = null;
    this.shortCode = ''; // peer mode: 6-char room code
    this.lastCode = ''; // peer mode: code used to join (for rejoin lookup)
    this.pendingPeer = -1;
    this.peerToPlayer = {}; // host: peerIdx -> playerIndex
    this.aiTakeover = {}; // host: playerIndex -> true (disconnected seat now driven by AI)
    this._promoting = false; // guest: promotion in progress
    this._waitingForHost = 0; // guest: timestamp until which we wait for a new host
    this.aiCount = 0; // host lobby: AI seats to add (0..4-humanCount)
    this.aiNames = [];
    this.ctrl = null;
    this.pids = []; // seat -> per-device player id (friend stats)
    this._matchSaved = false;
    this._emoteAt = {}; // seat -> last emote timestamp (cooldown)
    this.actionCount = 0; // host: applied actions (authoritative snapshot sequence)
    this._commitChain = Promise.resolve(); // host: ordered snapshot->broadcast chain
    // ---- spectators / money ----
    this.uids = []; // seat -> wallet uid ('' when that player is not signed in)
    this.myUid = ''; // my wallet uid ('' when signed out)
    this.spectatorPeers = new Set(); // host: peer indices that only watch
    this.spectatorCount = 0; // everyone: head count shown in lobby/header
    this.entryFee = 0; // per-room entry fee in won (0 = free)
    this.escrow = null; // live escrow node (players paid, bets, settlement) or null when no wallet
    this._escrowUnwatch = null;
    this._resultSent = false;
    this.busyMoney = false; // a wallet call is in flight (disables buttons)
  }

  // ---------- wallet helpers ----------

  _refreshUid() {
    try { const u = this.wallet.getUser && this.wallet.getUser(); this.myUid = (u && u.uid) || ''; } catch { this.myUid = ''; }
    return this.myUid;
  }

  _watchEscrow(code) {
    this._unwatchEscrow();
    if (!code || typeof this.wallet.watchEscrow !== 'function') return;
    try {
      this._escrowUnwatch = this.wallet.watchEscrow(code, (e) => {
        this.escrow = e;
        if (e && Number.isInteger(e.entryFee)) this.entryFee = e.entryFee;
        this.cb.onRender();
      });
    } catch { this._escrowUnwatch = null; }
  }

  _unwatchEscrow() {
    if (this._escrowUnwatch) { try { this._escrowUnwatch(); } catch {} this._escrowUnwatch = null; }
    this.escrow = null;
  }

  roomCode() {
    return (this.room && this.room.code) || this.shortCode || this.lastCode || '';
  }

  /** Has this seat's player paid the entry fee? (free rooms: always true) */
  hasPaid(seat) {
    if (!(this.entryFee > 0)) return true;
    const uid = this.uids[seat];
    return !!(uid && this.escrow && this.escrow.players && this.escrow.players[uid] && Number(this.escrow.players[uid].amount) >= this.entryFee);
  }

  /** Every human seat has paid (host included). */
  allPaid() {
    if (!(this.entryFee > 0)) return true;
    return this.names.every((_, i) => this.hasPaid(i));
  }

  /** Betting is open until the host starts the game + grace (server enforces the real cutoff). */
  betOpen() {
    const e = this.escrow;
    if (!e || e.status === 'settled' || e.status === 'cancelled' || e.status === 'disputed') return false;
    if (e.betCloseAt && Date.now() > e.betCloseAt) return false;
    return true;
  }

  async _money(label, fn) {
    if (this.busyMoney) return false;
    this.busyMoney = true;
    this.cb.onRender();
    try {
      await fn();
      return true;
    } catch (e) {
      this.cb.onNotice(`${label} 실패: ${(e && e.message) || '알 수 없는 오류'}`);
      return false;
    } finally {
      this.busyMoney = false;
      this.cb.onRender();
    }
  }

  /** Player: pay this room's entry fee from my wallet. */
  payEntry() {
    const code = this.roomCode();
    if (!code || !(this.entryFee > 0)) return;
    if (!this._refreshUid()) { this.cb.onNotice('참가비를 내려면 로그인이 필요해요.'); return; }
    return this._money('참가비 결제', () => this.wallet.payEntry(code, this.myName));
  }

  /** Spectator (or anyone not seated): bet on a player's uid. */
  placeBet(targetUid, amount) {
    const code = this.roomCode();
    if (!code) return;
    if (!this._refreshUid()) { this.cb.onNotice('베팅하려면 로그인이 필요해요.'); return; }
    if (this.uids.includes(this.myUid) && this.myIndex >= 0) { this.cb.onNotice('참가자는 베팅할 수 없어요.'); return; }
    if (!this.uids.includes(targetUid)) { this.cb.onNotice('베팅 대상을 다시 골라주세요.'); return; }
    return this._money('베팅', () => this.wallet.placeBet(code, targetUid, amount));
  }

  /** Both: once the game is over, send my view of the final ranking to the settlement function. */
  reportResult() {
    if (this._resultSent || !this.ctrl || !this.ctrl.finished || !this.escrow) return;
    if (this.role !== 'host' && this.myIndex < 0) return; // spectators don't vote
    if (!this._refreshUid()) return;
    this._resultSent = true;
    const code = this.roomCode();
    const ranking = (this.ctrl.game.ranking || [])
      .filter((r) => r.player < this.names.length)
      .map((r) => ({ uid: this.uids[r.player] || '', rank: r.rank }));
    Promise.resolve(this.wallet.reportResult(code, ranking)).catch(() => {});
  }

  // Rejoin persistence (guest): remember code+playerIndex so an accidental
  // close can resume the same seat within a few minutes.
  saveRejoin(code, playerIndex) {
    try {
      localStorage.setItem('pkmspl-rejoin', JSON.stringify({ code, playerIndex, at: Date.now() }));
    } catch {}
  }
  /** Saved rejoin entry regardless of code (10-min TTL), or null. */
  peekRejoin() {
    try {
      const o = JSON.parse(localStorage.getItem('pkmspl-rejoin'));
      if (o && o.code && Date.now() - o.at < 10 * 60 * 1000) return o;
    } catch {}
    return null;
  }
  loadRejoin(code) {
    const o = this.peekRejoin();
    return o && o.code === code ? o : null;
  }
  clearRejoin() {
    try { localStorage.removeItem('pkmspl-rejoin'); } catch {}
  }

  cleanName(n) {
    return String(n || '').trim().slice(0, 12) || '트레이너';
  }

  makeRoom() {
    const handlers = {
      onmessage: (i, m) => this.onMsg(i, m),
      onjoin: () => {
        // Guest: connection open -> introduce ourselves; host replies with welcome+roster.
        // Include rejoin seat if we have one for this room code.
        if (this.role === 'spectator' && this.room) {
          this.room.send(makeMsg(MSG.HELLO, { name: this.myName, uid: this.myUid, spectator: true }));
          this.phase = 'spectlobby';
          this.cb.onRender();
          return;
        }
        if (this.role === 'guest' && this.room) {
          const hello = { name: this.myName, pid: this.myPid, uid: this.myUid };
          const rj = this.usePeer && this.lastCode ? this.loadRejoin(this.lastCode) : null;
          if (rj) hello.rejoin = rj.playerIndex;
          this.room.send(makeMsg(MSG.HELLO, hello));
          this.phase = 'guestlobby';
          this.cb.onRender();
        }
      },
      onleave: (i) => this.onLeave(i),
      onreconnect: () => {
        // Guest socket dropped and came back after the host already saw us leave:
        // re-send HELLO with our saved seat so the host hands it back from AI.
        if (this.role === 'spectator' && this.room && this.phase === 'playing') {
          this.room.send(makeMsg(MSG.HELLO, { name: this.myName, uid: this.myUid, spectator: true }));
          return;
        }
        if (this.role === 'guest' && this.room && this.phase === 'playing') {
          const hello = { name: this.myName, pid: this.myPid, uid: this.myUid };
          const rj = this.usePeer && this.lastCode ? this.loadRejoin(this.lastCode) : null;
          if (rj) hello.rejoin = rj.playerIndex;
          this.room.send(makeMsg(MSG.HELLO, hello));
        }
      },
      onhostback: () => this.onHostBack(),
      onroomdeleted: () => this.onRoomDeleted(),
      onsuperseded: () => this.onSuperseded(),
    };
    return this.usePeer ? new FirebaseRoom(handlers) : new NetRoom(handlers);
  }

  // ---------- host ----------

  async hostCreate(name, title = '', turnLimitMs = DEFAULT_TURN_LIMIT_MS, entryFee = 0) {
    this.role = 'host';
    this.myName = this.cleanName(name);
    this.turnLimitMs = turnLimitMs;
    this.entryFee = Math.max(0, Math.floor(Number(entryFee) || 0));
    this._refreshUid();
    if (this.entryFee > 0 && !this.myUid) {
      this.phase = 'hostname';
      this.cb.onNotice('참가비가 있는 방은 로그인 후 만들 수 있어요.');
      this.cb.onRender();
      return;
    }
    this.names = [this.myName];
    this.pids = [this.myPid];
    this.uids = [this.myUid];
    this.myIndex = 0;
    this.room = this.makeRoom();
    // Guest connections arrive via onMsg(hello) in both transports.
    if (this.usePeer) this.room.onjoin = () => {};
    this.phase = 'busy';
    this.cb.onRender();
    try {
      if (this.usePeer) {
        this.shortCode = await this.room.hostCreate(this.myName, title, this.turnLimitMs, this.entryFee);
        // Remember the room so the host can rejoin their own seat (index 0)
        // after a disconnect, once a guest has taken over as host.
        this.saveRejoin(this.shortCode, 0);
        // Escrow (entry fees + bets) lives server-side. Signed-in hosts open one
        // even for free rooms so spectators can bet; signed-out hosts get a plain room.
        if (this.myUid) {
          if (typeof this.room.setHostUid === 'function') this.room.setHostUid(this.myUid).catch(() => {});
          try {
            await this.wallet.createEscrow(this.shortCode, this.entryFee, this.myName);
          } catch (e) {
            if (this.entryFee > 0) throw e; // paid room without escrow is unusable
            // free room: betting simply unavailable
          }
          this._watchEscrow(this.shortCode);
        }
        this.phase = 'hostlobby';
      } else {
        const { peerIdx, code } = await this.room.createOffer();
        this.pendingPeer = peerIdx;
        this.offerCode = code;
        this.phase = 'hostoffer';
      }
    } catch (e) {
      try { this.room?.close(); } catch {}
      this.room = null;
      this.phase = 'hostname';
      const why = e && e.message && !/room-create-failed/.test(e.message) ? ` (${e.message})` : '';
      this.cb.onNotice(`방 생성에 실패했어요. 다시 시도해주세요.${why}`);
    }
    this.cb.onRender();
  }

  async hostInvite() {
    if (this.usePeer) return; // peer mode: same short code, nothing to do
    this.phase = 'busy';
    this.cb.onRender();
    try {
      const { peerIdx, code } = await this.room.createOffer();
      this.pendingPeer = peerIdx;
      this.offerCode = code;
      this.phase = 'hostoffer';
    } catch {
      this.phase = 'hostlobby';
      this.cb.onNotice('초대 코드 생성에 실패했어요.');
    }
    this.cb.onRender();
  }

  async hostAcceptAnswer(code) {
    this.phase = 'busy';
    this.cb.onRender();
    try {
      await this.room.acceptAnswer(this.pendingPeer, String(code || '').trim());
      // The guest's hello arrives via onMsg -> phase becomes hostlobby.
      // If nothing arrives (bad code), we stay busy; give it a moment then fall back.
      setTimeout(() => {
        if (this.phase === 'busy') {
          this.phase = this.names.length > 1 ? 'hostlobby' : 'hostoffer';
          this.cb.onNotice('게스트의 응답이 없어요. 코드를 확인해주세요.');
          this.cb.onRender();
        }
      }, 8000);
    } catch {
      this.phase = 'hostoffer';
      this.cb.onNotice('코드가 올바르지 않아요. 다시 붙여넣어주세요.');
      this.cb.onRender();
    }
  }

  broadcastRoster() {
    this.room.broadcast(makeMsg(MSG.ROSTER, {
      names: this.names,
      pids: this.pids,
      uids: this.uids,
      spectators: this.spectatorCount,
      entryFee: this.entryFee,
      aiTakeover: Object.keys(this.aiTakeover).map(Number),
    }));
  }

  // AI seat names: trainer names not taken by humans.
  pickAiNames() {
    const pool = ['지우', '이슬', '웅이', '로이'].filter((n) => !this.names.includes(n));
    const out = [];
    for (let i = 0; i < this.aiCount; i++) out.push(pool[i] || `AI ${i + 1}`);
    return out;
  }

  async hostStart() {
    const total = this.names.length + this.aiCount;
    if (this.names.length < 1 || total < 2 || total > MAX_PLAYERS) return;
    if (this.phase !== 'hostlobby' || this.busyMoney) return;
    if (this.entryFee > 0 && !this.allPaid()) {
      this.cb.onNotice('아직 참가비를 내지 않은 참가자가 있어요.');
      this.cb.onRender();
      return;
    }
    // Lock the escrow first (server re-checks payments and sets the bet cutoff).
    if (this.escrow) {
      const ok = await this._money('게임 시작', () => this.wallet.startRoom(this.roomCode(), this.uids.slice(0, this.names.length)));
      if (!ok || this.phase !== 'hostlobby') return;
    }
    const seed = (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
    this.aiNames = this.pickAiNames();
    this.beginGame(seed, [...this.names], 0, this.aiNames);
    this.room.broadcast(makeMsg(MSG.START, { seed, names: this.names, pids: this.pids, uids: this.uids, aiNames: this.aiNames, turnLimitMs: this.turnLimitMs, entryFee: this.entryFee }));
    // Mark room as started so it disappears from lobby. Also write start info
    // as a fallback in case the broadcast message is missed.
    if (this.room && typeof this.room.markStarted === 'function') {
      this.room.markStarted({ seed, names: this.names, aiNames: this.aiNames, turnLimitMs: this.turnLimitMs }).catch(() => {});
    }
  }

  hostMsg(peerIdx, m) {
    switch (m.t) {
      case MSG.HELLO: {
        if (m.spectator) { this.acceptSpectator(peerIdx); return; }
        // Rejoin mid-game? Hand the AI-driven seat back to the returning human.
        if (this.phase === 'playing') {
          const rIdx = m.rejoin;
          if (Number.isInteger(rIdx) && this.aiTakeover[rIdx]) {
            delete this.aiTakeover[rIdx];
            if (this.ctrl && this.ctrl.game.players[rIdx]) {
              this.ctrl.game.players[rIdx].isAI = false;
            }
            this.peerToPlayer[peerIdx] = rIdx;
            if (cleanPid(m.pid)) this.pids[rIdx] = m.pid;
            if (typeof m.uid === 'string' && m.uid && !this.uids[rIdx]) this.uids[rIdx] = m.uid;
            if (this.room && typeof this.room.setGuestPlayerIndex === 'function') {
              this.room.setGuestPlayerIndex(peerIdx, rIdx);
            }
            this.room.sendTo(peerIdx, makeMsg(MSG.REJOIN_OK, {
              playerIndex: rIdx, seed: this.seed, names: this.names,
              aiNames: this.aiNames, pids: this.pids, uids: this.uids, entryFee: this.entryFee,
              spectators: this.spectatorCount,
              aiTakeover: Object.keys(this.aiTakeover).map(Number),
              state: this.ctrl.game,
            }));
            this.broadcastRoster();
            this.cb.onNotice(`📡 ${this.names[rIdx]}이(가) 다시 연결됐어요!`);
            this.cb.onRender();
          }
          // else: ignore joins mid-game
          return;
        }
        if (this.names.length >= MAX_PLAYERS) return;
        if (this.peerToPlayer[peerIdx] != null) return; // already joined
        const idx = this.names.length;
        this.names.push(this.cleanName(m.name));
        this.pids[idx] = cleanPid(m.pid);
        this.uids[idx] = typeof m.uid === 'string' ? m.uid.slice(0, 64) : '';
        this.peerToPlayer[peerIdx] = idx;
        if (this.room && typeof this.room.setGuestPlayerIndex === 'function') {
          this.room.setGuestPlayerIndex(peerIdx, idx);
        }
        this.room.sendTo(peerIdx, makeMsg(MSG.WELCOME, { playerIndex: idx, entryFee: this.entryFee }));
        this.broadcastRoster();
        this.offerCode = '';
        this.phase = 'hostlobby';
        this.cb.onRender();
        break;
      }
      case MSG.EMOTE: {
        // Stateless relay: sender seat comes from the transport, never from the payload.
        const seat = this.peerToPlayer[peerIdx];
        if (!this._emoteOk(seat, m.k)) return;
        this.room.broadcast(makeMsg(MSG.EMOTE, { from: seat, k: m.k }), peerIdx);
        this._showEmote(seat, m.k);
        break;
      }
      case MSG.ACTION: {
        if (this.phase !== 'playing' || !this.ctrl) return;
        // Only the seat whose turn it is may act. A late action (e.g. sent right
        // before a timeout passed the turn) must not be applied to the next player;
        // realign that guest with the authoritative state instead.
        const seat = this.peerToPlayer[peerIdx];
        if (seat !== this.ctrl.game.current) {
          this.room.sendTo(peerIdx, makeMsg(MSG.SYNC, { state: this.ctrl.game }));
          break;
        }
        const res = this.ctrl.applyRemote(m.action);
        if (res.ok) {
          this.hostCommit(m.action, seat, peerIdx);
        } else {
          this.room.sendTo(peerIdx, makeMsg(MSG.SYNC, { state: this.ctrl.game }));
        }
        break;
      }
      case MSG.SYNC_REQ: {
        if (this.phase === 'playing' && this.ctrl) {
          this.room.sendTo(peerIdx, makeMsg(MSG.SYNC, { state: this.ctrl.game }));
        }
        break;
      }
    }
  }

  // ---------- guest ----------

  async guestJoin(name, code, opts = {}) {
    const spectator = !!opts.spectator && this.usePeer;
    this.role = spectator ? 'spectator' : 'guest';
    this.myName = this.cleanName(name);
    this._refreshUid();
    this.room = this.makeRoom();
    this.phase = 'busy';
    this.cb.onRender();
    try {
      if (this.usePeer) {
        const clean = String(code || '').trim().toUpperCase();
        this.lastCode = clean;
        await this.room.guestJoin(clean, (attempt) => {
          this.cb.onNotice(`연결 재시도 중... (${attempt}/2)`);
          this.cb.onRender();
        }, { spectator, rejoin: !!this.loadRejoin(clean) });
        if (Number.isInteger(this.room.entryFee)) this.entryFee = this.room.entryFee;
        this._watchEscrow(clean);
        // Register display name for lobby.
        if (typeof this.room.setGuestName === 'function') {
          this.room.setGuestName(this.myName).catch(() => {});
        }
        // Pick up the host's per-room turn time limit.
        if (this.room.turnLimitMs) this.turnLimitMs = this.room.turnLimitMs;
        // onjoin -> hello (+rejoin) -> welcome/roster -> guestlobby
      } else {
        this.answerCode = await this.room.join(String(code || '').trim());
        this.phase = 'guestanswer';
      }
    } catch (e) {
      this.phase = 'guestjoin';
      this.role = null;
      this._unwatchEscrow();
      const msg = e && e.message;
      if (msg === 'room-not-found') {
        this.cb.onNotice('해당 코드의 방을 찾을 수 없어요. 방장이 방을 다시 만들어주세요.');
      } else if (msg === 'room-started') {
        this.cb.onNotice('이미 시작된 게임이에요. 관전으로 들어갈 수 있어요.');
      } else if (msg === 'cancelled') {
        this.cb.onNotice('연결을 취소했어요.');
      } else if (this.usePeer) {
        this.cb.onNotice('서버가 불안정해요. 다시 시도하거나, 수동 연결을 이용해보세요.');
      } else {
        this.cb.onNotice('코드가 올바르지 않아요. 방장에게 다시 받아주세요.');
      }
    }
    this.cb.onRender();
  }

  /** User pressed cancel during guest join. */
  cancelGuestJoin() {
    if (this.room && typeof this.room.cancelJoin === 'function') {
      this.room.cancelJoin();
    }
    this.phase = 'guestjoin';
    this.cb.onNotice('연결을 취소했어요.');
    this.cb.onRender();
  }

  guestMsg(m) {
    switch (m.t) {
      case MSG.EMOTE:
        if (this.phase === 'playing' && Number.isInteger(m.from) && EMOTES.includes(m.k) && m.from !== this.myIndex) {
          this._showEmote(m.from, m.k);
        }
        break;
      case MSG.WELCOME:
        if (this.role === 'spectator') break;
        this.myIndex = m.playerIndex;
        if (Number.isInteger(m.entryFee)) this.entryFee = m.entryFee;
        if (this.usePeer && this.lastCode) this.saveRejoin(this.lastCode, m.playerIndex);
        break;
      case MSG.SPECTATE_OK: {
        if (this.role !== 'spectator') break;
        this.names = m.names || [];
        this.uids = Array.isArray(m.uids) ? m.uids : [];
        if (Array.isArray(m.pids)) this.pids = m.pids;
        if (Number.isInteger(m.entryFee)) this.entryFee = m.entryFee;
        if (Number.isInteger(m.spectators)) this.spectatorCount = m.spectators;
        if (m.turnLimitMs) this.turnLimitMs = m.turnLimitMs;
        if (m.state) {
          // Game already running: mirror it from the authoritative state.
          this.beginGame(m.seed, this.names, -1, m.aiNames || []);
          this.ctrl.game = m.state;
          this._applyTakeover(m.aiTakeover, this.names.length);
        } else {
          this.phase = 'spectlobby';
        }
        this.cb.onRender();
        break;
      }
      case MSG.SPECTATORS:
        if (Number.isInteger(m.n)) { this.spectatorCount = m.n; this.cb.onRender(); }
        break;
      case MSG.REJOIN_OK:
        if (this.role === 'spectator') break;
        if (Array.isArray(m.pids)) this.pids = m.pids;
        if (Array.isArray(m.uids)) this.uids = m.uids;
        if (Number.isInteger(m.entryFee)) this.entryFee = m.entryFee;
        if (Number.isInteger(m.spectators)) this.spectatorCount = m.spectators;
        // Rejoin accepted: rebuild at the given seat, then take the live state.
        this.beginGame(m.seed, m.names, m.playerIndex, m.aiNames || []);
        this.ctrl.game = m.state;
        // Sync AI-takeover flags (base AI seats are indices >= names.length).
        if (Array.isArray(m.aiTakeover)) {
          const take = new Set(m.aiTakeover);
          this.aiTakeover = {};
          m.aiTakeover.forEach((i) => { this.aiTakeover[i] = true; });
          const humanCount = (m.names || []).length;
          this.ctrl.game.players.forEach((p, i) => {
            p.isAI = i >= humanCount || take.has(i);
          });
        }
        if (this.usePeer && this.lastCode) this.saveRejoin(this.lastCode, m.playerIndex);
        this.cb.onRender();
        break;
      case MSG.ROSTER:
        this.names = m.names;
        if (Array.isArray(m.pids)) this.pids = m.pids;
        if (Array.isArray(m.uids)) this.uids = m.uids;
        if (Number.isInteger(m.entryFee)) this.entryFee = m.entryFee;
        if (Number.isInteger(m.spectators)) this.spectatorCount = m.spectators;
        // Sync AI-takeover seats (host converts disconnected seats to AI).
        if (this.ctrl && Array.isArray(m.aiTakeover)) {
          const take = new Set(m.aiTakeover);
          this.aiTakeover = {};
          m.aiTakeover.forEach((i) => { this.aiTakeover[i] = true; });
          const humanCount = (m.names || []).length;
          this.ctrl.game.players.forEach((p, i) => {
            p.isAI = i >= humanCount || take.has(i);
          });
        }
        if (this.phase !== 'playing') this.phase = this.role === 'spectator' ? 'spectlobby' : 'guestlobby';
        this.cb.onRender();
        break;
      case MSG.START:
        if (Array.isArray(m.pids)) this.pids = m.pids;
        if (Array.isArray(m.uids)) this.uids = m.uids;
        if (Number.isInteger(m.entryFee)) this.entryFee = m.entryFee;
        if (m.turnLimitMs) this.turnLimitMs = m.turnLimitMs;
        this.beginGame(m.seed, m.names, this.role === 'spectator' ? -1 : this.myIndex, m.aiNames || []);
        break;
      case MSG.ACTION: {
        if (this.phase !== 'playing' || !this.ctrl) return;
        // The host's action belongs to seat `from`. If my mirror says it is someone
        // else's turn (I already applied my own move locally and the host disagrees),
        // don't apply it to the wrong player: fetch the authoritative state.
        if (Number.isInteger(m.from) && m.from !== this.ctrl.game.current) {
          this.room.send(makeMsg(MSG.SYNC_REQ, {}));
          break;
        }
        const res = this.ctrl.applyRemote(m.action);
        this.cb.onRender();
        if (res.ok && stateHash(this.ctrl.game) !== m.h) {
          this.room.send(makeMsg(MSG.SYNC_REQ, {}));
        }
        this.saveMatch();
        if (this.ctrl.finished) this.reportResult();
        break;
      }
      case MSG.SYNC:
        if (this.ctrl) {
          this.ctrl.game = m.state;
          this.cb.onRender();
          this.saveMatch();
          if (this.ctrl.finished) this.reportResult();
        }
        break;
    }
  }

  // ---------- spectators ----------

  /** Host: a watch-only peer said hello. Never seated; receives every broadcast. */
  acceptSpectator(peerIdx) {
    if (this.peerToPlayer[peerIdx] != null) return; // a seated player can't switch to watching
    const isNew = !this.spectatorPeers.has(peerIdx);
    this.spectatorPeers.add(peerIdx);
    this.spectatorCount = this.spectatorPeers.size;
    const body = {
      names: this.names, uids: this.uids, pids: this.pids, aiNames: this.aiNames,
      turnLimitMs: this.turnLimitMs, entryFee: this.entryFee, spectators: this.spectatorCount,
    };
    if (this.phase === 'playing' && this.ctrl) {
      body.seed = this.seed;
      body.state = this.ctrl.game;
      body.aiTakeover = Object.keys(this.aiTakeover).map(Number);
    }
    this.room.sendTo(peerIdx, makeMsg(MSG.SPECTATE_OK, body));
    if (isNew) {
      this.room.broadcast(makeMsg(MSG.SPECTATORS, { n: this.spectatorCount }), peerIdx);
      this.cb.onRender();
    }
  }

  /** Host: a spectator peer left. */
  _spectatorLeft(peerIdx) {
    if (!this.spectatorPeers.delete(peerIdx)) return false;
    this.spectatorCount = this.spectatorPeers.size;
    this.room.broadcast(makeMsg(MSG.SPECTATORS, { n: this.spectatorCount }));
    this.cb.onRender();
    return true;
  }

  _applyTakeover(list, humanCount) {
    if (!this.ctrl || !Array.isArray(list)) return;
    const take = new Set(list);
    this.aiTakeover = {};
    list.forEach((i) => { this.aiTakeover[i] = true; });
    this.ctrl.game.players.forEach((p, i) => { p.isAI = i >= humanCount || take.has(i); });
  }

  // ---------- emoticons (stateless: no ACTION, no hash, no log/save) ----------

  _emoteOk(seat, k) {
    if (this.phase !== 'playing' || !this.ctrl) return false;
    if (!Number.isInteger(seat) || !EMOTES.includes(k)) return false;
    const pl = this.ctrl.game.players[seat];
    if (!pl || pl.isAI || this.aiTakeover[seat]) return false;
    const now = Date.now();
    if (now - (this._emoteAt[seat] || 0) < EMOTE_COOLDOWN_MS) return false;
    this._emoteAt[seat] = now;
    return true;
  }

  _showEmote(seat, k) {
    if (this.cb.onEmote) this.cb.onEmote({ from: seat, name: this.names[seat] || '', k });
  }

  /** Local player sends an emoticon. Returns true when sent. */
  sendEmote(k) {
    if (!this._emoteOk(this.myIndex, k)) return false;
    if (this.role === 'host') this.room.broadcast(makeMsg(MSG.EMOTE, { from: this.myIndex, k }));
    else this.room.send(makeMsg(MSG.EMOTE, { k }));
    this._showEmote(this.myIndex, k);
    return true;
  }

  // ---------- shared ----------

  onMsg(peerIdx, m) {
    if (!m) return;
    if (m.t === MSG.PING) {
      if (this.role === 'host') this.room.sendTo(peerIdx, makeMsg(MSG.PONG, {}));
      return;
    }
    if (this.role === 'host') this.hostMsg(peerIdx, m);
    else this.guestMsg(m); // guests and spectators share the mirror protocol
  }

  beginGame(seed, names, myIndex, aiNames = []) {
    // Lockstep: every client builds the identical deterministic engine.
    // hooks are empty — no dex/save/achievement recording in multiplayer (v1).
    // AI seats (if any) are acted by the host; their actions are relayed like any other.
    // Multiplayer AI is fixed to hard difficulty.
    const ctrl = createController({ cards: CARDS, seed, mp: { names, me: myIndex, aiNames }, hooks: {}, difficulty: 'hard' });
    const raw = ctrl.dispatch.bind(ctrl);
    const self = this;
    // Spectators mirror the game with no seat (me = -1): nothing is ever dispatched locally.
    ctrl.spectator = myIndex < 0;
    ctrl.mp.spectator = ctrl.spectator;
    ctrl.mp.getSpectators = () => self.spectatorCount;
    // Expose turn timer to UI via mp object.
    ctrl.mp.getTurnRemaining = () => self.getTurnRemaining();
    ctrl.dispatch = (action) => {
      const actor = ctrl.game.current;
      const res = raw(action);
      if (res.ok) {
        self.sendAction(action, actor);
        self.resetTurnTimer();
      }
      return res;
    };
    ctrl.applyRemote = (action) => {
      const res = raw(action);
      if (res.ok) self.resetTurnTimer();
      return res;
    };
    this.ctrl = ctrl;
    this.seed = seed;
    this.names = names;
    this.aiNames = aiNames;
    this.myIndex = myIndex;
    this.phase = 'playing';
    this._matchSaved = false;
    this._resultSent = false;
    this.actionCount = 0;
    this._commitChain = Promise.resolve();
    this.resetTurnTimer();
    this.startTurnTimer();
    this.cb.onGameStart(ctrl);
  }

  /** Reset the 90s turn timer. Called on game start and after each action. */
  resetTurnTimer() {
    this.turnDeadline = Date.now() + this.turnLimitMs;
  }

  /** Get remaining seconds for current turn. */
  getTurnRemaining() {
    if (this.phase !== 'playing' || !this.turnDeadline) return 0;
    return Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000));
  }

  /** Host: start the timer that enforces turn timeouts. */
  startTurnTimer() {
    this.stopTurnTimer();
    if (this.role !== 'host') return;
    this._turnTimer = setInterval(() => {
      if (this.phase !== 'playing' || !this.ctrl) return;
      if (Date.now() >= this.turnDeadline + TIMEOUT_GRACE_MS) {
        // Time's up! Force a pass for the current player.
        const current = this.ctrl.game.current;
        // Only auto-pass if it's a human's turn (AI acts on its own).
        const isAI = !!(this.ctrl.game.players[current] && this.ctrl.game.players[current].isAI);
        if (!isAI) {
          const phaseBefore = this.ctrl.game.phase;
          const timeoutAction = { type: 'timeout' };
          const res = this.ctrl.applyRemote(timeoutAction);
          if (res.ok) {
            this.hostCommit(timeoutAction, current);
            // Penalty is visible: in the action phase the player gains nothing.
            const msg = phaseBefore === 'action'
              ? `⏰ ${this.names[current]}의 시간이 초과돼 공도 못 고르고 차례를 넘겼어요.`
              : `⏰ ${this.names[current]}의 시간이 초과돼 자동으로 넘겼어요.`;
            this.cb.onNotice(msg);
          }
        }
        this.resetTurnTimer();
      }
    }, 1000);
    // Don't keep Node.js process alive in tests.
    if (this._turnTimer.unref) this._turnTimer.unref();
  }

  stopTurnTimer() {
    if (this._turnTimer) {
      clearInterval(this._turnTimer);
      this._turnTimer = null;
    }
  }

  sendAction(action, fromIdx) {
    if (this.phase !== 'playing' || !this.ctrl) return;
    if (this.role === 'host') {
      this.hostCommit(action, fromIdx ?? this.myIndex);
    } else {
      this.room.send(makeMsg(MSG.ACTION, { action }));
    }
  }

  /**
   * Host: commit an applied action — persist the authoritative snapshot first,
   * then broadcast. Commits are chained so snapshot/broadcast order is always
   * sequential; the snapshot is therefore a superset of every guest's mirror.
   */
  hostCommit(action, fromIdx, except = -1) {
    // The chain never stays rejected: a failed commit must not stall later ones.
    const run = () => this._doCommit(action, fromIdx, except).catch(() => {});
    this._commitChain = this._commitChain.then(run, run);
  }

  async _doCommit(action, fromIdx, except = -1) {
    if (this.phase !== 'playing' || !this.ctrl || this.role !== 'host') return;
    this.actionCount += 1;
    const h = stateHash(this.ctrl.game);
    if (this.room && typeof this.room.writeSnapshot === 'function') {
      await this.room.writeSnapshot(this.ctrl.game, h, this.actionCount);
    }
    this.room.broadcast(makeMsg(MSG.ACTION, { from: fromIdx, action, h }), except);
    this.cb.onRender();
    if (this.ctrl.finished) {
      this.saveMatch();
      this.reportResult();
      if (typeof this.room.markFinished === 'function') this.room.markFinished().catch(() => {});
    }
  }

  /**
   * Store this finished game for friend stats, once. Host writes every human seat
   * (covers seats taken over by AI); guests write their own seat, so results are
   * kept even when the host runs an old build. Ids are write-once per seat.
   */
  saveMatch() {
    if (this._matchSaved || !this.ctrl || !this.ctrl.finished || !this.usePeer) return;
    if (this.role === 'spectator') return;
    this._matchSaved = true;
    const code = (this.room && this.room.code) || this.shortCode || this.lastCode || '';
    const pids = [...(this.pids || [])];
    if (this.myIndex >= 0 && this.myPid) pids[this.myIndex] = this.myPid;
    const only = this.role === 'host' ? null : this.myIndex;
    for (const { id, rec } of buildResults(this.ctrl.game, this.names, pids, code, this.seed, only)) {
      Promise.resolve(this.writeMatch(id, rec)).catch(() => {});
    }
  }

  /** Host: a disconnected seat is immediately taken over by AI. */
  convertToAI(pIdx) {
    if (pIdx == null || this.aiTakeover[pIdx]) return;
    const who = this.names[pIdx] || '게스트';
    this.aiTakeover[pIdx] = true;
    if (this.ctrl && this.ctrl.game.players[pIdx]) {
      this.ctrl.game.players[pIdx].isAI = true;
    }
    this.broadcastRoster();
    this.cb.onNotice(`📡 ${who}의 연결이 끊겨 AI가 이어받아요.`);
    this.cb.onRender();
    // The host's render loop (scheduleAI) will drive this seat from now on.
  }

  onLeave(peerIdx) {
    if (this.role === 'host' && this._spectatorLeft(peerIdx)) return;
    if (this.role === 'spectator') {
      // Host gone: spectators never promote; wait for a guest to take over.
      this.cb.onNotice('📡 방장의 연결이 끊겼어요. 승계를 기다리는 중...');
      this.cb.onRender();
      return;
    }
    if (this.phase === 'playing') {
      if (this.role === 'host') {
        const pIdx = this.peerToPlayer[peerIdx];
        if (pIdx == null || this.aiTakeover[pIdx]) return;
        this.convertToAI(pIdx);
        return;
      }
      // Guest: the host is gone. Try to take over as the new host.
      this.onHostGone();
      return;
    }
    // Guest in lobby: host left -> try to take over instead of killing the room.
    if (this.role === 'guest') {
      this.onHostGone();
      return;
    }
    if (this.role === 'host' && (this.phase === 'hostlobby' || this.phase === 'hostoffer')) {
      const pIdx = this.peerToPlayer[peerIdx];
      if (pIdx == null) return;
      delete this.peerToPlayer[peerIdx];
      this.names.splice(pIdx, 1);
      this.pids.splice(pIdx, 1);
      this.uids.splice(pIdx, 1);
      for (const k of Object.keys(this.peerToPlayer)) {
        if (this.peerToPlayer[k] > pIdx) this.peerToPlayer[k] -= 1;
      }
      this.broadcastRoster();
      this.cb.onRender();
    }
  }

  /** Guest: host connection lost (in game or lobby). Compete for the host lock, then promote. */
  async onHostGone() {
    if (this.role !== 'guest' || this._promoting) return;
    if (this.phase !== 'playing' && this.phase !== 'guestlobby') return;
    this._promoting = true;
    const inGame = this.phase === 'playing';
    this.cb.onNotice(inGame ? '📡 방장의 연결이 끊겼어요. 새 방장을 정하는 중...' : '📡 방장이 나갔어요. 새 방장을 정하는 중...');
    this.cb.onRender();
    try {
      // Small jitter to reduce lock contention.
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      if (this.role !== 'guest') return;
      if (this.phase !== 'playing' && this.phase !== 'guestlobby') return;
      if (typeof this.room.tryAcquireHostLock !== 'function') {
        this.cb.onNotice('📡 방장의 연결이 끊겼어요. 방이 종료됩니다.');
        this.end();
        return;
      }
      const acquired = await this.room.tryAcquireHostLock();
      if (acquired) {
        await this.promoteToHost();
      } else {
        this._watchForNewHost();
      }
    } catch {
      this.cb.onNotice('📡 방장 승계에 실패했어요. 방이 종료됩니다.');
      this.end();
    } finally {
      this._promoting = false;
    }
  }

  /** Guest: wait for another guest's promotion; retry if nobody takes over. */
  _watchForNewHost() {
    this._waitingForHost = Date.now();
    this.cb.onNotice('📡 다른 게스트가 방장을 이어받는 중...');
    this.cb.onRender();
    setTimeout(() => {
      if (!this._waitingForHost || this.phase !== 'playing' || this.role !== 'guest') return;
      // Still no host after 30s (promoter may have died) → retry.
      this._waitingForHost = 0;
      this.onHostGone();
    }, 30000);
  }

  /** Guest: someone else became the new host. Resume as guest. */
  onHostBack() {
    if (this.phase !== 'playing' || (this.role !== 'guest' && this.role !== 'spectator')) return;
    this._waitingForHost = 0;
    this.cb.onNotice('📡 새 방장이 게임을 이어받았어요.');
    this.cb.onRender();
  }

  /** Guest: room node deleted = host ended the game intentionally. */
  onRoomDeleted() {
    if (this.role !== 'guest' && this.role !== 'spectator') return;
    if (this.phase === 'playing') {
      this.cb.onNotice('📡 방장이 게임을 종료했어요.');
    } else {
      this.cb.onNotice('📡 방이 종료됐어요.');
    }
    this.end();
  }

  /** Host: another client claimed hostId (split-brain). Step down. */
  onSuperseded() {
    if (this.phase !== 'playing') return;
    this.cb.onNotice('📡 다른 기기가 방장을 이어받았어요. 이 화면은 종료됩니다.');
    this.end();
  }

  /** Guest: promote to host. Old host's seat (index 0) becomes AI.
   * In game: adopt the authoritative snapshot when the local mirror diverged,
   * then broadcast a full SYNC so every guest aligns immediately.
   * In lobby: keep the lobby alive under the same room code. */
  async promoteToHost() {
    const inGame = this.phase === 'playing';
    // Read the authoritative snapshot while still a guest (room flips isHost).
    let snap = null;
    if (inGame && this.ctrl) {
      try {
        snap = (this.room && typeof this.room.readSnapshot === 'function')
          ? await this.room.readSnapshot()
          : null;
      } catch { /* fall back to the local mirror */ }
    }
    this.role = 'host';
    const guestMap = await this.room.promoteToHost(this.myName);
    this.peerToPlayer = guestMap;
    this.spectatorPeers = new Set(Array.isArray(this.room.promotedSpectators) ? this.room.promotedSpectators : []);
    this.spectatorCount = this.spectatorPeers.size;
    if (inGame && this.ctrl) {
      if (snap && snap.state && snap.h) {
        // Keep the snapshot sequence monotonic even when the mirror is fine.
        if (Number.isInteger(snap.n)) this.actionCount = Math.max(this.actionCount, snap.n);
        if (snap.h !== stateHash(this.ctrl.game)) {
          // My mirror diverged (missed the last broadcasts): adopt the snapshot,
          // which is a superset of everything any guest has seen.
          this.ctrl.game = snap.state;
          // Re-derive AI-takeover seats from the authoritative flags.
          const humanCount = (this.names || []).length;
          this.aiTakeover = {};
          this.ctrl.game.players.forEach((p, i) => {
            if (p.isAI && i < humanCount) this.aiTakeover[i] = true;
          });
        }
      }
      // The old host's seat is now AI-driven.
      const oldHostIdx = 0;
      this.aiTakeover[oldHostIdx] = true;
      if (this.ctrl.game.players[oldHostIdx]) {
        this.ctrl.game.players[oldHostIdx].isAI = true;
      }
      this.resetTurnTimer();
      this.startTurnTimer();
      // Full-state SYNC: align every guest at once instead of piecemeal hash repair.
      this.room.broadcast(makeMsg(MSG.SYNC, { state: this.ctrl.game }));
      this.broadcastRoster();
      this.cb.onNotice('📡 방장 연결이 끊겨 그 자리는 AI가 이어받고, 당신이 새 방장이 됐어요.');
    } else {
      if (this.phase === 'guestlobby') this.phase = 'hostlobby';
      this.broadcastRoster();
      this.cb.onNotice('📡 방장이 나가서 당신이 새 방장이 됐어요. 같은 코드로 이어서 진행하세요.');
    }
    this.cb.onRender();
  }

  end() {
    this.stopTurnTimer();
    this._promoting = false;
    this._waitingForHost = 0;
    // Host closes an unstarted paid room: refund every entry fee (server-side).
    if (this.role === 'host' && this.escrow && this.escrow.status === 'open' && this.phase !== 'playing') {
      const code = this.roomCode();
      if (code) Promise.resolve(this.wallet.cancelRoom(code)).catch(() => {});
    }
    this._unwatchEscrow();
    try { this.room?.close(); } catch { /* noop */ }
    this.clearRejoin();
    this.reset();
    this.cb.onGameEnd();
  }
}
