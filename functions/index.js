// Cloud Functions: the only code allowed to move wallet money.
//
// Every balance change is an RTDB transaction on users/{uid}/balance plus an
// append-only ledger row. Clients never write these paths (see
// firebase/database.rules.json); they call these functions instead.
//
// Deploy: `firebase deploy --only functions,database` from the repo root.
// Admins: set `pkmspl-wallet/config/admins/<uid>: true` in the Firebase console
// once (that node is not writable by any client or function).

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { settleRoom, rankingKey, cleanFeeRate } from './settle.js';

setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 });
initializeApp();

const WALLET = 'pkmspl-wallet';
const ESCROW = 'pkmspl-escrow';
const ROOMS = 'pkmspl-rooms';
const CODE_RE = /^[A-Z2-9]{4,8}$/;
const MAX_FEE = 1_000_000;
const MIN_BET = 100;

const db = () => getDatabase();
const now = () => Date.now();
const fail = (code, msg) => new HttpsError(code, msg);
const int = (v) => Math.floor(Number(v) || 0);

async function readConfig() {
  const snap = await db().ref(`${WALLET}/config`).once('value');
  const c = snap.val() || {};
  return {
    admins: c.admins || {},
    feeRate: cleanFeeRate(c.feeRate),
    betGraceMs: Number.isInteger(c.betGraceMs) ? c.betGraceMs : 90_000,
    minDeposit: Number.isInteger(c.minDeposit) ? c.minDeposit : 1000,
    maxBet: Number.isInteger(c.maxBet) ? c.maxBet : 100_000,
    enabled: c.enabled !== false,
  };
}

function uidOf(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw fail('unauthenticated', '로그인이 필요해요.');
  return uid;
}

async function requireAdmin(uid) {
  const cfg = await readConfig();
  if (cfg.admins[uid] !== true) throw fail('permission-denied', '운영자만 할 수 있어요.');
  return cfg;
}

function codeOf(data) {
  const code = String((data && data.code) || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw fail('invalid-argument', '방 코드가 올바르지 않아요.');
  return code;
}

/**
 * Atomically change a user's balance. Rejects (throws) when the result would
 * go negative. Writes a ledger row after the balance commits.
 */
async function adjustBalance(uid, delta, type, ref = '', memo = '') {
  const balRef = db().ref(`${WALLET}/users/${uid}/balance`);
  let after = 0;
  const res = await balRef.transaction((cur) => {
    const bal = int(cur);
    const next = bal + delta;
    if (next < 0) return; // abort
    after = next;
    return next;
  });
  if (!res.committed) throw fail('failed-precondition', '잔액이 부족해요.');
  await db().ref(`${WALLET}/users/${uid}/updatedAt`).set(now());
  await db().ref(`${WALLET}/ledger/${uid}`).push({ type, amount: delta, balanceAfter: after, ref, memo, at: now() });
  return after;
}

async function ensureUserRow(uid, req) {
  const t = (req.auth && req.auth.token) || {};
  const ref = db().ref(`${WALLET}/users/${uid}`);
  const snap = await ref.once('value');
  const cur = snap.val() || {};
  const patch = {};
  if (t.name && t.name !== cur.name) patch.name = String(t.name).slice(0, 40);
  if (t.email && t.email !== cur.email) patch.email = String(t.email).slice(0, 80);
  if (!snap.exists()) patch.balance = 0;
  if (Object.keys(patch).length) await ref.update(patch);
}

async function addFee(code, amount, kind) {
  if (!(amount > 0)) return;
  await db().ref(`${WALLET}/fees`).push({ code, amount, kind, at: now() });
  await db().ref(`${WALLET}/feeTotal`).transaction((cur) => int(cur) + amount);
}

// ---------- room escrow ----------

export const createEscrow = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const entryFee = int(req.data.entryFee);
  if (entryFee < 0 || entryFee > MAX_FEE) throw fail('invalid-argument', '참가비 금액이 올바르지 않아요.');
  const cfg = await readConfig();
  if (!cfg.enabled) throw fail('failed-precondition', '지갑 기능이 잠시 중단됐어요.');
  const room = await db().ref(`${ROOMS}/${code}`).once('value');
  if (!room.exists()) throw fail('not-found', '방을 찾을 수 없어요.');
  await ensureUserRow(uid, req);
  const ref = db().ref(`${ESCROW}/${code}`);
  const res = await ref.transaction((cur) => {
    if (cur) return; // already exists (stale code reuse): abort
    return {
      hostUid: uid, hostName: String(req.data.name || '').slice(0, 12), entryFee, feeRate: cfg.feeRate,
      status: 'open', createdAt: now(),
    };
  });
  if (!res.committed) {
    // Codes are random; a leftover escrow from a dead room with the same code is
    // extremely unlikely, but never silently reuse someone else's money.
    throw fail('already-exists', '같은 코드의 정산 기록이 남아 있어요. 방을 다시 만들어주세요.');
  }
  return { ok: true, entryFee, feeRate: cfg.feeRate };
});

