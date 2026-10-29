// Friend match stats (multiplayer). Pure helpers: build a match record from a
// finished game, and aggregate stored records into per-player win/loss rows.
// Players are keyed by a per-device id (pid), so renaming keeps the history.

const PID_RE = /^[A-Za-z0-9]{6,24}$/;

export const cleanPid = (p) => (typeof p === 'string' && PID_RE.test(p) ? p : '');

/**
 * Per-seat result records for a finished multiplayer game. One record per human
 * seat (id `${code}-${seed}-${seat}`), so every client can save its own result
 * and the host can fill in the rest; the DB is write-once, so duplicates collapse.
 * `onlySeat` limits output to one seat (guests save just themselves).
 */
export function buildResults(game, names, pids, code, seed, onlySeat = null, now = Date.now()) {
  const humans = names.length;
  const top = (game.ranking || []).filter((r) => r.rank === 1).length; // >1 = shared 1st (draw)
  const out = [];
  for (const r of game.ranking || []) {
    if (r.player >= humans) continue; // base AI seat
    if (onlySeat !== null && r.player !== onlySeat) continue;
    const pid = cleanPid(pids[r.player]);
    if (!pid) continue; // unknown device (old client): can't attribute
    out.push({
      id: `${code || 'X'}-${seed >>> 0}-${r.player}`,
      rec: {
        at: now, code: code || '', humans, top, seats: (game.players || []).length,
        players: [{ pid, name: String(names[r.player] ?? '?').slice(0, 12), ai: false, rank: r.rank, points: r.points }],
      },
    });
  }
  return out;
}

// Per-seat record id `${code}-${seed}-${seat}` -> game id `${code}-${seed}`.
const gameOf = (k) => (/^.+-\d+-\d+$/.test(k) ? k.replace(/-\d+$/, '') : k);

/**
 * Aggregate stored matches -> [{ pid, name, games, wins, draws, losses, rate, lastAt }].
 * Rank 1 alone = win, shared rank 1 = draw, otherwise loss. AI seats and games
 * with fewer than two people are ignored. Keys starting with '_' are probes.
 * Shared 1st is read from the record's `top` count; for older per-seat records
 * without it, rank-1 seats of the same game (id `${code}-${seed}-${seat}`) are counted.
 */
export function aggregateStats(matches) {
  const entries = Object.entries(matches || {})
    .filter(([k, m]) => !k.startsWith('_') && m && Array.isArray(m.players) && Number.isFinite(m.at));
  const firsts = new Map(); // game -> rank-1 human seats seen
  for (const [k, m] of entries) {
    const n = m.players.filter((p) => p && p.rank === 1).length;
    firsts.set(gameOf(k), (firsts.get(gameOf(k)) || 0) + n);
  }
  const rows = new Map();
  entries.sort((a, b) => a[1].at - b[1].at);
  for (const [k, m] of entries) {
    const humans = m.players.filter((p) => p && !p.ai && cleanPid(p.pid));
    // Need at least two people in the game (per-seat records carry the count).
    const people = Number.isInteger(m.humans) ? m.humans : humans.length;
    if (people < 2) continue;
    const shared = (Number.isInteger(m.top) ? m.top : firsts.get(gameOf(k)) || 0) > 1;
    for (const p of humans) {
      let r = rows.get(p.pid);
      if (!r) rows.set(p.pid, (r = { pid: p.pid, name: '', games: 0, wins: 0, draws: 0, losses: 0, rate: 0, lastAt: 0 }));
      r.name = p.name || r.name; // latest name wins (list is oldest -> newest)
      r.games += 1;
      if (p.rank !== 1) r.losses += 1;
      else if (shared) r.draws += 1;
      else r.wins += 1;
      r.lastAt = m.at;
    }
  }
  const out = [...rows.values()];
  out.forEach((r) => { r.rate = r.games ? Math.round((r.wins / r.games) * 100) : 0; });
  out.sort((a, b) => b.wins - a.wins || b.rate - a.rate || b.games - a.games);
  return out;
}

/**
 * Duel (1:1) records for every pair of friends, visible to anyone:
 * [{ a: {pid, name}, b: {pid, name}, games, aWins, draws, bWins, lastAt }].
 * A duel is a game with exactly two people and no AI seats (`seats` == 2; older
 * records without `seats` are assumed AI-free). Both seats must be stored.
 * Pairs that include `myPid` come first with me as `a`; others by games played.
 */
export function duelPairs(matches, myPid = '') {
  const games = new Map(); // game id -> { at, people, seats, players: Map(pid -> player) }
  for (const [k, m] of Object.entries(matches || {})) {
    if (k.startsWith('_') || !m || !Array.isArray(m.players) || !Number.isFinite(m.at)) continue;
    const id = gameOf(k);
    let g = games.get(id);
    if (!g) games.set(id, (g = { at: m.at, people: m.humans, seats: m.seats, players: new Map() }));
    g.at = Math.max(g.at, m.at);
    if (Number.isInteger(m.humans)) g.people = m.humans;
    if (Number.isInteger(m.seats)) g.seats = m.seats;
    for (const p of m.players) if (p && !p.ai && cleanPid(p.pid)) g.players.set(p.pid, p);
  }
  const pairs = new Map();
  const list = [...games.values()].sort((x, y) => x.at - y.at);
  for (const g of list) {
    const people = Number.isInteger(g.people) ? g.people : g.players.size;
    if (people !== 2 || (Number.isInteger(g.seats) && g.seats !== 2) || g.players.size !== 2) continue;
    let [p, q] = [...g.players.values()];
    if (q.pid === myPid || (p.pid !== myPid && q.pid < p.pid)) [p, q] = [q, p]; // stable side: me first, else pid order
    const key = `${p.pid}|${q.pid}`;
    let r = pairs.get(key);
    if (!r) pairs.set(key, (r = { a: { pid: p.pid, name: '' }, b: { pid: q.pid, name: '' }, games: 0, aWins: 0, draws: 0, bWins: 0, lastAt: 0 }));
    r.a.name = p.name || r.a.name; // latest names
    r.b.name = q.name || r.b.name;
    r.games += 1;
    if (p.rank === 1 && q.rank === 1) r.draws += 1;
    else if (p.rank === 1) r.aWins += 1;
    else r.bWins += 1;
    r.lastAt = g.at;
  }
  const mine = (r) => (myPid && r.a.pid === myPid ? 1 : 0);
  return [...pairs.values()].sort((x, y) => mine(y) - mine(x) || y.games - x.games || y.lastAt - x.lastAt);
}
