// localStorage persistence: Pokedex (cumulative caught record) and the in-progress game save.
// Storage is injected so tests can use a Map-backed fake; every access is try/catch'd because
// localStorage can throw (private mode, blocked site data) and the game must still run without it.

export const DEX_KEY = 'pks-dex-v1';
export const SAVE_KEY = 'pks-save-v1';

export function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readJSON(storage, key) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJSON(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------- Pokedex ----------
// { v:1, caught: { [cardId]: { n, first, last, evolved } }, games: { played, won } }

const emptyDex = () => ({ v: 1, caught: {}, games: { played: 0, won: 0 } });

export function loadDex(storage) {
  const d = readJSON(storage, DEX_KEY);
  if (!isObj(d) || d.v !== 1 || !isObj(d.caught)) return emptyDex();
  const dex = emptyDex();
  for (const [id, e] of Object.entries(d.caught)) {
    if (isObj(e) && Number.isInteger(e.n) && e.n > 0) {
      dex.caught[id] = { n: e.n, first: Number(e.first) || 0, last: Number(e.last) || 0, evolved: Math.max(0, e.evolved | 0) };
    }
  }
  if (isObj(d.games)) dex.games = { played: Math.max(0, d.games.played | 0), won: Math.max(0, d.games.won | 0) };
  return dex;
}

// kind: 'buy' (captured) | 'evolve' (obtained by evolution). Both count as "caught".
export function recordCatch(storage, cardId, kind = 'buy', now = Date.now()) {
  const dex = loadDex(storage);
  const e = dex.caught[cardId] ?? { n: 0, first: now, last: now, evolved: 0 };
  e.n += 1;
  e.last = now;
  if (kind === 'evolve') e.evolved += 1;
  dex.caught[cardId] = e;
  writeJSON(storage, DEX_KEY, dex);
  return dex;
}

export function recordGame(storage, won) {
  const dex = loadDex(storage);
  dex.games.played += 1;
  if (won) dex.games.won += 1;
  writeJSON(storage, DEX_KEY, dex);
  return dex;
}

export function dexSummary(dex, cards) {
  const ids = new Set(cards.map((c) => c.id));
  const caught = Object.keys(dex.caught).filter((id) => ids.has(id)).length;
  return { caught, total: cards.length };
}

// ---------- game save ----------
// { v:1, savedAt, seed, humanName, aiNames, log, game }  — game is the engine's plain-JSON state.

export function saveGame(storage, snap, now = Date.now()) {
  return writeJSON(storage, SAVE_KEY, { v: 1, savedAt: now, ...snap });
}

export function clearSave(storage) {
  try { storage?.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

// Returns the save only when it is structurally sound AND resumable; anything else is dropped
// (a corrupt save must never brick the start screen).
export function loadSave(storage, cards) {
  const s = readJSON(storage, SAVE_KEY);
  if (!isObj(s) || s.v !== 1 || !isObj(s.game) || typeof s.humanName !== 'string' || !Array.isArray(s.aiNames)) return null;
  const g = s.game;
  if (!Array.isArray(g.players) || g.players.length < 2 || g.players.length > 4) return null;
  if (!isObj(g.supply) || !isObj(g.table) || !isObj(g.decks) || typeof g.rng !== 'number') return null;
  if (g.phase === 'finished' || g.ranking) return null;
  const ids = new Set(cards.map((c) => c.id));
  const known = (c) => isObj(c) && ids.has(c.id);
  for (const p of g.players) {
    if (!Array.isArray(p.tableau) || !Array.isArray(p.hand) || !Array.isArray(p.evolved) || !isObj(p.tokens)) return null;
    if (![...p.tableau, ...p.hand, ...p.evolved].every(known)) return null;
  }
  for (const k of Object.keys(g.table)) if (!Array.isArray(g.table[k]) || !g.table[k].every((c) => c === null || known(c))) return null;
  for (const k of Object.keys(g.decks)) if (!Array.isArray(g.decks[k]) || !g.decks[k].every(known)) return null;
  return s;
}
