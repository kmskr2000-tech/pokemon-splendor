// Wallet client: balances, deposit/withdraw requests, room escrow (entry fees +
// bets) and the operator's admin views.
//
// Trust model: the browser never writes money. Every balance change goes
// through a Cloud Function (see functions/index.js) that runs an RTDB
// transaction with the Admin SDK; database rules make the wallet paths
// read-only for clients (users read their own data, admins read everything).
// The client only *requests* (deposit request rows) and *reads*.
//
// RTDB layout (see firebase/database.rules.json):
//   pkmspl-wallet/
//     config                  { admins: {uid: true}, bank, feeRate, betGraceMs, minDeposit, maxBet, entryFees: [..] }
//     users/{uid}             { name, email, balance, updatedAt }
//     ledger/{uid}/{id}       { type, amount, balanceAfter, ref, memo, at }
//     deposits/{id}           { uid, name, email, amount, depositor, status, at, decidedAt, memo }
//     withdrawals/{id}        { uid, name, amount, bank, status, at, decidedAt }
//     fees/{id}               { code, amount, at }   feeTotal: number
//   pkmspl-escrow/{code}      { hostUid, entryFee, feeRate, status, createdAt, startedAt, betCloseAt,
//                               players: {uid: {name, amount, at}}, bets: {id: {uid, target, amount, at}},
//                               results: {uid: {key, ranking, at}}, settlement: {...} }

export const WALLET_PATH = 'pkmspl-wallet';
export const ESCROW_PATH = 'pkmspl-escrow';
export const FUNCTIONS_REGION = 'asia-southeast1';

const fb = () => (typeof window !== 'undefined' && window.firebase) || null;

let _db = null;
let _fns = null;

function db() {
  if (_db) return _db;
  const f = fb();
  if (!f) throw new Error('firebase-sdk-not-loaded');
  if (!f.apps || f.apps.length === 0) f.initializeApp(window.__FIREBASE_CONFIG);
  _db = f.database();
  return _db;
}

/** True when callable functions are available (SDK loaded). */
export function walletAvailable() {
  const f = fb();
  return !!(f && f.apps && typeof f.app === 'function' && f.app().functions);
}

function fns() {
  if (_fns) return _fns;
  const f = fb();
  if (!f || !f.app || !f.app().functions) throw new Error('functions-sdk-not-loaded');
  _fns = f.app().functions(FUNCTIONS_REGION);
  return _fns;
}

/** Call a Cloud Function; errors become Korean messages for the UI. */
export async function call(name, data = {}) {
  let fn;
  try { fn = fns().httpsCallable(name); } catch { throw new Error('지갑 서버 SDK가 로드되지 않았어요.'); }
  try {
    const res = await fn(data);
    return res && res.data;
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'unauthenticated' || code === 'functions/unauthenticated') throw new Error('로그인이 필요해요.');
    if (code === 'not-found' || code === 'functions/not-found' || code === 'functions/internal' && /not found/i.test(e.message || '')) {
      throw new Error('지갑 서버(Cloud Functions)가 아직 배포되지 않았어요. docs/wallet-setup.md를 참고하세요.');
    }
    if (code === 'unavailable' || code === 'functions/unavailable') throw new Error('지갑 서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.');
    throw new Error((e && e.message) || '요청에 실패했어요.');
  }
}

export const fmtWon = (n) => `${Math.floor(Number(n) || 0).toLocaleString('ko-KR')}원`;

// ---------- reads ----------

/** Watch wallet config (bank account, fee rate, admins...). Returns unsubscribe. */
export function watchConfig(cb) {
  const ref = db().ref(`${WALLET_PATH}/config`);
  const h = (s) => cb(normalizeConfig(s.val()));
  ref.on('value', h, () => cb(normalizeConfig(null)));
  return () => { try { ref.off('value', h); } catch {} };
}

export function normalizeConfig(c) {
  c = c || {};
  const fees = Array.isArray(c.entryFees) ? c.entryFees.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  return {
    admins: c.admins || {},
    bank: typeof c.bank === 'string' ? c.bank : '',
    feeRate: Number.isFinite(Number(c.feeRate)) ? Number(c.feeRate) : 0.1,
    betGraceMs: Number.isInteger(c.betGraceMs) ? c.betGraceMs : 90000,
    minDeposit: Number.isInteger(c.minDeposit) ? c.minDeposit : 1000,
    maxBet: Number.isInteger(c.maxBet) ? c.maxBet : 100000,
    entryFees: fees.length ? fees : [1000, 3000, 5000, 10000],
    enabled: c.enabled !== false,
  };
}

/** Watch my wallet row. cb({balance, name, email}) */
export function watchUser(uid, cb) {
  const ref = db().ref(`${WALLET_PATH}/users/${uid}`);
  const h = (s) => { const v = s.val() || {}; cb({ balance: Math.floor(Number(v.balance) || 0), name: v.name || '', email: v.email || '' }); };
  ref.on('value', h, () => cb({ balance: 0, name: '', email: '', error: true }));
  return () => { try { ref.off('value', h); } catch {} };
}

