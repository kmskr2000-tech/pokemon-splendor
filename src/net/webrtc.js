// WebRTC room for local multiplayer (no server).
// Star topology: the host keeps one RTCPeerConnection per guest (max 3).
// Guests only ever talk to the host; the host relays game actions.
// Signaling is manual: offer/answer codes are copy-pasted by the players.

import { encodeSignal, decodeSignal, parseMsg } from './protocol.js?v=1791272191';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const ICE_TIMEOUT_MS = 4000;

function waitIceComplete(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ICE_TIMEOUT_MS);
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function makePC() {
  return new RTCPeerConnection({ iceServers: ICE });
}

export class NetRoom {
  constructor({ onmessage = () => {}, onjoin = () => {}, onleave = () => {} } = {}) {
    this.onmessage = onmessage;
    this.onjoin = onjoin;
    this.onleave = onleave;
    this.isHost = false;
    this.peers = []; // host: [{pc, dc, name}], guest: single entry (the host)
    this.closed = false;
  }

  _wire(pc, dc, peerIdx) {
    dc.onmessage = (e) => {
      const m = parseMsg(e.data);
      if (m) this.onmessage(peerIdx, m);
    };
    const gone = () => { if (!this.closed) this.onleave(peerIdx); };
    dc.onclose = gone;
    dc.onerror = gone;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.onjoin(peerIdx);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') gone();
    };
  }

  // ---------- host ----------

  /** Create an offer for a new guest. Returns {peerIdx, code}. */
  async createOffer() {
    this.isHost = true;
    const pc = makePC();
    const dc = pc.createDataChannel('game');
    const peerIdx = this.peers.length;
    this.peers.push({ pc, dc, name: '' });
    this._wire(pc, dc, peerIdx);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
    return { peerIdx, code: encodeSignal(pc.localDescription) };
  }

  /** Complete the handshake for a guest that sent back an answer code. */
  async acceptAnswer(peerIdx, code) {
    const peer = this.peers[peerIdx];
    if (!peer) throw new Error('unknown peer');
    await peer.pc.setRemoteDescription(decodeSignal(code));
  }

  /** Send to one guest (host only). */
  sendTo(peerIdx, msg) {
    const peer = this.peers[peerIdx];
    if (peer && peer.dc.readyState === 'open') peer.dc.send(msg);
  }

  /** Send to all guests, optionally skipping one (host only). */
  broadcast(msg, except = -1) {
    this.peers.forEach((_, i) => { if (i !== except) this.sendTo(i, msg); });
  }

  // ---------- guest ----------

  /** Join with the host's offer code. Returns the answer code to give back. */
  async join(offerCode) {
    this.isHost = false;
    const pc = makePC();
    pc.ondatachannel = (e) => {
      this.peers[0] = { pc, dc: e.channel, name: '' };
      this._wire(pc, e.channel, 0);
    };
    await pc.setRemoteDescription(decodeSignal(offerCode));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceComplete(pc);
    return encodeSignal(pc.localDescription);
  }

  /** Send to the host (guest only). */
  send(msg) {
    const peer = this.peers[0];
    if (peer && peer.dc.readyState === 'open') peer.dc.send(msg);
  }

  close() {
    this.closed = true;
    for (const p of this.peers) {
      try { p.dc.close(); } catch {}
      try { p.pc.close(); } catch {}
    }
    this.peers = [];
  }
}
