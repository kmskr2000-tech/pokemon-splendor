// Multiplayer session: owns the NetRoom, the lockstep protocol flow, and the
// multiplayer controller. main.js only renders `session` state and forwards taps.

import { CARDS } from '../data/cards.js?v=1791272191';
import { createController } from '../ui/controller.js?v=1791272191';
import { NetRoom } from './webrtc.js?v=1791272191';
import { PeerRoom } from './peerroom.js?v=1791272191';
import { MSG, makeMsg, stateHash } from './protocol.js?v=1791272191';

const MAX_PLAYERS = 4;

export class NetSession {
  // cb: { onRender(), onGameStart(ctrl), onGameEnd(), onNotice(msg) }
  // opts.usePeer: true = short-code via PeerJS (default), false = manual offer/answer.
  constructor(cb, opts = {}) {
    this.cb = cb;
    this.usePeer = opts.usePeer !== false;
    this.reset();
  }

  reset() {
    this.role = null; // 'host' | 'guest'
    this.phase = 'menu'; // menu|hostname|hostoffer|hostlobby|guestname|guestjoin|guestanswer|guestlobby|busy|playing
    this.room = null;
    this.myName = '';
    this.myIndex = -1;
    this.names = [];
    this.offerCode = '';
    this.answerCode = '';
    this.shortCode = ''; // peer mode: 6-char room code
    this.pendingPeer = -1;
    this.peerToPlayer = {}; // host: peerIdx -> playerIndex
    this.ctrl = null;
  }

  cleanName(n) {
    return String(n || '').trim().slice(0, 12) || '트레이너';
  }

  makeRoom() {
    const handlers = {
      onmessage: (i, m) => this.onMsg(i, m),
      onjoin: () => {
        // Guest: connection open -> introduce ourselves; host replies with welcome+roster.
        if (this.role === 'guest' && this.room) {
          this.room.send(makeMsg(MSG.HELLO, { name: this.myName }));
          this.phase = 'guestlobby';
          this.cb.onRender();
        }
      },
      onleave: (i) => this.onLeave(i),
    };
    return this.usePeer ? new PeerRoom(handlers) : new NetRoom(handlers);
  }

  // ---------- host ----------

