// DOM glue: renders controller state into regions, wires taps, and paces AI turns.

// Self-update: if a newer build is deployed, jump to the versioned URL so
// browsers and home-screen web apps never sit on stale cached files.
// Also re-checked when the app comes back to the foreground (home-screen apps
// resume without reloading), except mid multiplayer game.
async function checkVersion() {
  try {
    const mine = window.__V;
    if (!mine) return;
    const r = await fetch('assets/version.json', { cache: 'no-store' });
    const { v } = await r.json();
    const param = new URLSearchParams(location.search).get('v');
    if (v && v !== mine && param !== String(v)) {
      if (typeof net !== 'undefined' && net && net.phase === 'playing' && ctrl && !ctrl.finished) return;
      // Never reload out of a room (host lobby, guest lobby): the reload would
      // orphan the room and the host would end up creating a second one.
      if (typeof net !== 'undefined' && net && net.room && net.phase !== 'menu') return;
      location.replace(location.pathname + '?v=' + v);
    }
  } catch { /* offline or first deploy: stay put */ }
}
checkVersion();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) checkVersion(); });

// In-app browser guard: KakaoTalk/etc. popups die when swiped away, killing
// multiplayer. iOS can't force-open Safari from JS, so detect and guide.
const INAPP_RE = /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER|DaumApp|Whale|MiuiBrowser/i;
function showInAppGuide() {
  try {
    const ua = navigator.userAgent || '';
    if (!INAPP_RE.test(ua) || sessionStorage.getItem('inapp-dismissed')) return;
    const bar = document.createElement('div');
    bar.id = 'inappbar';
    bar.innerHTML = `<div><b>📱 Safari에서 열어주세요</b><br><small>인앱 브라우저(팝업)는 실수로 내리면 게임 연결이 끊겨요.<br>메뉴(•••) → 'Safari로 열기' 또는 '다른 브라우저로 열기'를 눌러주세요.</small></div>
      <button id="inapp-copy">URL 복사</button><button id="inapp-x" aria-label="닫기">✕</button>`;
    document.body.prepend(bar);
    document.getElementById('inapp-x').onclick = () => {
      bar.remove();
      try { sessionStorage.setItem('inapp-dismissed', '1'); } catch {}
    };
    document.getElementById('inapp-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        document.getElementById('inapp-copy').textContent = '복사됨!';
      } catch {}
    };
  } catch {}
}
showInAppGuide();

import { CARDS } from '../data/cards.js?v=1795655295';
import { ACHIEVEMENTS, checkAchievements } from '../data/achievements.js?v=1795655295';
import { CHALLENGES, challengeWon } from '../data/challenges.js?v=1795655295';
import { createController } from './controller.js?v=1795655295';
import * as V from './view.js?v=1795655295';
import { NetSession, EMOTES, TONGUE } from '../net/session.js?v=1795655295';
import { listRooms, watchRooms, loadMatches, watchMatches, watchFinalPick, writeFinalPick } from '../net/fireroom.js?v=1795655295';
import { aggregateStats, duelPairs, eventStandings, EVENT, FINAL, formatRemain } from '../net/stats.js?v=1795655295';
import { finalState, myOpenMatch, finalRoomPrefix, MATCH_LABEL } from '../net/final.js?v=1795655295';
import { getBonuses, getPoints, bonusList } from '../core/engine.js?v=1795655295';
import { startBGM, stopBGM, unlockAudio } from '../audio/bgm.js?v=1795655295';
import { sfx, setSFXEnabled } from '../audio/sfx.js?v=1795655295';
import { browserStorage, loadDex, loadSave, saveGame, clearSave, recordCatch, recordGame, loadOptions, saveOptions, loadAchv, unlockAchv, loadRecords, recordResult, victoryScore, loadChal, completeChal, getPlayerId } from '../storage/store.js?v=1795655295';
import { createTurnAlerter } from './turn-alert.js?v=1795655295';

const params = new URLSearchParams(location.search);
const AI_DELAY = params.has('fast') ? 0 : 1600; // ?fast=1 skips the pacing delay (tests)
const AI_NAMES = ['지우', '이슬', '웅이', '로이'];

const regions = {
  header: ['header', V.headerHTML],
  tutorial: ['tutorial', () => V.tutorialHTML(tutorial)],
  help: ['help', () => V.helpHTML(ctrl, options, tutorial)],
  chbanner: ['chbanner', () => V.challengeBannerHTML(ctrl)],
  opponents: ['opponents', V.opponentsHTML],
  board: ['board', V.boardHTML],
  supply: ['supply', V.supplyHTML],
  me: ['me', V.meHTML],
  log: ['log', V.logHTML],
  actionbar: ['actionbar', V.actionBarHTML],
  sheet: ['sheet', V.sheetHTML],
};
const cache = {};
let ctrl = null;
let aiTimer = null;
let net = null; // NetSession while in multiplayer menu/lobby/game
let netNotice = ''; // one-shot notice shown on the start/net screen
let netHelpOpen = false;
let noticeOpen = false; // event rules notice
let champOpen = false; // final winner announcement
const CHAMP_KEY = 'pks-final-champ-seen-v1';
const champSeen = () => { try { return !!storage?.getItem(CHAMP_KEY); } catch { return true; } };
// Final tournament state for the lobby/stats, recomputed when its inputs change
// (match records, the pick) or the clock moves on (phase deadlines).
let _finMemo = { m: null, p: null, t: -1, v: null };
function finalNow() {
  if (!net || !net.matches) return null;
  const t = Math.floor(Date.now() / 5000);
  if (_finMemo.m !== net.matches || _finMemo.p !== net.finalPick || _finMemo.t !== t) {
    _finMemo = { m: net.matches, p: net.finalPick, t, v: finalState(net.matches, net.finalPick || null, Date.now()) };
  }
  return _finMemo.v;
}
const NOTICE_KEY = 'pks-notice-final-v1'; // bump to show a new notice once to everyone
let friendStats = null; // { loading, error, rows, myPid } while the friend-stats overlay is open
let dexOpen = false;
let dexDetail = null;
let rulesOpen = false;
let achvOpen = false;
let recordsOpen = false;
let chalOpen = false;
let tutorial = null; // { step } — guided first-game tutorial
let optionsOpen = false;
const storage = browserStorage();
const options = loadOptions(storage);
setSFXEnabled(options.sfx);
const turnAlerter = createTurnAlerter(() => options);