/** Watch my ledger (latest 50). cb([{id, ...}]) newest first. */
export function watchLedger(uid, cb, limit = 50) {
  const ref = db().ref(`${WALLET_PATH}/ledger/${uid}`).limitToLast(limit);
  const h = (s) => { const out = []; s.forEach((c) => { out.push({ id: c.key, ...(c.val() || {}) }); }); cb(out.reverse()); };
  ref.on('value', h, () => cb([]));
  return () => { try { ref.off('value', h); } catch {} };
}

/** Watch my deposit / withdrawal requests. cb({deposits:[], withdrawals:[]}) */
export function watchMyRequests(uid, cb) {
  const out = { deposits: [], withdrawals: [] };
  const d = db().ref(`${WALLET_PATH}/deposits`).orderByChild('uid').equalTo(uid).limitToLast(20);
  const w = db().ref(`${WALLET_PATH}/withdrawals`).orderByChild('uid').equalTo(uid).limitToLast(20);
  const hd = (s) => { const a = []; s.forEach((c) => { a.push({ id: c.key, ...(c.val() || {}) }); }); out.deposits = a.reverse(); cb({ ...out }); };
  const hw = (s) => { const a = []; s.forEach((c) => { a.push({ id: c.key, ...(c.val() || {}) }); }); out.withdrawals = a.reverse(); cb({ ...out }); };
  d.on('value', hd, () => {});
  w.on('value', hw, () => {});
  return () => { try { d.off('value', hd); w.off('value', hw); } catch {} };
}

/** Watch a room's escrow (entry fees, bets, settlement). cb(escrow|null) */
export function watchEscrow(code, cb) {
  const ref = db().ref(`${ESCROW_PATH}/${code}`);
  const h = (s) => cb(s.exists() ? s.val() : null);
  ref.on('value', h, () => cb(null));
  return () => { try { ref.off('value', h); } catch {} };
}

export async function readEscrow(code) {
  const s = await db().ref(`${ESCROW_PATH}/${code}`).once('value');
  return s.exists() ? s.val() : null;
}

// ---------- user requests ----------

/**
 * Ask the operator to credit a bank transfer. The row is written by the client
 * (rules: own uid, status 'pending', sane amount); the admin approves it, and
 * only the approval function moves money.
 */
export async function requestDeposit(user, amount, depositor) {
  const amt = Math.floor(Number(amount) || 0);
  if (amt <= 0) throw new Error('금액을 확인해주세요.');
  const ref = db().ref(`${WALLET_PATH}/deposits`).push();
  await ref.set({
    uid: user.uid, name: user.name || '', email: user.email || '',
    amount: amt, depositor: String(depositor || '').slice(0, 30),
    status: 'pending', at: Date.now(),
  });
  return ref.key;
}

export const requestWithdraw = (amount, bank) => call('requestWithdraw', { amount: Math.floor(Number(amount) || 0), bank: String(bank || '').slice(0, 60) });

// ---------- room escrow (players / spectators) ----------

export const createEscrow = (code, entryFee, name) => call('createEscrow', { code, entryFee: Math.floor(Number(entryFee) || 0), name });
export const payEntry = (code, name) => call('payEntry', { code, name });
export const placeBet = (code, target, amount) => call('placeBet', { code, target, amount: Math.floor(Number(amount) || 0) });
export const startRoom = (code, playerUids) => call('startRoom', { code, playerUids });
export const reportResult = (code, ranking) => call('reportResult', { code, ranking });
export const cancelRoom = (code) => call('cancelRoom', { code });

// ---------- admin ----------

export function isAdmin(config, uid) {
  return !!(config && uid && config.admins && config.admins[uid] === true);
}

export function watchPending(kind, cb) {
  const ref = db().ref(`${WALLET_PATH}/${kind}`).orderByChild('status').equalTo('pending');
  const h = (s) => { const a = []; s.forEach((c) => { a.push({ id: c.key, ...(c.val() || {}) }); }); cb(a); };
  ref.on('value', h, () => cb([]));
  return () => { try { ref.off('value', h); } catch {} };
}

export function watchFeeTotal(cb) {
  const ref = db().ref(`${WALLET_PATH}/feeTotal`);
  const h = (s) => cb(Math.floor(Number(s.val()) || 0));
  ref.on('value', h, () => cb(0));
  return () => { try { ref.off('value', h); } catch {} };
}

/** Rooms whose money is not settled yet (open/started/disputed). */
export function watchOpenEscrows(cb) {
  const ref = db().ref(ESCROW_PATH);
  const h = (s) => {
    const a = [];
    s.forEach((c) => { const v = c.val() || {}; if (v.status !== 'settled' && v.status !== 'cancelled') a.push({ code: c.key, ...v }); });
    a.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    cb(a);
  };
  ref.on('value', h, () => cb([]));
  return () => { try { ref.off('value', h); } catch {} };
}

export const decideDeposit = (id, approve, memo = '') => call('decideDeposit', { id, approve: !!approve, memo });
export const decideWithdraw = (id, approve, memo = '') => call('decideWithdraw', { id, approve: !!approve, memo });
export const resolveRoom = (code, mode, ranking = null) => call('resolveRoom', { code, mode, ranking });
export const setConfig = (patch) => call('setConfig', patch);
