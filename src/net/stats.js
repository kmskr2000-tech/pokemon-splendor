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

// ---------- multiplayer event (most wins inside a time window) ----------

// Event: wins added after the stats snapshot (baseline below, taken 11/23)
// until `end` (UTC ms). Matches recorded at or after `end` don't count.
// Baseline rows are matched to players by any name they have used, so a
// rename after the snapshot still keeps the baseline.
export const EVENT = {
  title: '최다승 이벤트',
  start: Date.UTC(2026, 10, 23, 5, 35, 0), // snapshot, 2026-11-23 14:35 KST (emote gate only)
  end: Date.UTC(2026, 11, 3, 0, 0, 0), // 2026-12-03 09:00 KST (extended one week from 11/26)
  // Second-round patch: event wins earned before `halveAt` count half.
  halveAt: Date.UTC(2026, 10, 26, 0, 45, 0), // 2026-11-26 09:45 KST
  startLabel: '11/23 전적 스냅샷',
  endLabel: '12/3(목) 오전 9시',
  // Friend stats snapshot: wins, games (= wins + draws + losses).
  baseline: [
    { name: '임실장', wins: 231, games: 502 },
    { name: '드럼통 살인마', wins: 190, games: 356 },
    { name: '강재워니', wins: 124, games: 238 },
    { name: '사무관최고참', wins: 116, games: 277 },
    { name: '엠팡의 입', wins: 1, games: 13 },
  ],
};

/** Is the event running at `now`? */
export const isEventActive = (now = Date.now(), ev = EVENT) => now >= ev.start && now < ev.end;

/**
 * Event standings: wins added since the snapshot (current wins minus baseline),
 * ranked by added wins (ties share a rank). Only players with at least one game
 * after the snapshot are listed. -> [{ ...aggregateStats row, wins, games, rank }]
 */
export function eventStandings(matches, ev = EVENT) {
  if (!ev.halveAt) return addedWins(matches, ev);
  // Wins added before halveAt count half; later wins count in full. Games stay whole.
  const pre = new Map(addedWins(matches, { ...ev, end: Math.min(ev.halveAt, ev.end) }).map((r) => [r.pid, r]));
  const rows = addedWins(matches, ev).map((r) => {
    const p = pre.get(r.pid);
    const preWins = p ? p.wins : 0;
    return { ...r, wins: preWins / 2 + (r.wins - preWins), preWins };
  });
  rows.sort((a, b) => b.wins - a.wins || a.games - b.games || b.lastAt - a.lastAt);
  rows.forEach((r) => { r.rank = 1 + rows.filter((o) => o.wins > r.wins).length; });
  return rows;
}

/** Wins and games added since the snapshot baseline, for matches before ev.end. */
function addedWins(matches, ev) {
  const inWin = {};
  const names = new Map(); // pid -> every name used
  for (const [k, m] of Object.entries(matches || {})) {
    if (!m || !Number.isFinite(m.at) || m.at >= ev.end) continue;
    inWin[k] = m;
    for (const p of Array.isArray(m.players) ? m.players : []) {
      if (!p || !cleanPid(p.pid)) continue;
      if (!names.has(p.pid)) names.set(p.pid, new Set());
      names.get(p.pid).add(p.name);
    }
  }
  const all = aggregateStats(inWin);
  // Each baseline row goes to one player: same current name first, else the
  // player with the most wins among those who ever used that name.
  const base = new Map(); // pid -> baseline
  for (const b of ev.baseline || []) {
    const cands = all.filter((r) => !base.has(r.pid) && (r.name === b.name || names.get(r.pid)?.has(b.name)));
    cands.sort((x, y) => (y.name === b.name) - (x.name === b.name) || y.wins - x.wins);
    if (cands[0]) base.set(cands[0].pid, b);
  }
  const rows = all.map((r) => {
    const b = base.get(r.pid) || { wins: 0, games: 0 };
    return { ...r, wins: Math.max(0, r.wins - b.wins), games: Math.max(0, r.games - b.games) };
  }).filter((r) => r.games > 0);
  rows.sort((a, b) => b.wins - a.wins || a.games - b.games || b.lastAt - a.lastAt);
  rows.forEach((r) => { r.rank = 1 + rows.filter((o) => o.wins > r.wins).length; });
  return rows;
}

/** Current event leaders (pids): rank 1 with at least one win. Ties all lead. */
export function eventLeaders(rows) {
  return new Set((rows || []).filter((r) => r.rank === 1 && r.wins > 0).map((r) => r.pid));
}

/** "12일 3시간 4분 5초" style remaining time (Korean), or '종료' when <= 0. */
export function formatRemain(ms) {
  if (!(ms > 0)) return '종료';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d ? `${d}일 ` : ''}${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// ---------- final tournament (after the league) ----------

// League points + 1:1 tournament points decide the overall winner.
export const FINAL = {
  title: '파이널 토너먼트',
  slots: 4, // league top N advance (next one is the reserve)
  leagueMax: 10, // league points of the league winner
  pickBy: Date.UTC(2026, 11, 3, 3, 0, 0), // 2026-12-03 12:00 KST: leader picks a semifinal opponent
  end: Date.UTC(2026, 11, 3, 15, 0, 0), // 2026-12-03 24:00 KST: unplayed matches are forfeited
  points: [10, 6, 3, 0], // champion, runner-up, 3rd, 4th
  dayLabel: '12/3(목)',
};

/**
 * League points for event standings rows: leagueMax x wins / leader's wins,
 * rounded to 0.5. Adds `lp` and `seed` (1-based league order) to each row.
 */
export function leaguePoints(rows, fin = FINAL) {
  const top = Math.max(0, ...(rows || []).map((r) => r.wins));
  return (rows || []).map((r, i) => ({
    ...r,
    seed: i + 1,
    lp: top > 0 ? Math.round((fin.leagueMax * r.wins / top) * 2) / 2 : 0,
  }));
}