const $ = (id) => document.getElementById(id);

function setHTML(id, html) {
  if (cache[id] === html) return; // keeps animated sprites from restarting needlessly
  cache[id] = html;
  $(id).innerHTML = html;
}

let lastFinished = false;
let lastTurnPlayer = -1;
let lastPhaseKey = '';

function render() {
  checkChallenge();
  // Game end SFX (once)
  if (ctrl && ctrl.finished && !lastFinished) {
    lastFinished = true;
    const won = ctrl.state.ranking && ctrl.state.ranking[0]?.player === ctrl.human;
    if (ctrl.spectator || won) sfx.win(); else sfx.lose();
  } else if (!ctrl || !ctrl.finished) {
    lastFinished = false;
  }
  // Your-turn alerts (banner/flash/chime x2/vibrate/browser notification/
  // blinking title). Strong when the turn passes to me, light when my own
  // action moves me into the discard/evolve phase.
  if (ctrl && !ctrl.finished && ctrl.isHumanTurn) {
    const phaseKey = `${ctrl.game.current}:${ctrl.state.phase}`;
    if (phaseKey !== lastPhaseKey) {
      const isAction = ctrl.state.phase === 'action';
      const strong = isAction && lastTurnPlayer !== -1 && lastTurnPlayer !== ctrl.human;
      if (isAction ? (lastTurnPlayer !== -1) : lastPhaseKey !== '') turnAlerter.alert(ctrl.state.phase, strong);
      lastPhaseKey = phaseKey;
    }
  } else {
    if (lastPhaseKey !== '') turnAlerter.clear();
    lastPhaseKey = '';
  }
  if (ctrl) lastTurnPlayer = ctrl.game.current;
  else lastTurnPlayer = -1;

  document.body.classList.toggle('spectating', !!(ctrl && ctrl.spectator));
  if (ctrl) for (const [id, fn] of Object.values(regions)) setHTML(id, fn(ctrl));
  let overlay;
  if (net && !ctrl) {
    net.finalState = finalNow();
    if (friendStats) friendStats.final = net.finalState;
    // Announce the overall winner once.
    if (net.finalState && net.finalState.phase === 'done' && !champSeen()) champOpen = true;
  }
  if (champOpen && net && !ctrl && net.finalState && net.finalState.champion) {
    overlay = V.championHTML(net.finalState);
  } else if (friendStats && net && !ctrl) {
    overlay = V.friendStatsHTML(friendStats);
  } else if (noticeOpen && net && !ctrl) {
    overlay = V.noticeHTML();
  } else if (netHelpOpen && net) {
    overlay = V.netHelpHTML();
  } else if (net && !ctrl) {
    overlay = V.netHTML(net, netNotice);
    netNotice = '';
  } else {
    overlay = !ctrl ? V.startHTML({ save: loadSave(storage, CARDS), dex: loadDex(storage), cards: CARDS, options, notice: netNotice }) : ctrl.finished ? V.endHTML(ctrl) : '';
    netNotice = '';
  }
  if (ctrl?.challengeDone) overlay = V.challengeEndHTML(ctrl.challengeDone === 'won', ctrl.challenge);
  if (dexOpen) overlay = V.dexHTML(loadDex(storage), CARDS, dexDetail);
  else if (rulesOpen) overlay = V.rulesHTML();
  else if (achvOpen) overlay = V.achvHTML(loadAchv(storage).unlocked);
  else if (recordsOpen) overlay = V.recordsHTML(loadRecords(storage));
  else if (chalOpen) overlay = V.challengeListHTML(loadChal(storage).completed);
  else if (optionsOpen) overlay = V.optionsHTML(options);
  setHTML('overlay', overlay);
  syncEmoteBar();
  syncChat();
  scheduleAI();
}

// Resolves challenge win/lose. Win: goal met. Lose: turn limit hit or normal game end.
function checkChallenge() {
  if (!ctrl?.challenge || ctrl.challengeDone) return;
  if (ctrl.finished) { ctrl.challengeDone = 'lost'; return; }
  if (challengeWon(ctrl.challenge, ctrl, getPoints, bonusList)) {
    ctrl.challengeDone = 'won';
    completeChal(storage, ctrl.challenge.id);
    return;
  }
  if (ctrl.humanTurns >= ctrl.challenge.maxTurns) ctrl.challengeDone = 'lost';
}

