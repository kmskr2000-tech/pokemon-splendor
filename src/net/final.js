// Final tournament (the event's last stage). Pure: everything is derived from
// the stored match records, the leader's pick and the clock, so every client
// shows the same bracket without any server logic.
//
// - League (event standings, frozen at EVENT.end) seeds the top FINAL.slots.
// - Semifinals: seed 1 vs the opponent seed 1 picked (seed 4 if no pick by
//   FINAL.pickBy); the other two meet. Seed 1 starts its semifinal 1-0.
// - Sets are 1:1 games played in a dedicated room whose code starts with
//   a marker prefix (see finalRoomPrefix), so they are told apart from casual
//   games using only the record id — no extra stored fields.
// - Shared first place is void (replay). Matches unfinished at FINAL.end go to
//   the higher league seed.
// - Overall winner: league points + tournament points (ties: tournament place).

import { EVENT, FINAL, eventStandings, leaguePoints, cleanPid } from './stats.js?v=1795744992';

export const MATCH_KEYS = ['S1', 'S2', 'T3', 'F1'];
export const MATCH_LABEL = { S1: '4강 1경기', S2: '4강 2경기', T3: '3·4위전', F1: '결승' };
const TARGET = { S1: 2, S2: 2, T3: 2, F1: 3 }; // set wins needed

// Room code prefixes. Normal codes never contain the letter O, and the join
// screen only accepts A-Z and 2-9, so the marker is 'O' + two letters.
const PREFIX = { S1: 'OSA', S2: 'OSB', T3: 'OTT', F1: 'OFF' };
const KEY_OF_PREFIX = Object.fromEntries(Object.entries(PREFIX).map(([k, v]) => [v, k]));
/** Room code prefix of a tournament match. */
export const finalRoomPrefix = (key) => PREFIX[key] || '';
/** Match key of a room code / record id, or '' for a normal room. */
export const finalKeyOf = (code) => KEY_OF_PREFIX[String(code || '').slice(0, 3)] || '';

// Record id `${code}-${seed}-${seat}` -> game id `${code}-${seed}`.
const gameOf = (k) => (/^.+-\d+-\d+$/.test(k) ? k.replace(/-\d+$/, '') : k);

/** Decided tournament sets per match key: { S1: [{ at, winner, loser }], ... } (oldest first). */
export function finalSets(matches, ev = EVENT, fin = FINAL) {
  const games = new Map(); // game id -> { key, at, players: Map(pid -> rank), top, humans, seats }
  for (const [k, m] of Object.entries(matches || {})) {
    const key = finalKeyOf(k);
    if (!key || !m || !Array.isArray(m.players) || !Number.isFinite(m.at)) continue;
    if (m.at < ev.end || m.at >= fin.end) continue;
    const id = gameOf(k);
    let g = games.get(id);
    if (!g) games.set(id, (g = { key, at: m.at, players: new Map(), top: 1, humans: 2, seats: 2 }));
    g.at = Math.min(g.at, m.at);
    if (Number.isInteger(m.top)) g.top = m.top;
    if (Number.isInteger(m.humans)) g.humans = m.humans;
    if (Number.isInteger(m.seats)) g.seats = m.seats;
    for (const p of m.players) if (p && !p.ai && cleanPid(p.pid)) g.players.set(p.pid, p.rank);
  }
  const out = Object.fromEntries(MATCH_KEYS.map((k) => [k, []]));
  for (const g of [...games.values()].sort((a, b) => a.at - b.at)) {
    if (g.humans !== 2 || g.seats !== 2 || g.top > 1) continue; // 1:1 without AI, no shared first
    out[g.key].push({ at: g.at, ranks: g.players });
  }
  return out;
}

// Score a match between a and b from its sets. A set counts when one of the
// two won it (rank 1) or the stored record shows one of them lost.
function scoreMatch(key, a, b, sets, headStart = 0) {
  const need = TARGET[key];
  let sa = headStart;
  let sb = 0;
  for (const s of sets) {
    if (sa >= need || sb >= need) break;
    const ra = s.ranks.get(a.pid);
    const rb = s.ranks.get(b.pid);
    if (ra === undefined && rb === undefined) continue; // someone else's game
    if ([...s.ranks.keys()].some((pid) => pid !== a.pid && pid !== b.pid)) continue;
    if (ra === 1 || (ra === undefined && rb !== undefined && rb !== 1)) sa += 1;
    else if (rb === 1 || (rb === undefined && ra !== undefined && ra !== 1)) sb += 1;
  }
  const winner = sa >= need ? a : sb >= need ? b : null;
  return { key, label: MATCH_LABEL[key], a, b, sa, sb, need, headStart, winner, loser: winner ? (winner === a ? b : a) : null, forfeit: false };
}