export const payEntry = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const ref = db().ref(`${ESCROW}/${code}`);
  const snap = await ref.once('value');
  const e = snap.val();
  if (!e) throw fail('not-found', '이 방은 참가비 정산이 설정되지 않았어요.');
  if (e.status !== 'open') throw fail('failed-precondition', '이미 시작됐거나 닫힌 방이에요.');
  const fee = int(e.entryFee);
  if (fee <= 0) return { ok: true, paid: 0 };
  // Claim the seat first (prevents double-pay races), then debit.
  const claim = await ref.child(`players/${uid}`).transaction((cur) => {
    if (cur && int(cur.amount) >= fee) return; // already paid
    return { name: String(req.data.name || '').slice(0, 12), amount: 0, at: now() };
  });
  if (!claim.committed) return { ok: true, paid: fee, already: true };
  await ensureUserRow(uid, req);
  try {
    await adjustBalance(uid, -fee, 'entry', code);
  } catch (err) {
    await ref.child(`players/${uid}`).remove();
    throw err;
  }
  await ref.child(`players/${uid}`).update({ amount: fee, paidAt: now() });
  return { ok: true, paid: fee };
});

export const placeBet = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const target = String(req.data.target || '').slice(0, 64);
  const amount = int(req.data.amount);
  const cfg = await readConfig();
  if (!target) throw fail('invalid-argument', '베팅 대상을 골라주세요.');
  if (target === uid) throw fail('invalid-argument', '자기 자신에게는 베팅할 수 없어요.');
  if (amount < MIN_BET || amount > cfg.maxBet) throw fail('invalid-argument', `베팅은 ${MIN_BET}원 이상 ${cfg.maxBet.toLocaleString('ko-KR')}원 이하로 할 수 있어요.`);
  const ref = db().ref(`${ESCROW}/${code}`);
  const e = (await ref.once('value')).val();
  if (!e) throw fail('not-found', '이 방은 베팅이 열려 있지 않아요.');
  if (e.status !== 'open' && e.status !== 'started') throw fail('failed-precondition', '베팅이 마감된 방이에요.');
  if (e.status === 'started' && !(now() < int(e.betCloseAt))) throw fail('failed-precondition', '베팅이 마감됐어요.');
  if (e.players && e.players[uid]) throw fail('failed-precondition', '참가자는 베팅할 수 없어요.');
  if (e.seats && e.seats[uid]) throw fail('failed-precondition', '참가자는 베팅할 수 없어요.');
  if (e.seats && !e.seats[target]) throw fail('invalid-argument', '이 방의 참가자가 아니에요.');
  await ensureUserRow(uid, req);
  await adjustBalance(uid, -amount, 'bet', code);
  const bet = ref.child('bets').push();
  await bet.set({ uid, target, amount, at: now() });
  return { ok: true, id: bet.key };
});