function scheduleAI() {
  if (aiTimer || !ctrl || ctrl.finished || ctrl.isHumanTurn) return;
  // In multiplayer, only the host acts for AI seats; guests wait for the relay.
  if (net && net.phase === 'playing' && net.role !== 'host') return;
  // Only schedule when it's actually an AI's turn (no polling during humans' turns).
  if (!ctrl.game.players[ctrl.game.current].isAI) return;
  aiTimer = setTimeout(() => {
    aiTimer = null;
    if (ctrl) {
      const snap = snapshotMovables();
      ctrl.stepAI();
      render();
      animateAIFromSnap(snap);
    }
  }, AI_DELAY);
}

// ---------- fly animations ----------

const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Detached-but-clonable refs to cards on the table and balls in the supply,
// captured BEFORE a state change so we can fly a clone to its destination.
// Rects must be read here too — after render() the nodes are detached and measure zero.
function snapshotMovables() {
  const snap = new Map();
  document.querySelectorAll('[data-action="card"]').forEach((el) =>
    snap.set('card:' + el.dataset.card, { el, rect: el.getBoundingClientRect() }));
  document.querySelectorAll('#supply [data-color]').forEach((el) =>
    snap.set('ball:' + el.dataset.color, { el, rect: el.getBoundingClientRect() }));
  return snap;
}

