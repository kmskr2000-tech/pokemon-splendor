import test from 'node:test';
import assert from 'node:assert/strict';
import { NetSession } from '../src/net/session.js';
import { MSG, parseMsg, makeMsg } from '../src/net/protocol.js';

// Minimal in-memory transport: host peers are [guest0, spectator1].
function fakeRoom() {
  const sent = []; // {to, msg}
  return {
    code: 'ABCDEF', peers: [], isHost: true, sent,
    sendTo: (i, m) => sent.push({ to: i, msg: parseMsg(m) }),
    broadcast: (m, except = -1) => { for (let i = 0; i < 2; i++) if (i !== except) sent.push({ to: i, msg: parseMsg(m) }); },
    send: (m) => sent.push({ to: 'host', msg: parseMsg(m) }),
    writeSnapshot: async () => {}, markStarted: async () => {}, markFinished: async () => {},
    setGuestPlayerIndex: async () => {}, close: async () => {},
  };
}

const quiet = () => ({ onRender() {}, onGameStart() {}, onGameEnd() {}, onNotice() {}, onEmote() {} });
const fakeWallet = (log) => ({
  getUser: () => ({ uid: 'HOSTUID' }),
  createEscrow: async () => {}, payEntry: async () => {}, placeBet: async () => {},
  startRoom: async (...a) => log.push(['startRoom', ...a]), reportResult: async (...a) => log.push(['reportResult', ...a]),
  cancelRoom: async () => {}, watchEscrow: () => () => {},
});

function hostWithGuest(log = []) {
  const host = new NetSession(quiet(), { pid: 'HOSTPID12345', wallet: fakeWallet(log) });
  host.role = 'host'; host.phase = 'hostlobby'; host.myName = '방장'; host.myIndex = 0;
  host.names = ['방장']; host.pids = ['HOSTPID12345']; host.uids = ['HOSTUID'];
  host.room = fakeRoom();
  host.onMsg(0, { t: MSG.HELLO, name: '손님', pid: 'GUESTPID1234', uid: 'GUESTUID' });
  return host;
}

test('host seats a guest, accepts a spectator without a seat, broadcasts head count', () => {
  const host = hostWithGuest();
  assert.deepEqual(host.names, ['방장', '손님']);
  assert.deepEqual(host.uids, ['HOSTUID', 'GUESTUID']);
  host.room.sent.length = 0;
  host.onMsg(1, { t: MSG.HELLO, name: '관전자', uid: 'SPECUID', spectator: true });
  assert.deepEqual(host.names, ['방장', '손님'], 'spectator is not seated');
  assert.equal(host.peerToPlayer[1], undefined);
  assert.equal(host.spectatorCount, 1);
  const ok = host.room.sent.find((s) => s.to === 1 && s.msg.t === MSG.SPECTATE_OK);
  assert.ok(ok);
  assert.deepEqual(ok.msg.uids, ['HOSTUID', 'GUESTUID']);
  assert.equal(ok.msg.state, undefined, 'no state before the game starts');
  assert.ok(host.room.sent.some((s) => s.to === 0 && s.msg.t === MSG.SPECTATORS && s.msg.n === 1));
});

