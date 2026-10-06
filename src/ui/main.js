// DOM glue: renders controller state into regions, wires taps, and paces AI turns.

import { CARDS } from '../data/cards.js?v=1791268011';
import { ACHIEVEMENTS, checkAchievements } from '../data/achievements.js?v=1791268011';
import { CHALLENGES, challengeWon } from '../data/challenges.js?v=1791268011';
import { createController } from './controller.js?v=1791268011';
import * as V from './view.js?v=1791268011';
import { getBonuses, getPoints, bonusList } from '../core/engine.js?v=1791268011';
import { browserStorage, loadDex, loadSave, saveGame, clearSave, recordCatch, recordGame, loadOptions, saveOptions, loadAchv, unlockAchv, loadRecords, recordResult, victoryScore, loadChal, completeChal } from '../storage/store.js?v=1791268011';

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
let dexOpen = false;
let rulesOpen = false;
let achvOpen = false;
let recordsOpen = false;
let chalOpen = false;
let tutorial = null; // { step } — guided first-game tutorial
let optionsOpen = false;
const storage = browserStorage();
const options = loadOptions(storage);

const $ = (id) => document.getElementById(id);

function setHTML(id, html) {
  if (cache[id] === html) return; // keeps animated sprites from restarting needlessly
  cache[id] = html;
  $(id).innerHTML = html;
}

function render() {
  checkChallenge();
  if (ctrl) for (const [id, fn] of Object.values(regions)) setHTML(id, fn(ctrl));
  let overlay = !ctrl ? V.startHTML({ save: loadSave(storage, CARDS), dex: loadDex(storage), cards: CARDS, options }) : ctrl.finished ? V.endHTML(ctrl) : '';
  if (ctrl?.challengeDone) overlay = V.challengeEndHTML(ctrl.challengeDone === 'won', ctrl.challenge);
  if (dexOpen) overlay = V.dexHTML(loadDex(storage), CARDS);
  else if (rulesOpen) overlay = V.rulesHTML();
  else if (achvOpen) overlay = V.achvHTML(loadAchv(storage).unlocked);
  else if (recordsOpen) overlay = V.recordsHTML(loadRecords(storage));
  else if (chalOpen) overlay = V.challengeListHTML(loadChal(storage).completed);
  else if (optionsOpen) overlay = V.optionsHTML(options);
  setHTML('overlay', overlay);
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
  document.querySelectorAll('#supply [data-action="ball"]').forEach((el) =>
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
  const dst = document.querySelector(`.opp[data-id="${ev.player}"]`);
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

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.action) {
    case 'start': startGame(d.name); return;
    case 'resume': resumeGame(); return;
    case 'dex': dexOpen = true; break;
    case 'dex-close': dexOpen = false; break;
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
    case 'restart': ctrl = null; tutorial = null; optionsOpen = false; clearTimeout(aiTimer); aiTimer = null; break;
    case 'tutorial': startTutorial(); return;
    case 'tut-next': tutAdvance(); return;
    case 'tut-done': tutorial = null; break;
    case 'tut-skip': tutorial = null; break;
    case 'ball': ctrl.toggleBall(d.color); break;
    case 'clear': ctrl.clearSelection(); break;
    case 'confirm-balls': {
      const colors = [...ctrl.balls];
      const snap = snapshotMovables();
      ctrl.confirmBalls();
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
      ctrl.buy(d.card);
      if (tutorial && tutorial.step === 1) tutorial.step = 2;
      render();
      flyClone(snap.get('card:' + d.card), document.getElementById('me'));
      return;
    }
    case 'reserve': {
      const snap = snapshotMovables();
      ctrl.reserveCard(d.card);
      if (tutorial && tutorial.step === 1) tutorial.step = 2;
      render();
      flyClone(snap.get('card:' + d.card), document.getElementById('me'));
      return;
    }
    case 'reserve-deck': ctrl.reserveDeck(d.tier); break;
    case 'discard': ctrl.toggleDiscard(d.token); break;
    case 'undiscard': ctrl.undoDiscard(d.token); break;
    case 'confirm-discard': ctrl.confirmDiscard(); break;
    case 'evolve': ctrl.evolve(d.card); break;
    case 'skip-evolve': ctrl.skipEvolve(); break;
    case 'pass': ctrl.pass(); break;
    default: return;
  }
  render();
});

render();