/** Refund every player entry and every bet of an escrow (idempotent per row). */
async function refundAll(code, e, reasonPlayers = 'entry_refund', reasonBets = 'bet_refund', only = null) {
  const ref = db().ref(`${ESCROW}/${code}`);
  for (const [uid, p] of Object.entries(e.players || {})) {
    if (only && !only.players.has(uid)) continue;
    const amt = int(p && p.amount);
    if (amt > 0) await adjustBalance(uid, amt, reasonPlayers, code);
    await ref.child(`players/${uid}`).remove();
  }
  for (const [id, b] of Object.entries(e.bets || {})) {
    if (only && !only.bets.has(id)) continue;
    const amt = int(b && b.amount);
    if (amt > 0 && b.uid) await adjustBalance(b.uid, amt, reasonBets, code);
    await ref.child(`bets/${id}`).remove();
  }
}

export const startRoom = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const playerUids = Array.isArray(req.data.playerUids) ? req.data.playerUids.map((u) => String(u || '').slice(0, 64)) : [];
  const ref = db().ref(`${ESCROW}/${code}`);
  const e = (await ref.once('value')).val();
  if (!e) throw fail('not-found', '정산 기록이 없는 방이에요.');
  if (e.hostUid !== uid) throw fail('permission-denied', '방장만 시작할 수 있어요.');
  if (e.status !== 'open') throw fail('failed-precondition', '이미 시작된 방이에요.');
  const seated = new Set(playerUids.filter(Boolean));
  const fee = int(e.entryFee);
  if (fee > 0) {
    // Every seated human (host included) must have paid.
    for (const u of playerUids) {
      if (!u) throw fail('failed-precondition', '로그인하지 않은 참가자가 있어요. 참가비 방은 전원 로그인이 필요해요.');
      if (!(e.players && e.players[u] && int(e.players[u].amount) >= fee)) throw fail('failed-precondition', '참가비를 내지 않은 참가자가 있어요.');
    }
  }
  // Players who paid but left the lobby, and bets on people no longer seated: refund.
  const stalePlayers = new Set(Object.keys(e.players || {}).filter((u) => !seated.has(u)));
  const staleBets = new Set(Object.entries(e.bets || {}).filter(([, b]) => !seated.has(b && b.target)).map(([id]) => id));
  if (stalePlayers.size || staleBets.size) await refundAll(code, e, 'entry_refund', 'bet_refund', { players: stalePlayers, bets: staleBets });
  const cfg = await readConfig();
  const seats = {};
  for (const u of seated) seats[u] = true;
  await ref.update({ status: 'started', startedAt: now(), betCloseAt: now() + cfg.betGraceMs, seats });
  return { ok: true, betCloseAt: now() + cfg.betGraceMs };
});

export const cancelRoom = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const ref = db().ref(`${ESCROW}/${code}`);
  const e = (await ref.once('value')).val();
  if (!e) return { ok: true };
  const cfg = await readConfig();
  if (e.hostUid !== uid && cfg.admins[uid] !== true) throw fail('permission-denied', '방장만 취소할 수 있어요.');
  if (e.status !== 'open') throw fail('failed-precondition', '시작된 방은 운영자만 취소할 수 있어요.');
  await ref.child('status').set('cancelling');
  await refundAll(code, e);
  await ref.update({ status: 'cancelled', cancelledAt: now() });
  return { ok: true };
});

function cleanRanking(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.uid === 'string' && Number.isInteger(Number(r.rank)))
    .map((r) => ({ uid: r.uid.slice(0, 64), rank: Number(r.rank) }));
}

