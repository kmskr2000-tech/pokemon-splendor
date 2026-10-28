// Friend match stats (multiplayer). Pure helpers: build a match record from a
// finished game, and aggregate stored records into per-player win/loss rows.
// Players are keyed by a per-device id (pid), so renaming keeps the history.

const PID_RE = /^[A-Za-z0-9]{6,24}$/;

export const cleanPid = (p) => (typeof p === 'string' && PID_RE.test(p) ? p : '');

/** Host-side: one record for a finished multiplayer game. */
export function buildMatch(game, names, pids, code, seed, now = Date.now()) {
  const ranking = game.ranking || [];
  const players = ranking.map((r) => {
    const pid = cleanPid(pids[r.player]);
    return {
      pid: pid || null,
      name: String(names[r.player] ?? game.players[r.player]?.name ?? '?').slice(0, 12),
      ai: !pid,
      rank: r.rank,
      points: r.points,
    };
  });
  return { id: `${code || 'X'}-${seed >>> 0}`, rec: { at: now, code: code || '', players } };
}

/**
 * Aggregate stored matches -> [{ pid, name, games, wins, losses, rate, lastAt }].
 * A win is rank 1 among the game's players; AI seats are ignored. Keys starting
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
    if (humans.length < 2) continue; // need at least two friends for a real match
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