  async hostCreate(name) {
    this.role = 'host';
    this.myName = this.cleanName(name);
    this.names = [this.myName];
    this.myIndex = 0;
    this.room = this.makeRoom();
    // Guest connections arrive via onMsg(hello) in both transports.
    if (this.usePeer) this.room.onjoin = () => {};
    this.phase = 'busy';
    this.cb.onRender();
    try {
      if (this.usePeer) {
        this.shortCode = await this.room.hostCreate();
        this.phase = 'hostlobby';
      } else {
        const { peerIdx, code } = await this.room.createOffer();
        this.pendingPeer = peerIdx;
        this.offerCode = code;
        this.phase = 'hostoffer';
      }
    } catch {
      this.phase = 'hostname';
      this.cb.onNotice('방 생성에 실패했어요. 다시 시도해주세요.');
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
    this.room.broadcast(makeMsg(MSG.ROSTER, { names: this.names }));
  }

  hostStart() {
    if (this.names.length < 2 || this.names.length > MAX_PLAYERS) return;
    const seed = (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
    this.beginGame(seed, [...this.names], 0);
    this.room.broadcast(makeMsg(MSG.START, { seed, names: this.names }));
  }

  hostMsg(peerIdx, m) {
    switch (m.t) {
      case MSG.HELLO: {
        if (this.names.length >= MAX_PLAYERS) return;
        if (this.peerToPlayer[peerIdx] != null) return; // already joined
        const idx = this.names.length;
        this.names.push(this.cleanName(m.name));
        this.peerToPlayer[peerIdx] = idx;
        this.room.sendTo(peerIdx, makeMsg(MSG.WELCOME, { playerIndex: idx }));
        this.broadcastRoster();
        this.offerCode = '';
        this.phase = 'hostlobby';
        this.cb.onRender();
        break;
      }
      case MSG.ACTION: {
        if (this.phase !== 'playing' || !this.ctrl) return;
        const res = this.ctrl.applyRemote(m.action);
        if (res.ok) {
          const pIdx = this.peerToPlayer[peerIdx];
          this.room.broadcast(
            makeMsg(MSG.ACTION, { from: pIdx, action: m.action, h: stateHash(this.ctrl.game) }),
            peerIdx,
          );
          this.cb.onRender();
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

  async guestJoin(name, code) {
    this.role = 'guest';
    this.myName = this.cleanName(name);
    this.room = this.makeRoom();
    this.phase = 'busy';
    this.cb.onRender();
    try {
      if (this.usePeer) {
        await this.room.guestJoin(code);
        // onjoin -> hello -> welcome/roster -> guestlobby
      } else {
        this.answerCode = await this.room.join(String(code || '').trim());
        this.phase = 'guestanswer';
      }
    } catch {
      this.phase = 'guestjoin';
      this.cb.onNotice(this.usePeer
        ? '코드가 올바르지 않거나 방장이 오프라인이에요. 다시 확인해주세요.'
        : '코드가 올바르지 않아요. 방장에게 다시 받아주세요.');
    }
    this.cb.onRender();
  }

  guestMsg(m) {
    switch (m.t) {
      case MSG.WELCOME:
        this.myIndex = m.playerIndex;
        break;
      case MSG.ROSTER:
        this.names = m.names;
        if (this.phase !== 'playing') this.phase = 'guestlobby';
        this.cb.onRender();
        break;
      case MSG.START:
        this.beginGame(m.seed, m.names, this.myIndex);
        break;
      case MSG.ACTION: {
        if (this.phase !== 'playing' || !this.ctrl) return;
        const res = this.ctrl.applyRemote(m.action);
        this.cb.onRender();
        if (res.ok && stateHash(this.ctrl.game) !== m.h) {
          this.room.send(makeMsg(MSG.SYNC_REQ, {}));
        }
        break;
      }
      case MSG.SYNC:
        if (this.ctrl) {
          this.ctrl.game = m.state;
          this.cb.onRender();
        }
        break;
    }
  }

  // ---------- shared ----------

  onMsg(peerIdx, m) {
    if (!m) return;
    if (m.t === MSG.PING) {
      if (this.role === 'host') this.room.sendTo(peerIdx, makeMsg(MSG.PONG, {}));
      return;
    }
    if (this.role === 'host') this.hostMsg(peerIdx, m);
    else this.guestMsg(m);
  }

  beginGame(seed, names, myIndex) {
    // Lockstep: every client builds the identical deterministic engine.
    // hooks are empty — no dex/save/achievement recording in multiplayer (v1).
    const ctrl = createController({ cards: CARDS, seed, mp: { names, me: myIndex }, hooks: {} });
    const raw = ctrl.dispatch.bind(ctrl);
    const self = this;
    ctrl.dispatch = (action) => {
      const res = raw(action);
      if (res.ok) self.sendAction(action);
      return res;
    };
    ctrl.applyRemote = (action) => raw(action);
    this.ctrl = ctrl;
    this.names = names;
    this.myIndex = myIndex;
    this.phase = 'playing';
    this.cb.onGameStart(ctrl);
  }

  sendAction(action) {
    if (this.phase !== 'playing' || !this.ctrl) return;
    if (this.role === 'host') {
      this.room.broadcast(makeMsg(MSG.ACTION, { from: this.myIndex, action, h: stateHash(this.ctrl.game) }));
    } else {
      this.room.send(makeMsg(MSG.ACTION, { action }));
    }
  }

  onLeave(peerIdx) {
    if (this.phase === 'playing') {
      const who = this.role === 'host'
        ? (this.names[this.peerToPlayer[peerIdx]] || '게스트')
        : '방장';
      this.cb.onNotice(`📡 ${who}의 연결이 끊겼어요. 대전이 종료됩니다.`);
      this.end();
      return;
    }
    if (this.role === 'host' && (this.phase === 'hostlobby' || this.phase === 'hostoffer')) {
      const pIdx = this.peerToPlayer[peerIdx];
      if (pIdx == null) return;
      delete this.peerToPlayer[peerIdx];
      this.names.splice(pIdx, 1);
      for (const k of Object.keys(this.peerToPlayer)) {
        if (this.peerToPlayer[k] > pIdx) this.peerToPlayer[k] -= 1;
      }
      this.broadcastRoster();
      this.cb.onRender();
    }
  }

  end() {
    try { this.room?.close(); } catch { /* noop */ }
    this.reset();
    this.cb.onGameEnd();
  }
}