function flyClone(src, dstEl, ms = 650) {
  if (!src || !dstEl || REDUCED_MOTION) return;
  const r1 = src.rect;
  const r2 = dstEl.getBoundingClientRect();
  if (!r1.width || !r2.width) return;
  const clone = src.el.cloneNode(true);
  clone.removeAttribute('data-action');
  Object.assign(clone.style, {
    position: 'fixed', left: r1.left + 'px', top: r1.top + 'px',
    width: r1.width + 'px', height: r1.height + 'px', margin: '0',
    zIndex: 60, pointerEvents: 'none',
  });
  document.body.appendChild(clone);
  const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2);
  const dy = r2.top + r2.height / 2 - (r1.top + r1.height / 2);
  const anim = clone.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.7}px, ${dy * 0.7 - 24}px) scale(.7)`, opacity: 1, offset: 0.7 },
      { transform: `translate(${dx}px, ${dy}px) scale(.4)`, opacity: 0.85 },
    ],
    { duration: ms, easing: 'cubic-bezier(.3,.7,.4,1)' },
  );
  anim.onfinish = () => clone.remove();
}

function flyBalls(snap, colors, dstEl) {
  colors.forEach((c, i) => {
    const src = snap.get('ball:' + c);
    if (src) setTimeout(() => flyClone(src, dstEl, 500), i * 90);
  });
}

function animateAIFromSnap(snap) {
  const ev = ctrl.lastAIEvent;
  if (!ev) return;
  // Spectators see seat `human` in the bottom panel.
  const dst = document.querySelector(`.opp[data-id="${ev.player}"]`) || (ev.player === ctrl.human ? document.getElementById('me') : null);
  if (!dst) return;
  if (ev.type === 'buy' || ev.type === 'reserve') {
    flyClone(snap.get('card:' + ev.cardId), dst);
  } else if (ev.type === 'takeBalls') {
    flyBalls(snap, ev.colors, dst);
  } else if (ev.type === 'takeTwo') {
    flyBalls(snap, [ev.color, ev.color], dst);
  }
}

const cardsById = new Map(CARDS.map((c) => [c.id, c]));
let caughtLegend = false; // this game's legend catch flag (for achievements)
let achvToasts = []; // newly unlocked achievements waiting to toast
let achvToastTimer = null;

function queueAchvToasts(list) {
  achvToasts = achvToasts.concat(list);
  renderAchvToast();
}

function renderAchvToast() {
  const el = document.getElementById('achvtoast');
  if (!el) return;
  const a = achvToasts[0];
  el.innerHTML = a ? `<div class="achvtoast-in"><span class="achvicon">${a.icon}</span><div><b>업적 달성!</b><br>${a.name}</div></div>` : '';
  el.style.display = a ? 'block' : 'none';
  clearTimeout(achvToastTimer);
  if (a) achvToastTimer = setTimeout(() => { achvToasts = achvToasts.slice(1); renderAchvToast(); }, 3000);
}

const hooks = {
  onCatch: (cardId, kind) => {
    recordCatch(storage, cardId, kind);
    const card = cardsById.get(cardId);
    if (card && (card.tier === 'rare' || card.tier === 'legend')) caughtLegend = true;
  },
  onChange: () => { if (ctrl && !ctrl.finished && !ctrl.challenge) saveGame(storage, ctrl.snapshot()); },
  onEnd: (won) => {
    recordGame(storage, won);
    if (ctrl) {
      const me = ctrl.me;
      const bonusColors = new Set();
      for (const card of me.tableau) for (const b of bonusList(card)) bonusColors.add(b);
      const ctx = {
        won,
        turns: ctrl.game.turn,
        evolutions: me.evolved.length,
        difficulty: ctrl.difficulty,
        points: getPoints(me),
        bonusColors,
        caughtLegend,
      };
      const newly = checkAchievements(ctx, loadAchv(storage).unlocked);
      if (newly.length) {
        unlockAchv(storage, newly.map((a) => a.id));
        queueAchvToasts(newly);
      }
      const rec = recordResult(storage, { won, points: ctx.points, turns: ctx.turns, difficulty: ctx.difficulty });
      ctrl.lastScore = rec.score;
      ctrl.lastBest = rec.isBest;
    }
    clearSave(storage);
    caughtLegend = false;
  },
};

function resumeGame() {
  const save = loadSave(storage, CARDS);
  if (!save) return;
  ctrl = createController({ cards: CARDS, seed: save.seed, humanName: save.humanName, aiNames: save.aiNames, resume: { game: save.game, log: save.log, difficulty: save.difficulty, aiPersonalities: save.aiPersonalities }, hooks });
  Object.keys(cache).forEach((k) => delete cache[k]);
  window.__ctrl = ctrl;
  render();
}

function startTutorial() {
  startGame('나');
  tutorial = { step: 0 };
  render();
}

function tutAdvance() {
  if (tutorial && tutorial.step < 3) {
    tutorial.step += 1;
    render();
  }
}

function startGame(humanName) {
  const seedParam = params.get('seed');
  const seed = seedParam !== null ? Number(seedParam) : (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  const aiNames = AI_NAMES.filter((n) => n !== humanName).slice(0, 3);
  clearSave(storage); // a new game replaces any saved one
  ctrl = createController({ cards: CARDS, seed, humanName, aiNames, hooks, difficulty: options.difficulty });
  saveGame(storage, ctrl.snapshot());
  Object.keys(cache).forEach((k) => delete cache[k]);
  window.__ctrl = ctrl; // debugging / automated tests
  if (options.bgm) startBGM('main');
  render();
}

function startChallenge(id) {
  const ch = CHALLENGES.find((c) => c.id === id);
  if (!ch) return;
  chalOpen = false;
  tutorial = null;
  clearSave(storage); // challenges don't use the save slot
  const seed = (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  ctrl = createController({ cards: CARDS, seed, humanName: '나', aiNames: AI_NAMES.slice(0, 3), hooks, difficulty: ch.difficulty, challenge: ch });
  ctrl.applyChallengeSetup(ch);
  Object.keys(cache).forEach((k) => delete cache[k]);
  window.__ctrl = ctrl;
  render();
}

// ---------- multiplayer ----------

function openNet() {
  if (net) return;
  net = new NetSession({
    onRender: () => render(),
    onGameStart: (c) => {
      clearTimeout(aiTimer); aiTimer = null;
      ctrl = c;
      Object.keys(cache).forEach((k) => delete cache[k]);
      window.__ctrl = ctrl; // debugging / automated tests
      startTimerUpdater();
      render();
    },
    onGameEnd: () => { stopLobbyWatch(); stopEventWatch(); stopStatsWatch(); friendStats = null; stopTimerUpdater(); net = null; ctrl = null; render(); },
    onNotice: (msg) => { netNotice = msg; render(); },
    onEmote: showEmote,
    onChat: () => syncChat(),
    // Other seats' moves (and spectator replays) fly like AI moves.
    beforeRemote: () => (ctrl ? { snap: snapshotMovables(), ev: ctrl.lastAIEvent } : null),
    afterRemote: (t) => {
      if (!t || !ctrl) return;
      render();
      if (ctrl.lastAIEvent && ctrl.lastAIEvent !== t.ev) animateAIFromSnap(t.snap);
    },
  }, { pid: getPlayerId(storage) });
  net.myName = options.playerName || ''; // pre-fill saved name
  net.roomList = [];
  net.eventRows = null; // lobby event banner (current leader)
  // Show the updated event rules once to every player.
  try { if (!storage?.getItem(NOTICE_KEY)) noticeOpen = true; } catch {}
  net.matches = null; // live match records (league standings + tournament sets)
  net.finalPick = null; // league winner's semifinal pick
  const gotMatches = (m) => {
    if (!net) return;
    net.matches = m;
    net.eventRows = eventStandings(m);
    if (!ctrl) render();
  };
  stopEventWatch();
  try {
    const u1 = watchMatches(gotMatches, () => {});
    const u2 = watchFinalPick((p) => { if (net) { net.finalPick = p; if (!ctrl) render(); } });
    _eventUnwatch = () => { u1(); u2(); };
  } catch {
    loadMatches().then(gotMatches).catch(() => {});
  }
  refreshLobby();
  render();
}

let _lobbyUnwatch = null;
let _eventUnwatch = null;
function stopEventWatch() {
  if (_eventUnwatch) { try { _eventUnwatch(); } catch {} _eventUnwatch = null; }
}

// Tournament: enter my match's dedicated room (join it if my opponent already
// opened one, otherwise open it and wait).
async function enterFinalMatch() {
  if (!net || net.phase !== 'menu') return;
  const myPid = net.myPid;
  const m = myOpenMatch(finalNow(), myPid);
  if (!m) { netNotice = '지금 치를 토너먼트 경기가 없어요.'; render(); return; }
  const me = m.a.pid === myPid ? m.a : m.b;
  const name = savePlayerName(me.name);
  closeFriendStats();
  let rooms = net.roomList || [];
  try { rooms = await listRooms(); } catch { /* use the watched list */ }
  if (!net || net.phase !== 'menu') return;
  const mine = (r) => r.final && r.final.key === m.key && (r.final.pids || []).includes(myPid);
  const open = rooms.find((r) => mine(r) && !r.started) || rooms.find((r) => mine(r) && r.started);
  netNotice = '';
  if (open) { net.guestJoin(name, open.code); return; }
  net.usePeer = true;
  net.hostCreate(name, `🏆 ${m.label} · ${m.a.name} vs ${m.b.name}`, 45000,
    { key: m.key, pids: [m.a.pid, m.b.pid], prefix: finalRoomPrefix(m.key) });
}

// Both players opened a room for the same match at once: the one with the later
// code closes theirs and joins the other.
function mergeFinalRooms(rooms) {
  if (!net || net.role !== 'host' || net.phase !== 'hostlobby' || !net.final || net.names.length !== 1) return;
  const other = rooms.find((r) => r.final && r.final.key === net.final.key && !r.started && r.code !== net.shortCode
    && (r.final.pids || []).includes(net.myPid) && r.code < net.shortCode);
  if (!other) return;
  const name = net.myName;
  net.end();
  openNet();
  noticeOpen = false;
  net.guestJoin(name, other.code);
}

function refreshLobby() {
  if (!net || !net.usePeer) return;
  listRooms().then((rooms) => {
    if (!net) return;
    net.roomList = rooms;
    render();
  }).catch(() => {});
  // Watch for live updates (only one watcher at a time).
  stopLobbyWatch();
  try {
    _lobbyUnwatch = watchRooms((rooms) => {
      if (!net) return;
      net.roomList = rooms;
      mergeFinalRooms(rooms);
      // Only re-render if we're on the lobby screen.
      if (net && net.phase === 'menu') render();
    });
  } catch {}
}

function stopLobbyWatch() {
  if (_lobbyUnwatch) { try { _lobbyUnwatch(); } catch {} _lobbyUnwatch = null; }
}

// ---------- emoticons (multiplayer only; never part of game state/log/save) ----------

const EMOTE_SHOW_MS = 2500;
const esc2 = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showEmote({ name, k }) {
  if (k === TONGUE) { showTongue(name); return; }
  const box = document.getElementById('emotetoast');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'emote-bubble';
  el.innerHTML = `${esc2(name)}<b>${esc2(k)}</b>`;
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), EMOTE_SHOW_MS);
}

// Event emote: a big tongue-out face over the middle of every player's screen.
// pointer-events: none, so it never blocks a move (the turn timer keeps running).
const TONGUE_SHOW_MS = 2600;
const TONGUE_SVG = `<svg viewBox="0 0 200 200" aria-hidden="true">
  <circle cx="100" cy="100" r="92" fill="#facc15" stroke="#1a1a2e" stroke-width="8"/>
  <path d="M50 68 L78 82 L50 96" fill="none" stroke="#1a1a2e" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <ellipse cx="134" cy="80" rx="11" ry="16" fill="#1a1a2e"/>
  <ellipse cx="44" cy="120" rx="14" ry="8" fill="#fb7185" opacity=".65"/>
  <ellipse cx="158" cy="120" rx="14" ry="8" fill="#fb7185" opacity=".65"/>
  <path d="M58 122 Q100 142 142 122" fill="none" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round"/>
  <path class="tongue" d="M80 128 Q78 182 105 182 Q132 182 128 128 Z" fill="#f43f5e" stroke="#1a1a2e" stroke-width="7" stroke-linejoin="round"/>
  <path d="M104 136 L104 162" stroke="#9f1239" stroke-width="5" stroke-linecap="round"/>
