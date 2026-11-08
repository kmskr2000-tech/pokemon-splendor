// Pure settlement math for paid rooms. Shared by the client (previews) and the
// Cloud Function that moves real balances (functions/settle.js is a verbatim copy;
// keep both files identical).
//
// Money is integer KRW. Every rounding remainder goes to the operator fee so the
// books always balance: payouts + fee == pot (+ pool).
//
// Winners are the SEATED human players with the best final rank (AI seats never
// win money; an entry-fee room only starts once every seat has paid). Ties share
// the prize equally.
// Bets are parimutuel: the whole bet pool, minus the fee, is split among the
// bets placed on any winner, in proportion to the amount bet. If nobody bet on
// a winner, every bet is refunded in full and no fee is taken on bets.

/** Clamp a fee rate into [0, 0.5]; anything invalid falls back to 10%. */
export function cleanFeeRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n < 0) return 0.1;
  return Math.min(0.5, n);
}

/**
 * @param {Object} escrow  { entryFee, feeRate, players: {uid: {amount}}, bets: {id: {uid, target, amount}} }
 * @param {Array}  ranking [{ uid, rank }] for every human seat (uid may be '' for unknown seats)
 * @returns {{ winners: string[], prizePot, prizeFee, prizePayouts: {uid: amt}, betPool, betFee, betPayouts: {uid: amt}, betRefund: boolean, fee, payouts: {uid: amt} }}
 */
export function settleRoom(escrow, ranking) {
  const feeRate = cleanFeeRate(escrow && escrow.feeRate);
  const players = (escrow && escrow.players) || {};
  const bets = (escrow && escrow.bets) || {};
  const paid = Object.keys(players).filter((uid) => Number(players[uid].amount) > 0);
  // Seated humans: locked in by startRoom (`seats`); older/free escrows fall back to the paid list.
  const seated = escrow && escrow.seats ? Object.keys(escrow.seats) : paid;

  // ---- winners: best rank among seated players ----
  const rankOf = {};
  for (const r of ranking || []) if (r && r.uid) rankOf[r.uid] = Number(r.rank);
  let best = Infinity;
  for (const uid of seated) {
    const rk = rankOf[uid];
    if (Number.isFinite(rk) && rk < best) best = rk;
  }
  const winners = Number.isFinite(best) ? seated.filter((uid) => rankOf[uid] === best) : [];

  // ---- entry fees ----
  let prizePot = 0;
  for (const uid of paid) prizePot += Math.max(0, Math.floor(Number(players[uid].amount) || 0));
  const prizePayouts = {};
  let prizeFee = 0;
  if (prizePot > 0) {
    if (winners.length === 0) {
      // No ranked paid player (should not happen): refund everyone, no fee.
      for (const uid of paid) prizePayouts[uid] = Math.floor(Number(players[uid].amount) || 0);
    } else {
      prizeFee = Math.floor(prizePot * feeRate);
      const share = Math.floor((prizePot - prizeFee) / winners.length);
      for (const uid of winners) prizePayouts[uid] = share;
      prizeFee = prizePot - share * winners.length; // remainder -> fee
    }
  }

  // ---- bets (parimutuel) ----
  let betPool = 0;
  let onWinners = 0;
  const betList = Object.values(bets).filter((b) => b && b.uid && Number(b.amount) > 0);
  for (const b of betList) {
    const amt = Math.floor(Number(b.amount));
    betPool += amt;
    if (winners.includes(b.target)) onWinners += amt;
  }
  const betPayouts = {};
  let betFee = 0;
  let betRefund = false;
  if (betPool > 0) {
    if (onWinners === 0) {
      betRefund = true;
      for (const b of betList) betPayouts[b.uid] = (betPayouts[b.uid] || 0) + Math.floor(Number(b.amount));
    } else {
      betFee = Math.floor(betPool * feeRate);
      const distributable = betPool - betFee;
      let given = 0;
      for (const b of betList) {
        if (!winners.includes(b.target)) continue;
        const amt = Math.floor(Number(b.amount));
        const win = Math.floor((distributable * amt) / onWinners);
        betPayouts[b.uid] = (betPayouts[b.uid] || 0) + win;
        given += win;
      }
      betFee = betPool - given; // remainder -> fee
    }
  }

  const payouts = {};
  for (const [uid, v] of Object.entries(prizePayouts)) payouts[uid] = (payouts[uid] || 0) + v;
  for (const [uid, v] of Object.entries(betPayouts)) payouts[uid] = (payouts[uid] || 0) + v;
  return { winners, prizePot, prizeFee, prizePayouts, betPool, betFee, betPayouts, betRefund, fee: prizeFee + betFee, payouts };
}

/** Per-target bet totals and the implied payout per 1,000 won (preview for bettors). */
export function betOdds(escrow) {
  const feeRate = cleanFeeRate(escrow && escrow.feeRate);
  const bets = (escrow && escrow.bets) || {};
  const totals = {};
  let pool = 0;
  for (const b of Object.values(bets)) {
    if (!b || !b.target || !(Number(b.amount) > 0)) continue;
    const amt = Math.floor(Number(b.amount));
    totals[b.target] = (totals[b.target] || 0) + amt;
    pool += amt;
  }
  const per1000 = {};
  for (const [t, amt] of Object.entries(totals)) {
    per1000[t] = amt > 0 ? Math.floor(((pool - Math.floor(pool * feeRate)) * 1000) / amt) : 0;
  }
  return { totals, pool, per1000 };
}

/** Canonical string of a ranking so independent clients can be compared byte-for-byte. */
export function rankingKey(ranking) {
  return (ranking || [])
    .filter((r) => r && r.uid)
    .map((r) => `${r.uid}:${Number(r.rank)}`)
    .sort()
    .join('|');
}
