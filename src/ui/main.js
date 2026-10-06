// DOM glue: renders controller state into regions, wires taps, and paces AI turns.

import { CARDS } from '../data/cards.js';
import { createController } from './controller.js';
import * as V from './view.js';
import { browserStorage, loadDex, loadSave, saveGame, clearSave, recordCatch, recordGame } from '../storage/store.js';

const params = new URLSearchParams(location.search);
const AI_DELAY = params.has('fast') ? 0 : 800; // ?fast=1 skips the pacing delay (tests)
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
    if (ctrl) ctrl.stepAI();
    render();
  }, AI_DELAY);
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
    case 'confirm-balls': ctrl.confirmBalls(); break;
    case 'card': ctrl.openCard(d.card); break;
    case 'deck': ctrl.openDeck(d.tier); break;
    case 'close': ctrl.closeSheet(); break;
    case 'buy': ctrl.buy(d.card); break;
    case 'reserve': ctrl.reserveCard(d.card); break;
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
