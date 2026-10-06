// DOM glue: renders controller state into regions, wires taps, and paces AI turns.

import { CARDS } from '../data/cards.js';
import { createController } from './controller.js';
import * as V from './view.js';
import { browserStorage, loadDex, loadSave, saveGame, clearSave, recordCatch, recordGame } from '../storage/store.js';

const params = new URLSearchParams(location.search);
const AI_DELAY = params.has('fast') ? 0 : 1600; // ?fast=1 skips the pacing delay (tests)
const AI_NAMES = ['지우', '이슬', '웅이', '레드'];

const regions = {
  header: ['header', V.headerHTML],
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
const storage = browserStorage();

const $ = (id) => document.getElementById(id);

function setHTML(id, html) {
  if (cache[id] === html) return; // keeps animated sprites from restarting needlessly
  cache[id] = html;
  $(id).innerHTML = html;
}

function render() {
  if (ctrl) for (const [id, fn] of Object.values(regions)) setHTML(id, fn(ctrl));
  let overlay = !ctrl ? V.startHTML({ save: loadSave(storage, CARDS), dex: loadDex(storage), cards: CARDS }) : ctrl.finished ? V.endHTML(ctrl) : '';
  if (dexOpen) overlay = V.dexHTML(loadDex(storage), CARDS);
  else if (rulesOpen) overlay = V.rulesHTML();
  setHTML('overlay', overlay);
  scheduleAI();
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

const hooks = {
  onCatch: (cardId, kind) => recordCatch(storage, cardId, kind),
  onChange: () => { if (ctrl && !ctrl.finished) saveGame(storage, ctrl.snapshot()); },
  onEnd: (won) => { recordGame(storage, won); clearSave(storage); },
};

function resumeGame() {
  const save = loadSave(storage, CARDS);
  if (!save) return;
  ctrl = createController({ cards: CARDS, seed: save.seed, humanName: save.humanName, aiNames: save.aiNames, resume: { game: save.game, log: save.log }, hooks });
  Object.keys(cache).forEach((k) => delete cache[k]);
  window.__ctrl = ctrl;
  render();
}

function startGame(humanName) {
  const seedParam = params.get('seed');
  const seed = seedParam !== null ? Number(seedParam) : (crypto.getRandomValues(new Uint32Array(1))[0] || 1);
  const aiNames = AI_NAMES.filter((n) => n !== humanName).slice(0, 3);
  clearSave(storage); // a new game replaces any saved one
  ctrl = createController({ cards: CARDS, seed, humanName, aiNames, hooks });
  saveGame(storage, ctrl.snapshot());
  Object.keys(cache).forEach((k) => delete cache[k]);
  window.__ctrl = ctrl; // debugging / automated tests
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
    case 'opp': ctrl.openOpp(d.id); break;
    case 'restart': ctrl = null; clearTimeout(aiTimer); aiTimer = null; break;
    case 'ball': ctrl.toggleBall(d.color); break;
    case 'clear': ctrl.clearSelection(); break;
    case 'confirm-balls': {
      const colors = [...ctrl.balls];
      const snap = snapshotMovables();
      ctrl.confirmBalls();
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
      render();
      flyClone(snap.get('card:' + d.card), document.getElementById('me'));
      return;
    }
    case 'reserve': {
      const snap = snapshotMovables();
      ctrl.reserveCard(d.card);
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
