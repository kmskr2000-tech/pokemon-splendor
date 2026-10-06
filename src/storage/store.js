// localStorage persistence: Pokedex (cumulative caught record) and the in-progress game save.
// Storage is injected so tests can use a Map-backed fake; every access is try/catch'd because
// localStorage can throw (private mode, blocked site data) and the game must still run without it.

export const DEX_KEY = 'pks-dex-v1';
export const SAVE_KEY = 'pks-save-v1';
export const OPTS_KEY = 'pks-opts-v1';
export const ACHV_KEY = 'pks-achv-v1';
export const RECORDS_KEY = 'pks-records-v1';

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

// ---------- Options ----------
// { v:1, beginnerHelp: bool }

const defaultOptions = () => ({ v: 1, beginnerHelp: true, difficulty: 'normal', personality: 'random', playerName: '' });

const DIFFS = new Set(['easy', 'normal', 'hard']);
const PERSS = new Set(['random', 'specialized', 'opportunistic', 'balanced']);

export function loadOptions(storage) {
  const o = readJSON(storage, OPTS_KEY);
  if (!isObj(o)) return defaultOptions();
  return {
    v: 1,
    beginnerHelp: o.beginnerHelp !== false,
    difficulty: DIFFS.has(o.difficulty) ? o.difficulty : 'normal',
    personality: PERSS.has(o.personality) ? o.personality : 'random',
    playerName: typeof o.playerName === 'string' ? o.playerName.slice(0, 12) : '',
  };
}

export function saveOptions(storage, opts) {
  writeJSON(storage, OPTS_KEY, {
    v: 1,
    beginnerHelp: !!opts.beginnerHelp,
    difficulty: DIFFS.has(opts.difficulty) ? opts.difficulty : 'normal',
    personality: PERSS.has(opts.personality) ? opts.personality : 'random',
    playerName: typeof opts.playerName === 'string' ? opts.playerName.slice(0, 12) : '',
  });
}

// ---------- Achievements ----------
// { v:1, unlocked: { [id]: timestamp } }

export function loadAchv(storage) {
  const o = readJSON(storage, ACHV_KEY);
  if (!isObj(o) || !isObj(o.unlocked)) return { v: 1, unlocked: {} };
  return { v: 1, unlocked: o.unlocked };
}

export function unlockAchv(storage, ids, now = Date.now()) {
  const a = loadAchv(storage);
  let changed = false;
  for (const id of ids) {
    if (!a.unlocked[id]) { a.unlocked[id] = now; changed = true; }
  }
  if (changed) writeJSON(storage, ACHV_KEY, a);
  return changed;
}

// ---------- Records ----------
// Victory score: win ? 1000 + points*10 + max(0, 60-turns)*5 + diffBonus : points*10
// { v:1, best: number, games: number, wins: number, history: [{score, won, points, turns, difficulty, date}] }

const DIFF_BONUS = { easy: 0, normal: 100, hard: 200 };

export function victoryScore({ won, points, turns, difficulty }) {
  const base = points * 10 + Math.max(0, 60 - turns) * 5 + (DIFF_BONUS[difficulty] ?? 0);
  return won ? 1000 + base : base;
}

export function loadRecords(storage) {
  const o = readJSON(storage, RECORDS_KEY);
  if (!isObj(o)) return { v: 1, best: 0, games: 0, wins: 0, history: [] };
  return {
    v: 1,
    best: typeof o.best === 'number' ? o.best : 0,
    games: typeof o.games === 'number' ? o.games : 0,
    wins: typeof o.wins === 'number' ? o.wins : 0,
    history: Array.isArray(o.history) ? o.history.slice(-20) : [],
  };
}

export function recordResult(storage, result, now = Date.now()) {
  const r = loadRecords(storage);
  const score = victoryScore(result);
  r.games += 1;
  if (result.won) r.wins += 1;
  r.best = Math.max(r.best, score);
  r.history.push({ score, ...result, date: now });
  r.history = r.history.slice(-20);
  writeJSON(storage, RECORDS_KEY, r);
  return { score, isBest: score >= r.best && score > 0 };
}

// ---------- Challenges ----------
// { v:1, completed: { [id]: timestamp } }

export const CHAL_KEY = 'pks-chal-v1';

export function loadChal(storage) {
  const o = readJSON(storage, CHAL_KEY);
  if (!isObj(o) || !isObj(o.completed)) return { v: 1, completed: {} };
  return { v: 1, completed: o.completed };
}

export function completeChal(storage, id, now = Date.now()) {
  const c = loadChal(storage);
  if (!c.completed[id]) {
    c.completed[id] = now;
    writeJSON(storage, CHAL_KEY, c);
    return true;
  }
  return false;
}