/** Pay out a started escrow according to `ranking`. Idempotent via status gate. */
async function settle(code, e, ranking, settledBy) {
  const ref = db().ref(`${ESCROW}/${code}`);
  const gate = await ref.child('status').transaction((cur) => (cur === 'started' || cur === 'disputed' ? 'settling' : undefined));
  if (!gate.committed) throw fail('failed-precondition', '이미 정산됐거나 정산 중이에요.');
  const result = settleRoom(e, ranking);
  const paid = {};
  for (const [uid, amt] of Object.entries(result.prizePayouts)) {
    if (amt > 0) { await adjustBalance(uid, amt, result.winners.length ? 'prize' : 'entry_refund', code); paid[uid] = (paid[uid] || 0) + amt; }
  }
  for (const [uid, amt] of Object.entries(result.betPayouts)) {
    if (amt > 0) { await adjustBalance(uid, amt, result.betRefund ? 'bet_refund' : 'bet_win', code); paid[uid] = (paid[uid] || 0) + amt; }
  }
  await addFee(code, result.prizeFee, 'entry');
  await addFee(code, result.betFee, 'bet');
  await ref.update({
    status: 'settled',
    settlement: { ...result, ranking, settledBy, at: now() },
  });
  return result;
}

export const reportResult = onCall(async (req) => {
  const uid = uidOf(req);
  const code = codeOf(req.data);
  const ranking = cleanRanking(req.data.ranking);
  if (!ranking.length) throw fail('invalid-argument', '결과가 비어 있어요.');
  const ref = db().ref(`${ESCROW}/${code}`);
  const e = (await ref.once('value')).val();
  if (!e) throw fail('not-found', '정산 기록이 없는 방이에요.');
  if (e.status === 'settled') return { ok: true, status: 'settled' };
  if (e.status !== 'started') throw fail('failed-precondition', '정산할 수 있는 상태가 아니에요.');
  const seats = e.seats || {};
  if (uid !== e.hostUid && !seats[uid]) throw fail('permission-denied', '참가자만 결과를 보고할 수 있어요.');
  const key = rankingKey(ranking);
  await ref.child(`results/${uid}`).set({ key, ranking, at: now() });
  // Quorum: the host plus a strict majority of seated players, all agreeing.
  const results = { ...(e.results || {}), [uid]: { key, ranking } };
  const voters = Object.keys(seats).length ? Object.keys(seats) : [e.hostUid];
  const votes = voters.filter((u) => results[u]);
  const keys = new Set(votes.map((u) => results[u].key));
  if (keys.size > 1) {
    await ref.child('status').set('disputed');
    return { ok: true, status: 'disputed' };
  }
  const need = Math.floor(voters.length / 2) + 1;
  if (votes.length < need) return { ok: true, status: 'waiting', votes: votes.length, need };
  const agreed = results[votes[0]].ranking;
  const fresh = (await ref.once('value')).val();
  const res = await settle(code, fresh, agreed, 'quorum');
  return { ok: true, status: 'settled', payouts: res.payouts };
});

// ---------- deposits / withdrawals ----------

export const requestWithdraw = onCall(async (req) => {
  const uid = uidOf(req);
  const amount = int(req.data.amount);
  const bank = String(req.data.bank || '').slice(0, 60);
  if (amount < 1000) throw fail('invalid-argument', '출금은 1,000원부터 가능해요.');
  if (!bank) throw fail('invalid-argument', '받을 계좌를 적어주세요.');
  await ensureUserRow(uid, req);
  const t = (req.auth && req.auth.token) || {};
  const row = db().ref(`${WALLET}/withdrawals`).push();
  await adjustBalance(uid, -amount, 'withdraw', row.key);
  await row.set({ uid, name: t.name || '', email: t.email || '', amount, bank, status: 'pending', at: now() });
  return { ok: true, id: row.key };
});