</svg>`;
let _tongueTimer = null;
function showTongue(name) {
  let el = document.getElementById('tongueshow');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tongueshow';
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="tongue-box">${TONGUE_SVG}<div class="tongue-txt">메롱~</div><div class="tongue-who">👑 ${esc2(name)}</div></div>`;
  el.hidden = false;
  try { sfx.lose(); } catch {}
  clearTimeout(_tongueTimer);
  _tongueTimer = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, TONGUE_SHOW_MS);
  syncEmoteBar();
}

// Friend stats overlay: live while open (event ranking updates in real time).
let _statsUnwatch = null;
function stopStatsWatch() {
  if (_statsUnwatch) { try { _statsUnwatch(); } catch {} _statsUnwatch = null; }
}
function openFriendStats(wantTab) {
  const myPid = getPlayerId(storage);
  const tab = ['final', 'event', 'all', 'duel'].includes(wantTab) ? wantTab : friendStats?.tab || (Date.now() >= EVENT.end ? 'final' : 'event');
  friendStats = { loading: true, error: false, rows: [], duel: [], event: [], tab, myPid };
  const apply = (m) => {
    if (!friendStats) return;
    if (net && m) net.eventRows = eventStandings(m);
    friendStats = m
      ? { loading: false, error: false, rows: aggregateStats(m), duel: duelPairs(m, myPid), event: net?.eventRows || eventStandings(m), tab: friendStats.tab, myPid }
      : { loading: false, error: true, rows: [], duel: [], event: [], tab: friendStats.tab, myPid };
    render();
  };
  stopStatsWatch();
  try {
    _statsUnwatch = watchMatches((m) => apply(m), () => apply(null));
  } catch {
    loadMatches().then(apply, () => apply(null));
  }
  render();
}
function closeFriendStats() {
  stopStatsWatch();
  friendStats = null;
}

