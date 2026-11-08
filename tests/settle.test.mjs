import test from 'node:test';
import assert from 'node:assert/strict';
import { settleRoom, betOdds, rankingKey } from '../src/wallet/settle.js';

const esc = (over = {}) => ({
  entryFee: 1000, feeRate: 0.1,
  players: { A: { amount: 1000 }, B: { amount: 1000 }, C: { amount: 1000 } },
  seats: { A: true, B: true, C: true },
  bets: {},
  ...over,
});
const rank = (...pairs) => pairs.map(([uid, rank]) => ({ uid, rank }));

test('single winner takes pot minus fee; books balance', () => {
  const r = settleRoom(esc(), rank(['A', 1], ['B', 2], ['C', 3]));
  assert.deepEqual(r.winners, ['A']);
  assert.equal(r.prizePot, 3000);
  assert.equal(r.prizeFee, 300);
  assert.equal(r.prizePayouts.A, 2700);
  assert.equal(r.prizeFee + Object.values(r.prizePayouts).reduce((a, b) => a + b, 0), 3000);
});

test('tie splits prize, remainder goes to fee', () => {
  const r = settleRoom(esc({ feeRate: 0 }), rank(['A', 1], ['B', 1], ['C', 3]));
  assert.deepEqual(r.winners.sort(), ['A', 'B']);
  assert.equal(r.prizePayouts.A, 1500);
  assert.equal(r.prizePayouts.B, 1500);
  const r2 = settleRoom(esc({ feeRate: 0, players: { A: { amount: 1001 }, B: { amount: 1001 } }, seats: { A: true, B: true } }), rank(['A', 1], ['B', 1]));
  assert.equal(r2.prizePayouts.A, 1001);
  assert.equal(r2.prizeFee, 0);
  const r3 = settleRoom(esc({ feeRate: 0 }), rank(['A', 1], ['B', 1], ['C', 1]));
  assert.equal(r3.prizePayouts.A, 1000);
});

test('AI winning: best human wins (AI seats have no uid)', () => {
  const r = settleRoom(esc(), rank(['', 1], ['B', 2], ['A', 3], ['C', 4]));
  assert.deepEqual(r.winners, ['B']);
});

test('parimutuel bets: pool minus fee split pro rata among winning bets', () => {
  const bets = { x: { uid: 'S1', target: 'A', amount: 1000 }, y: { uid: 'S2', target: 'A', amount: 3000 }, z: { uid: 'S3', target: 'B', amount: 6000 } };
  const r = settleRoom(esc({ bets }), rank(['A', 1], ['B', 2], ['C', 3]));
  assert.equal(r.betPool, 10000);
  assert.equal(r.betFee, 1000);
  assert.equal(r.betPayouts.S1, 2250);
  assert.equal(r.betPayouts.S2, 6750);
  assert.equal(r.betPayouts.S3, undefined);
  assert.equal(r.betRefund, false);
  assert.equal(r.fee, 300 + 1000);
  const total = Object.values(r.payouts).reduce((a, b) => a + b, 0);
  assert.equal(total + r.fee, 3000 + 10000);
});

test('nobody bet on the winner: full refund, no bet fee', () => {
  const bets = { x: { uid: 'S1', target: 'B', amount: 500 }, y: { uid: 'S1', target: 'C', amount: 700 } };
  const r = settleRoom(esc({ bets }), rank(['A', 1], ['B', 2], ['C', 3]));
  assert.equal(r.betRefund, true);
  assert.equal(r.betFee, 0);
  assert.equal(r.betPayouts.S1, 1200);
});

test('free room: no prize, bets still settle among seated players', () => {
  const bets = { x: { uid: 'S1', target: 'B', amount: 1000 } };
  const r = settleRoom({ entryFee: 0, feeRate: 0.1, players: {}, seats: { A: true, B: true }, bets }, rank(['B', 1], ['A', 2]));
  assert.equal(r.prizePot, 0);
  assert.deepEqual(r.winners, ['B']);
  assert.equal(r.betPayouts.S1, 900);
  assert.equal(r.betFee, 100);
});

test('betOdds and rankingKey', () => {
  const o = betOdds(esc({ bets: { x: { uid: 'S1', target: 'A', amount: 1000 }, y: { uid: 'S2', target: 'B', amount: 3000 } } }));
  assert.equal(o.pool, 4000);
  assert.equal(o.per1000.A, 3600);
  assert.equal(o.per1000.B, 1200);
  assert.equal(rankingKey(rank(['B', 2], ['A', 1])), rankingKey(rank(['A', 1], ['B', 2])));
  assert.notEqual(rankingKey(rank(['B', 1], ['A', 2])), rankingKey(rank(['A', 1], ['B', 2])));
});
