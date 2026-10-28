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
  const out = [];
  for (const r of game.ranking || []) {
    if (r.player >= humans) continue; // base AI seat
    if (onlySeat !== null && r.player !== onlySeat) continue;
    const pid = cleanPid(pids[r.player]);
    if (!pid) continue; // unknown device (old client): can't attribute
    out.push({
      id: `${code || 'X'}-${seed >>> 0}-${r.player}`,
      rec: {
        at: now, code: code || '', humans,
        players: [{ pid, name: String(names[r.player] ?? '?').slice(0, 12), ai: false, rank: r.rank, points: r.points }],
      },
    });
  }
  return out;
}

/**
 * Aggregate stored matches -> [{ pid, name, games, wins, losses, rate, lastAt }].
 * A win is rank 1; AI seats and games with fewer than two people are ignored. Keys starting
 * with '_' are probes/test rows and are skipped.
 */
export function aggregateStats(matches) {
  const rows = new Map();
  const list = Object.entries(matches || {})
    .filter(([k, m]) => !k.startsWith('_') && m && Array.isArray(m.players) && Number.isFinite(m.at))
    .map(([, m]) => m)
    .sort((a, b) => a.at - b.at);
  for (const m of list) {
    const humans = m.players.filter((p) => p && !p.ai && cleanPid(p.pid));
    // Need at least two people in the game (per-seat records carry the count).
    const people = Number.isInteger(m.humans) ? m.humans : humans.length;
    if (people < 2) continue;
    for (const p of humans) {
      let r = rows.get(p.pid);
      if (!r) rows.set(p.pid, (r = { pid: p.pid, name: '', games: 0, wins: 0, losses: 0, rate: 0, lastAt: 0 }));
      r.name = p.name || r.name; // latest name wins (list is oldest -> newest)
      r.games += 1;
      if (p.rank === 1) r.wins += 1; else r.losses += 1;
      r.lastAt = m.at;
    }
  }
  const out = [...rows.values()];
  out.forEach((r) => { r.rate = r.games ? Math.round((r.wins / r.games) * 100) : 0; });
  out.sort((a, b) => b.wins - a.wins || b.rate - a.rate || b.games - a.games);
  return out;
}