/**
 * Whole tournament state.
 * pick: { pid } written by the league winner (or null).
 * -> { phase: 'league'|'none'|'pick'|'semis'|'finals'|'done', seeds, reserve, pick, autoPick,
 *      matches: { S1, S2, T3, F1 }, table: [{ pid, name, seed, lp, tp, total, place }], champion }
 */
export function finalState(matches, pick = null, now = Date.now(), ev = EVENT, fin = FINAL) {
  const rows = leaguePoints(eventStandings(matches, ev), fin);
  const seeds = rows.slice(0, fin.slots).map((r) => ({ pid: r.pid, name: r.name, seed: r.seed, lp: r.lp, wins: r.wins }));
  const reserve = rows[fin.slots] ? { pid: rows[fin.slots].pid, name: rows[fin.slots].name, seed: fin.slots + 1 } : null;
  const base = { phase: 'league', seeds, reserve, pick: null, autoPick: false, matches: {}, table: [], champion: null };
  if (now < ev.end) return base;
  if (seeds.length < fin.slots) return { ...base, phase: 'none' };

  // Leader's pick: one of seeds 2..N; default = lowest seed once the deadline passes.
  let opp = pick && seeds.slice(1).find((s) => s.pid === pick.pid);
  let autoPick = false;
  if (!opp && now >= fin.pickBy) { opp = seeds[seeds.length - 1]; autoPick = true; }
  if (!opp) return { ...base, phase: 'pick' };

  const over = now >= fin.end;
  const sets = finalSets(matches, ev, fin);
  const forfeit = (m) => { // unfinished at the deadline: the higher league seed advances
    if (m.winner || !over) return m;
    const w = m.a.seed < m.b.seed ? m.a : m.b;
    return { ...m, winner: w, loser: w === m.a ? m.b : m.a, forfeit: true };
  };
  const rest = seeds.slice(1).filter((s) => s !== opp);
  const S1 = forfeit(scoreMatch('S1', seeds[0], opp, sets.S1, 1));
  const S2 = forfeit(scoreMatch('S2', rest[0], rest[1], sets.S2));
  const out = { S1, S2, T3: null, F1: null };
  let phase = 'semis';
  if (S1.winner && S2.winner) {
    const hi = (x, y) => (x.seed < y.seed ? [x, y] : [y, x]);
    out.F1 = forfeit(scoreMatch('F1', ...hi(S1.winner, S2.winner), sets.F1));
    out.T3 = forfeit(scoreMatch('T3', ...hi(S1.loser, S2.loser), sets.T3));
    phase = out.F1.winner && out.T3.winner ? 'done' : 'finals';
  }
  // Tournament points by final place; players still in play have none yet.
  const place = new Map();
  if (out.F1 && out.F1.winner) { place.set(out.F1.winner.pid, 1); place.set(out.F1.loser.pid, 2); }
  if (out.T3 && out.T3.winner) { place.set(out.T3.winner.pid, 3); place.set(out.T3.loser.pid, 4); }
  const table = seeds.map((s) => {
    const pl = place.get(s.pid) || 0;
    const tp = pl ? fin.points[pl - 1] : 0;
    return { ...s, place: pl, tp, total: s.lp + tp };
  }).sort((x, y) => y.total - x.total || (x.place || 9) - (y.place || 9) || x.seed - y.seed);
  return { phase, seeds, reserve, pick: opp, autoPick, matches: out, table, champion: phase === 'done' ? table[0] : null };
}

/** The match this player has to play right now (undecided, both players known), or null. */
export function myOpenMatch(state, pid) {
  if (!state || !pid) return null;
  for (const key of MATCH_KEYS) {
    const m = state.matches[key];
    if (m && !m.winner && (m.a.pid === pid || m.b.pid === pid)) return m;
  }
  return null;
}