// Event countdowns: any element with class "evtimer" shows time left until the event ends.
setInterval(() => {
  const els = document.querySelectorAll('.evtimer');
  if (!els.length) return;
  els.forEach((e) => {
    const txt = formatRemain((Number(e.dataset.end) || EVENT.end) - Date.now());
    if (e.textContent !== txt) e.textContent = txt;
  });
}, 1000);

// Spectator chat: a slim strip pinned to the bottom of the viewport for everyone.
// The action bar and page are pushed up by its height (--chat-h), so it never
// covers game controls. Spectators type; players only read.
let chatKey = '';
function syncChat() {
  const box = document.getElementById('specchat');
  if (!box) return;
  const playing = !!(net && ctrl && ctrl.mp && net.phase === 'playing');
  const spec = playing && !!ctrl.spectator;
  const list = playing ? (net.chat || []) : [];
  const show = spec || list.length > 0;
  const mode = !show ? 'off' : spec ? 'spec' : 'player';
  if (box.dataset.mode !== mode) {
    box.dataset.mode = mode;
    box.hidden = !show;
    box.innerHTML = !show ? '' : `<div class="sc-log"></div>${
      spec ? '<form class="sc-form"><input class="sc-input" maxlength="60" placeholder="💬 관전 채팅 (플레이어에게도 보여요)" autocomplete="off"><button class="sc-send" type="submit">전송</button></form>' : ''}`;
    chatKey = '';
    document.body.classList.toggle('haschat', show);
    if (!show) document.documentElement.style.setProperty('--chat-h', '0px');
  }
  if (!show) return;
  const shown = spec ? list.slice(-3) : list.slice(-2);
  const key = shown.map((m) => m.id).join(',');
  if (key === chatKey) return;
  chatKey = key;
  const log = box.querySelector('.sc-log');
  log.innerHTML = shown.length
    ? shown.map((m) => `<div class="sc-line">💬 <b>${esc2(m.name)}</b> ${esc2(m.text)}</div>`).join('')
    : '';
  document.documentElement.style.setProperty('--chat-h', `${box.offsetHeight}px`);
}
// Typing must not move the page. Mobile browsers (iOS Safari) scroll the page
// when an input in a bottom-pinned bar gets focus: focus without scrolling, put
// the scroll position back if the browser moved it anyway, and lift the bar
// above the on-screen keyboard using the visual viewport.
function holdScroll(y) {
  const back = () => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(window.scrollX, y); };
  requestAnimationFrame(back);
  [60, 150, 300, 500, 800].forEach((ms) => setTimeout(back, ms));
}
document.addEventListener('pointerdown', (e) => {
  const input = e.target.closest && e.target.closest('.sc-input');
  if (!input || document.activeElement === input) return;
  e.preventDefault();
  const y = window.scrollY;
  input.focus({ preventScroll: true });
  holdScroll(y);
});
document.addEventListener('focusin', (e) => {
  if (e.target.classList && e.target.classList.contains('sc-input')) holdScroll(window.scrollY);
});
if (window.visualViewport) {
  const vv = window.visualViewport;
  const liftChat = () => {
    // Keyboard height = layout viewport bottom hidden below the visual viewport.
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', liftChat);
  vv.addEventListener('scroll', liftChat);
}

document.addEventListener('submit', (e) => {
  const form = e.target.closest && e.target.closest('.sc-form');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('.sc-input');
  const y = window.scrollY;
  if (net && input && net.sendChat(input.value)) input.value = '';
  holdScroll(y);
});

let emoteBarOn = 'off';
function syncEmoteBar() {
  const bar = document.getElementById('emotebar');
  if (!bar) return;
  const on = !!(net && ctrl && ctrl.mp && !ctrl.spectator && !ctrl.finished && net.phase === 'playing');
  // Event leader gets an extra 메롱 button with its per-game uses left.
  // Event emote for every player while the event runs (leader has extra uses).
  const evOn = on && typeof net.tongueLeft === 'function' && Date.now() >= EVENT.start && Date.now() < FINAL.end;
  const left = evOn ? net.tongueLeft() : 0;
  const lead = evOn;
  const max = evOn ? net.tongueMax() : 0;
  const key = on ? `on:${lead ? left : '-'}` : 'off';
  if (key === emoteBarOn) return;
  emoteBarOn = key;
  bar.hidden = !on;
  // Text emotes (e.g. '중국인') get a wider, smaller-font button than emoji ones.
  const isText = (k) => /[\p{L}\p{N}]/u.test(k);
  const tongueBtn = lead
    ? `<button class="tonguebtn" data-action="emote" data-k="${TONGUE}" ${left ? '' : 'disabled'} aria-label="이벤트 메롱 (${left}/${max})">😝<i>${left}</i></button>`
    : '';
  bar.innerHTML = on ? tongueBtn + EMOTES.map((k) => `<button class="${isText(k) ? 'txt' : ''}" data-action="emote" data-k="${k}" aria-label="이모티콘 ${k}">${k}</button>`).join('') : '';
}

let _timerUpdater = null;

/** Update the turn timer display every second during multiplayer games. */
function startTimerUpdater() {
  stopTimerUpdater();
  _timerUpdater = setInterval(() => {
    if (!net || !ctrl || !ctrl.mp) return;
    const el = document.getElementById('turntimer');
    if (!el) return;
    const remaining = net.getTurnRemaining();
    el.textContent = `⏱ ${remaining}초`;
    el.classList.toggle('urgent', remaining <= 10 && remaining > 0);
  }, 1000);
  if (_timerUpdater.unref) _timerUpdater.unref();
}

function stopTimerUpdater() {
  if (_timerUpdater) { clearInterval(_timerUpdater); _timerUpdater = null; }
}

function savePlayerName(name) {
  const clean = String(name || '').trim().slice(0, 12);
  if (clean && clean !== options.playerName) {
    options.playerName = clean;
    saveOptions(storage, options);
  }
  return clean || '트레이너';
}

const netInputVal = (id) => document.getElementById(id)?.value ?? '';

document.addEventListener('click', (e) => {
  turnAlerter.acknowledge();
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  // Unlock audio on first interaction; start menu BGM if enabled.
  unlockAudio();
  if (options.bgm && !ctrl) startBGM('calm');
  const d = el.dataset;
  switch (d.action) {
    case 'emote': if (net) { net.sendEmote(d.k); syncEmoteBar(); } return;
    case 'start': startGame(d.name); return;
    case 'resume': resumeGame(); return;
    case 'dex': dexOpen = true; dexDetail = null; break;
    case 'dex-close': dexOpen = false; dexDetail = null; break;
    case 'dex-card': dexDetail = d.card; break;
    case 'dex-detail-close': dexDetail = null; break;
    case 'rules': rulesOpen = true; break;
    case 'rules-close': rulesOpen = false; break;
    case 'achv': achvOpen = true; break;
    case 'achv-close': achvOpen = false; break;
    case 'records': recordsOpen = true; break;
    case 'records-close': recordsOpen = false; break;
    case 'challenge': chalOpen = true; break;
    case 'challenge-close': chalOpen = false; break;
    case 'challenge-start': startChallenge(d.id); return;
    case 'options': optionsOpen = true; break;
    case 'options-close': optionsOpen = false; break;
    case 'toggle-help':
      options.beginnerHelp = !options.beginnerHelp;
      saveOptions(storage, options);
      break;
    case 'toggle-bgm':
      options.bgm = !options.bgm;
      saveOptions(storage, options);
      if (options.bgm) startBGM(ctrl ? 'main' : 'calm'); else stopBGM();
      break;
    case 'toggle-sfx':
      options.sfx = !options.sfx;
      saveOptions(storage, options);
      setSFXEnabled(options.sfx);
      break;
    case 'toggle-turn-notify':
      options.turnNotify = options.turnNotify === false;
      saveOptions(storage, options);
      if (options.turnNotify) turnAlerter.requestPermission();
      break;
    case 'difficulty':
      if (['easy', 'normal', 'hard'].includes(d.v)) {
        options.difficulty = d.v;
        saveOptions(storage, options);
      }
      break;
    case 'opp': ctrl.openOpp(d.id); break;
    case 'view-card':
      ctrl.viewCard(d.card, d.from === 'opp' ? { kind: 'opp', playerId: Number(d.pid) } : null);
      break;
    case 'view-back': {
      const from = ctrl.sheet && ctrl.sheet.from;
      ctrl.sheet = from || null;
      break;
    }
    case 'restart':
      if (net) net.end();
      ctrl = null; tutorial = null; optionsOpen = false; clearTimeout(aiTimer); aiTimer = null;
      if (options.bgm) startBGM('calm');
      break;
    case 'tutorial': startTutorial(); return;
    // ----- multiplayer -----
    case 'net': openNet(); break;
    case 'net-menu': if (net) { net.phase = 'menu'; netNotice = ''; refreshLobby(); } break;
    case 'net-lobby-refresh': if (net) { refreshLobby(); } break;
    case 'net-spectate': if (net && d.code) { netNotice = ''; net.spectate(d.code); return; } break;
    case 'net-lobby-join': if (net) {
      const code = d.code;
      if (!code) break;
      // If name is set, join directly. Otherwise ask for name first.
      if (net.myName && net.myName.trim()) {
        netNotice = '';
        net.guestJoin(net.myName, code);
        return;
      } else {
        net.pendingJoinCode = code;
        net.phase = 'guestname';
        netNotice = '';
      }
      break;
    }
    case 'net-host': if (net) { net.usePeer = true; net.phase = 'hostname'; netNotice = ''; } break;
    case 'net-join': if (net) { net.usePeer = true; net.phase = 'guestname'; netNotice = ''; } break;
    case 'net-manual': if (net) { net.usePeer = false; net.phase = 'menu'; netNotice = '수동 연결 모드: 코드를 두 번 주고받아야 해요.'; } break;
    case 'net-peer': if (net) { net.usePeer = true; net.phase = 'menu'; netNotice = ''; } break;
    case 'net-ai': if (net) {
      const n = Math.max(0, Math.min(4 - net.names.length, Number(d.n) || 0));
      net.aiCount = n;
      netNotice = '';
    } break;
    case 'net-help': netHelpOpen = true; break;
    case 'net-notice': noticeOpen = true; break;
    case 'net-notice-close':
      noticeOpen = false;
      try { storage?.setItem(NOTICE_KEY, '1'); } catch {}
      break;
    case 'net-stats': case 'net-stats-refresh': openFriendStats(d.tab); break;
    case 'net-final-enter': enterFinalMatch(); return;
    case 'net-champ-close':
      champOpen = false;
      try { storage?.setItem(CHAMP_KEY, '1'); } catch {}
      break;
    case 'net-final-pick': if (net && d.pid) {
      if (!window.confirm(`4강 상대로 ${d.name || ''}을(를) 지명할까요? 바꿀 수 없어요.`)) break;
      writeFinalPick({ pid: d.pid, name: d.name || '', by: net.myPid }).then((p) => {
        if (!net) return;
        if (p) net.finalPick = p; else netNotice = '지명 저장에 실패했어요. 다시 시도해주세요.';
        render();
      });
      return;
    } break;
    case 'net-stats-close': closeFriendStats(); break;
    case 'net-stats-tab': if (friendStats) friendStats.tab = ['duel', 'event', 'final'].includes(d.tab) ? d.tab : 'all'; break;
    case 'net-help-close': netHelpOpen = false; break;
    case 'net-timelimit': if (net) {
      const ms = Number(d.ms);
      net.pendingTurnLimit = (ms === 20000) ? 20000 : 45000;
      break;
    }
    case 'net-host-create': if (net) {
      netNotice = '';
      const name = savePlayerName(netInputVal('netname'));
      const titleEl = document.getElementById('nettitle');
      const title = titleEl ? titleEl.value.trim().slice(0, 20) : '';
      const turnLimitMs = net.pendingTurnLimit || 45000;
      net.pendingTurnLimit = null;
      net.hostCreate(name, title, turnLimitMs);
      return;
    } break;
    case 'net-host-invite': if (net) { netNotice = ''; net.hostInvite(); return; } break;
    case 'net-host-accept': if (net) { netNotice = ''; net.hostAcceptAnswer(netInputVal('netanswer')); return; } break;
    case 'net-host-lobby': if (net) { net.phase = 'hostlobby'; netNotice = ''; } break;
    case 'net-host-start': if (net) { netNotice = ''; net.hostStart(); } break;
    case 'net-guest-next': if (net) {
      net.myName = savePlayerName(netInputVal('netname'));
      netNotice = '';
      // If we came from lobby with a pending room, join it directly.
      if (net.pendingJoinCode) {
        const code = net.pendingJoinCode;
        net.pendingJoinCode = null;
        net.guestJoin(net.myName, code);
        return;
      }
      net.phase = 'guestjoin';
      break;
    } break;
    case 'net-guest-join': if (net) { netNotice = ''; net.guestJoin(net.myName, netInputVal('netoffer')); return; } break;
    case 'net-rejoin': if (net) {
      const code = d.code;
      if (!code) break;
      // Continue button: rejoin the recent room (saved seat is sent with HELLO).
      if (net.myName && net.myName.trim()) {
        netNotice = '';
        net.guestJoin(net.myName, code);
        return;
      } else {
        net.pendingJoinCode = code;
        net.phase = 'guestname';
        netNotice = '';
      }
      break;
    }
    case 'net-cancel-join': if (net) { net.cancelGuestJoin(); } break;
    case 'net-copy': {
      const t = document.getElementById(d.from);
      if (t) { t.select(); try { navigator.clipboard.writeText(t.value); netNotice = '복사됐어요.'; } catch { netNotice = '복사가 안 되면 직접 드래그해서 복사해주세요.'; } }
      break;
    }
    case 'net-leave': if (net) { netHelpOpen = false; noticeOpen = false; closeFriendStats(); net.end(); return; } break;
    case 'tut-next': tutAdvance(); return;
    case 'tut-done': tutorial = null; break;
    case 'tut-skip': tutorial = null; break;
    case 'ball': ctrl.toggleBall(d.color); break;
    case 'clear': ctrl.clearSelection(); break;
    case 'confirm-balls': {
      const colors = [...ctrl.balls];
      const snap = snapshotMovables();
      ctrl.confirmBalls();
      sfx.takeBall();
      if (tutorial && tutorial.step === 0) tutorial.step = 1;
      render();
      flyBalls(snap, colors, document.getElementById('me'));
      return;
    }
    case 'card': ctrl.openCard(d.card); break;
    case 'deck': ctrl.openDeck(d.tier); break;
    case 'close': ctrl.closeSheet(); break;
    case 'buy': {
      const snap = snapshotMovables();
      const card = ctrl.cardsById.get(d.card);
      const isMaster = card && (card.tier === 'rare' || card.tier === 'legend');
      ctrl.buy(d.card);
      sfx.catch();
      if (isMaster) setTimeout(() => sfx.masterBall(), 200);
      if (tutorial && tutorial.step === 1) tutorial.step = 2;
      render();
      flyClone(snap.get('card:' + d.card), document.getElementById('me'));
      return;
    }
    case 'reserve': {
      const snap = snapshotMovables();
      ctrl.reserveCard(d.card);
      sfx.reserve();
      if (tutorial && tutorial.step === 1) tutorial.step = 2;
      render();
      flyClone(snap.get('card:' + d.card), document.getElementById('me'));
      return;
    }
    case 'reserve-deck': ctrl.reserveDeck(d.tier); sfx.reserve(); break;
    case 'discard': ctrl.toggleDiscard(d.token); break;
    case 'undiscard': ctrl.undoDiscard(d.token); break;
    case 'confirm-discard': ctrl.confirmDiscard(); sfx.discard(); break;
    case 'evolve': ctrl.evolve(d.card); sfx.evolve(); break;
    case 'skip-evolve': ctrl.skipEvolve(); break;
    case 'pass': ctrl.pass(); break;
    default: return;
  }
  render();
});

render();
