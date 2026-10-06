// Multiplayer protocol: message shapes, signaling codec, and canonical state hash.
// Transport-agnostic: works over any ordered reliable channel (WebRTC DataChannel).

export const MSG = {
  HELLO: 'hello',     // G->H {name}
  WELCOME: 'welcome',   // H->G {playerIndex}
  ROSTER: 'roster',    // H->G {names[]} lobby roster update
  START: 'start',      // H->G {seed, names[]} begin game (lockstep)
  ACTION: 'action',    // G->H {action} | H->G {from, action, h}
  SYNC_REQ: 'sync-req',// G->H {} hash mismatch
  SYNC: 'sync',        // H->G {state} full state resync
  PING: 'ping',        // both ways {t}
  PONG: 'pong',        // both ways {t}
  BYE: 'bye',          // both ways {}
};

export function makeMsg(t, body = {}) {
  return JSON.stringify({ t, ...body });
}

export function parseMsg(raw) {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o.t !== 'string') return null;
    return o;
  } catch {
    return null;
  }
}

// ---------- manual signaling codec ----------
// SDP offer/answer -> short copy-pasteable code (base64 of compact JSON).

export function encodeSignal(desc) {
  const min = JSON.stringify({ t: desc.type, s: desc.sdp });
  return btoa(unescape(encodeURIComponent(min)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSignal(code) {
  try {
    const b64 = String(code || '').replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const o = JSON.parse(json);
    if (!o || (o.t !== 'offer' && o.t !== 'answer') || typeof o.s !== 'string') {
      throw new Error('bad signal code');
    }
    return { type: o.t, sdp: o.s };
  } catch (e) {
    if (e && e.message === 'bad signal code') throw e;
    throw new Error('bad signal code');
  }
}

// ---------- canonical state hash (FNV-1a 32-bit) ----------
// Used to detect lockstep divergence. Must be stable across clients.

function canonState(s) {
  const ids = (arr) => (arr || []).map((c) => (c && c.id) || null);
  return {
    rng: s.rng,
    current: s.current,
    turn: s.turn,
    phase: s.phase,
    supply: s.supply,
    table: Object.fromEntries(Object.entries(s.table || {}).map(([k, v]) => [k, ids(v)])),
    decks: Object.fromEntries(Object.entries(s.decks || {}).map(([k, v]) => [k, v.length])),
    players: (s.players || []).map((p) => ({
      tokens: p.tokens,
      tableau: ids(p.tableau),
      hand: ids(p.hand),
      evolved: ids(p.evolved),
    })),
    endTriggeredBy: s.endTriggeredBy,
  };
}

export function stateHash(state) {
  const str = JSON.stringify(canonState(state));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