export const decideDeposit = onCall(async (req) => {
  const admin = uidOf(req);
  await requireAdmin(admin);
  const id = String(req.data.id || '');
  const approve = !!req.data.approve;
  const ref = db().ref(`${WALLET}/deposits/${id}`);
  let row = null;
  const res = await ref.transaction((cur) => {
    if (!cur || cur.status !== 'pending') return;
    row = cur;
    return { ...cur, status: approve ? 'approved' : 'rejected', decidedAt: now(), decidedBy: admin, memo: String(req.data.memo || '').slice(0, 100) };
  });
  if (!res.committed || !row) throw fail('failed-precondition', '이미 처리된 요청이에요.');
  if (approve) {
    const amt = int(row.amount);
    if (amt <= 0) throw fail('invalid-argument', '금액이 올바르지 않아요.');
    await db().ref(`${WALLET}/users/${row.uid}`).update({ name: row.name || '', email: row.email || '' });
    await adjustBalance(row.uid, amt, 'deposit', id);
  }
  return { ok: true };
});

export const decideWithdraw = onCall(async (req) => {
  const admin = uidOf(req);
  await requireAdmin(admin);
  const id = String(req.data.id || '');
  const approve = !!req.data.approve;
  const ref = db().ref(`${WALLET}/withdrawals/${id}`);
  let row = null;
  const res = await ref.transaction((cur) => {
    if (!cur || cur.status !== 'pending') return;
    row = cur;
    return { ...cur, status: approve ? 'paid' : 'rejected', decidedAt: now(), decidedBy: admin, memo: String(req.data.memo || '').slice(0, 100) };
  });
  if (!res.committed || !row) throw fail('failed-precondition', '이미 처리된 요청이에요.');
  if (!approve) await adjustBalance(row.uid, int(row.amount), 'withdraw_refund', id);
  return { ok: true };
});

// ---------- admin ----------

export const resolveRoom = onCall(async (req) => {
  const admin = uidOf(req);
  await requireAdmin(admin);
  const code = codeOf(req.data);
  const mode = req.data.mode === 'host' ? 'host' : 'refund';
  const ref = db().ref(`${ESCROW}/${code}`);
  const e = (await ref.once('value')).val();
  if (!e) throw fail('not-found', '정산 기록이 없어요.');
  if (e.status === 'settled' || e.status === 'cancelled') throw fail('failed-precondition', '이미 끝난 방이에요.');
  if (mode === 'refund') {
    await ref.child('status').set('cancelling');
    await refundAll(code, e);
    await ref.update({ status: 'cancelled', cancelledAt: now(), cancelledBy: admin });
    return { ok: true, status: 'cancelled' };
  }
  const provided = cleanRanking(req.data.ranking);
  const hostVote = e.results && e.results[e.hostUid];
  const ranking = provided.length ? provided : (hostVote && hostVote.ranking) || null;
  if (!ranking) throw fail('failed-precondition', '정산에 쓸 결과가 없어요.');
  if (e.status === 'open') await ref.child('status').set('started');
  const fresh = (await ref.once('value')).val();
  const res = await settle(code, fresh, ranking, `admin:${admin}`);
  return { ok: true, status: 'settled', payouts: res.payouts };
});

export const setConfig = onCall(async (req) => {
  const admin = uidOf(req);
  await requireAdmin(admin);
  const patch = {};
  if (typeof req.data.bank === 'string') patch.bank = req.data.bank.slice(0, 80);
  if (req.data.feeRate !== undefined) patch.feeRate = cleanFeeRate(req.data.feeRate);
  if (Number.isInteger(req.data.betGraceMs)) patch.betGraceMs = Math.max(0, Math.min(600_000, req.data.betGraceMs));
  if (Number.isInteger(req.data.minDeposit)) patch.minDeposit = Math.max(1000, req.data.minDeposit);
  if (Number.isInteger(req.data.maxBet)) patch.maxBet = Math.max(MIN_BET, req.data.maxBet);
  if (typeof req.data.enabled === 'boolean') patch.enabled = req.data.enabled;
  if (Array.isArray(req.data.entryFees)) patch.entryFees = req.data.entryFees.map(int).filter((n) => n > 0 && n <= MAX_FEE).slice(0, 8);
  if (!Object.keys(patch).length) throw fail('invalid-argument', '바꿀 설정이 없어요.');
  await db().ref(`${WALLET}/config`).update(patch);
  return { ok: true };
});