test('spectator joining mid-game receives the live state and mirrors actions read-only', async () => {
  const log = [];
  const host = hostWithGuest(log);
  host.escrow = null; // free room, no wallet gate
  await host.hostStart();
  assert.equal(host.phase, 'playing');
  host.room.sent.length = 0;
  host.onMsg(1, { t: MSG.HELLO, name: '관전자', uid: 'SPECUID', spectator: true });
  const ok = host.room.sent.find((s) => s.to === 1 && s.msg.t === MSG.SPECTATE_OK).msg;
  assert.ok(ok.state && ok.seed === host.seed);

  const spec = new NetSession(quiet(), { pid: 'SPECPID12345', wallet: fakeWallet([]) });
  spec.role = 'spectator'; spec.phase = 'spectlobby'; spec.myName = '관전자';
  spec.room = fakeRoom(); spec.room.isHost = false;
  spec.onMsg(0, ok);
  assert.equal(spec.phase, 'playing');
  assert.ok(spec.ctrl.spectator);
  assert.equal(spec.ctrl.human, -1);
  assert.equal(spec.ctrl.isHumanTurn, false);
  assert.equal(spec.ctrl.mp.getSpectators(), 1);
  // Host plays one legal action; the spectator applies the relayed copy.
  const legal = (await import('../src/core/engine.js')).legalActions(host.ctrl.game);
  const action = legal.find((a) => a.type !== 'pass') || legal[0];
  host.ctrl.dispatch(action);
  await host._commitChain;
  const relayed = host.room.sent.filter((s) => s.msg.t === MSG.ACTION && s.to === 1);
  assert.equal(relayed.length, 1);
  spec.onMsg(0, relayed[0].msg);
  assert.equal(spec.ctrl.game.turn, host.ctrl.game.turn);
  assert.equal(spec.ctrl.game.current, host.ctrl.game.current);
  assert.ok(!spec.room.sent.some((s) => s.msg.t === MSG.SYNC_REQ), 'mirror stayed in sync');
  // Spectator clicks are inert.
  spec.ctrl.toggleBall('monster');
  assert.deepEqual(spec.ctrl.balls, []);
  spec.ctrl.openCard(spec.ctrl.game.table['1'][0].id);
  assert.equal(spec.ctrl.sheet, null);
  spec.ctrl.viewCard(spec.ctrl.game.table['1'][0].id);
  assert.equal(spec.ctrl.sheet.kind, 'view');
  // No wallet calls for a free room without escrow.
  assert.equal(log.length, 0);
});

test('paid room: start is blocked until everyone paid, then locks the escrow server-side', async () => {
  const log = [];
  const host = hostWithGuest(log);
  host.entryFee = 1000;
  host.escrow = { status: 'open', entryFee: 1000, players: { HOSTUID: { amount: 1000 } } };
  assert.equal(host.allPaid(), false);
  await host.hostStart();
  assert.equal(host.phase, 'hostlobby', 'unpaid guest blocks start');
  host.escrow.players.GUESTUID = { amount: 1000 };
  assert.equal(host.allPaid(), true);
  await host.hostStart();
  assert.equal(host.phase, 'playing');
  assert.deepEqual(log[0], ['startRoom', 'ABCDEF', ['HOSTUID', 'GUESTUID']]);
  const start = host.room.sent.find((s) => s.msg.t === MSG.START).msg;
  assert.deepEqual(start.uids, ['HOSTUID', 'GUESTUID']);
  assert.equal(start.entryFee, 1000);
});

test('lobby leave keeps uids aligned with names', () => {
  const host = hostWithGuest();
  host.onMsg(1, { t: MSG.HELLO, name: '셋째', pid: 'THIRDPID1234', uid: 'THIRDUID' });
  assert.deepEqual(host.uids, ['HOSTUID', 'GUESTUID', 'THIRDUID']);
  host.onLeave(0); // first guest leaves
  assert.deepEqual(host.names, ['방장', '셋째']);
  assert.deepEqual(host.uids, ['HOSTUID', 'THIRDUID']);
  assert.equal(host.peerToPlayer[1], 1);
});

test('finished game reports ranking with uids once', async () => {
  const log = [];
  const host = hostWithGuest(log);
  host.escrow = { status: 'started', entryFee: 1000, players: {} };
  await host.hostStart();
  log.length = 0;
  // Force a finished state and commit a no-op.
  host.ctrl.game.phase = 'finished';
  host.ctrl.game.ranking = [{ player: 1, rank: 1, points: 21, evolutions: 0, pokemon: 1 }, { player: 0, rank: 2, points: 10, evolutions: 0, pokemon: 1 }];
  await host._doCommit({ type: 'pass' }, 0);
  await host._doCommit({ type: 'pass' }, 0);
  const reports = log.filter((l) => l[0] === 'reportResult');
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0][2], [{ uid: 'GUESTUID', rank: 1 }, { uid: 'HOSTUID', rank: 2 }]);
});
