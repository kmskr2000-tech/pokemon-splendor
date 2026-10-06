// Heuristic opponent (design doc section 3). Single difficulty, no lookahead.
// Interface contract: chooseAction(state, rnd?) -> engine action for the current player.
// Works in every phase (action / discard / evolve); the UI drives AI turns with it.
// Turn pacing (0.8s) lives in ui/main.js (AI_DELAY), not here.

import { COLORS, MASTER, TOKEN_KEYS, PHASES, MAX_TOKENS, MAX_HAND, TIER_KEYS } from '../core/constants.js?v=1791269366';
import {
  legalActions, getCurrentPlayer, getBonuses, bonusList, isSpecial, evolveOptions, tokenCount,
} from '../core/engine.js?v=1791269366';

const BASE_JITTER = 0.01; // breaks exact ties so the three AIs do not play identically

// Opponent color needs (for hard difficulty denial): what each rival's current
// target still lacks, capped at 2 per color.
function opponentWant(state, selfIdx) {
  const want = Object.fromEntries(COLORS.map((c) => [c, 0]));
  state.players.forEach((p, i) => {
    if (i === selfIdx) return;
    const bonuses = getBonuses(p);
    const target = pickTarget(state, p, bonuses, () => 0.5, 0);
    if (!target) return;
    const d = deficits(p, target, bonuses);
    for (const c of COLORS) want[c] += Math.min(2, d[c]);
  });
  return want;
}

// Can `p` afford `card` right now (master balls cover any shortfall)?
function canAfford(p, card) {
  const b = getBonuses(p);
  let short = 0;
  for (const c of COLORS) short += Math.max(0, (card.cost[c] || 0) - b[c] - p.tokens[c]);
  if (isSpecial(card)) return short <= p.tokens[MASTER] - 1 && p.tokens[MASTER] >= 1;
  return short <= p.tokens[MASTER];
}

// ---------- AI personalities ----------
// specialized: commits to 2 focus colors (seat-derived, stable per game).
// opportunistic: hate-drafts cards rivals can afford, denies balls they need.
// balanced: the plain heuristic. 'random' assigns per seat deterministically.

const PERSONALITIES = ['specialized', 'opportunistic', 'balanced'];

function resolvePersonality(state, personality) {
  if (!PERSONALITIES.includes(personality)) return PERSONALITIES[state.current % PERSONALITIES.length];
  return personality;
}

function focusColors(seat) {
  return [COLORS[seat % COLORS.length], COLORS[(seat + 2) % COLORS.length]];
}

// 1 when a rival could buy `card` right now (hate-draft signal), else 0.
function deniedValue(state, card) {
  for (let i = 0; i < state.players.length; i++) {
    if (i === state.current) continue;
    if (canAfford(state.players[i], card)) return 1;
  }
  return 0;
}

// A table card worth >=2 points that a rival could buy on their next turn
// (used by hard difficulty and the opportunistic personality).
function threatenedCard(state) {
  for (const card of tableCards(state)) {
    if (card.points < 2) continue;
    for (let i = 0; i < state.players.length; i++) {
      if (i === state.current) continue;
      if (canAfford(state.players[i], card)) return card;
    }
  }
  return null;
}

const tableCards = (state) => TIER_KEYS.flatMap((k) => state.table[k].filter(Boolean));
const cardById = (state, player, id) => [...player.hand, ...player.tableau, ...tableCards(state)].find((c) => c.id === id);

// Per-color number of balls still missing to afford `card` (master balls not counted).
function deficits(player, card, bonuses) {
  const out = {};
  for (const c of COLORS) out[c] = Math.max(0, (card.cost[c] || 0) - bonuses[c] - player.tokens[c]);
  return out;
}

// Balls still needed (any color) before `card` is affordable, never below 1.
function remainingCost(player, card, bonuses) {
  const missing = Object.values(deficits(player, card, bonuses)).reduce((a, b) => a + b, 0);
  return Math.max(1, missing + (isSpecial(card) ? 1 : 0) - player.tokens[MASTER]);
}

// How much of `color` the cards on the table and in hand still ask for, net of owned bonuses.
function demandByColor(state, player, bonuses) {
  const demand = Object.fromEntries(COLORS.map((c) => [c, 0]));
  for (const card of [...player.hand, ...tableCards(state)]) {
    for (const c of COLORS) demand[c] += Math.max(0, (card.cost[c] || 0) - bonuses[c]);
  }
  return demand;
}

// Share of the remaining demand a bonus color would remove (0..1 per bonus).
function bonusValue(card, demand) {
  const total = COLORS.reduce((a, c) => a + demand[c], 0) || 1;
  return bonusList(card).reduce((sum, b) => sum + 1 + demand[b] / total, 0);
}

function canEvolveLater(state, player, card) {
  if (!card.evolvesTo) return false;
  return [...player.hand, ...tableCards(state)].some((c) => c.id === card.evolvesTo);
}

// Design 3.1-1: points x 10 + bonus value x 3 + 5 when the card can evolve.
function cardValue(state, player, card, demand) {
  return card.points * 10 + bonusValue(card, demand) * 3 + (canEvolveLater(state, player, card) ? 5 : 0);
}

// Design 3.1-2: (points + bonus x 2) / remaining cost, over table + hand.
function pickTarget(state, player, bonuses, rnd, jit) {
  let best = null;
  for (const card of [...player.hand, ...tableCards(state)]) {
    const score = (card.points + bonusList(card).length * 2) / remainingCost(player, card, bonuses) + rnd() * jit;
    if (!best || score > best.score) best = { card, score };
  }
  return best?.card ?? null;
}

function chooseBuy(state, player, legal, rnd, jit, pers) {
  const buys = legal.filter((a) => a.type === 'buy');
  if (!buys.length) return null;
  const bonuses = getBonuses(player);
  const demand = demandByColor(state, player, bonuses);
  const focus = pers === 'specialized' ? focusColors(state.current) : null;
  let best = null;
  for (const action of buys) {
    const card = cardById(state, player, action.cardId);
    const spent = TOKEN_KEYS.reduce((a, k) => a + (action.payment[k] || 0), 0);
    let score = cardValue(state, player, card, demand) - spent * 0.1 - action.payment[MASTER] * 0.3 + rnd() * jit;
    if (focus) score += bonusList(card).filter((b) => focus.includes(b)).length * 2;
    if (pers === 'opportunistic') score += deniedValue(state, card) * 3; // hate-draft
    if (!best || score > best.score) best = { action, score };
  }
  return best.action;
}

function chooseTake(state, player, legal, target, bonuses, rnd, jit, difficulty, pers) {
  const takes = legal.filter((a) => a.type === 'takeBalls' || a.type === 'takeTwo');
  if (!takes.length) return null;
  const want = target ? deficits(player, target, bonuses) : Object.fromEntries(COLORS.map((c) => [c, 0]));
  const demand = demandByColor(state, player, bonuses);
  const held = tokenCount(player);
  const opp = (difficulty === 'hard' || pers === 'opportunistic') ? opponentWant(state, state.current) : null;
  const focus = pers === 'specialized' ? focusColors(state.current) : null;
  let best = null;
  for (const action of takes) {
    const got = action.type === 'takeTwo' ? { [action.color]: 2 } : Object.fromEntries(action.colors.map((c) => [c, 1]));
    let score = 0;
    let count = 0;
    for (const [c, n] of Object.entries(got)) {
      score += Math.min(n, want[c]) * 10 + demand[c] * 0.1; // target first, other cards as tie-break
      if (opp) score += Math.min(n, opp[c]) * 0.8; // hard/opportunistic: deny rivals the balls they need
      if (focus && focus.includes(c)) score += n * 1.5; // specialized: commit to focus colors
      count += n;
    }
    if (action.type === 'takeTwo' && want[action.color] < 2) score -= 3; // two of a color nobody needs
    score -= Math.max(0, held + count - MAX_TOKENS) * 2; // would force a discard
    score += rnd() * jit;
    if (!best || score > best.score) best = { action, score };
  }
  return best.action;
}

// Design 3.1-3: reserve only when a master ball is what the (rare / legend) target lacks.
// Hard also denies a rival's imminent buy of a valuable table card.
function chooseReserve(state, player, legal, target, bonuses, rnd, jit, difficulty, pers) {
  const reserves = legal.filter((a) => a.type === 'reserve');
  if (!reserves.length || player.hand.length >= MAX_HAND || state.supply[MASTER] < 1) return null;
  if (difficulty === 'hard' || pers === 'opportunistic') {
    const threat = threatenedCard(state);
    if (threat) {
      const denial = reserves.find((a) => a.source === 'table' && a.cardId === threat.id);
      if (denial) return denial;
    }
  }
  if (!target || !isSpecial(target)) return null;
  const missingMasters = Math.max(0, Object.values(deficits(player, target, bonuses)).reduce((a, b) => a + b, 0) + 1 - player.tokens[MASTER]);
  if (missingMasters < 1) return null;
  return bestReserve(state, player, reserves, bonuses, rnd, jit);
}

// Prefers the table card with the best target score; blind deck draws only when no table card exists.
function bestReserve(state, player, reserves, bonuses, rnd, jit) {
  let best = null;
  for (const action of reserves) {
    const card = action.source === 'table' ? cardById(state, player, action.cardId) : null;
    const score = card
      ? (card.points + bonusList(card).length * 2) / remainingCost(player, card, bonuses) + 1 + rnd() * jit
      : rnd() * jit;
    if (!best || score > best.score) best = { action, score };
  }
  return best.action;
}

// Design 3.1-4: the evolution with the biggest point gain; skip when nothing gains.
// Easy sometimes skips even a good evolve (beginner mistake).
function chooseEvolve(state, player, legal, difficulty, rnd) {
  if (difficulty === 'easy' && rnd() < 0.3) return { type: 'skipEvolve' };
  let best = null;
  for (const option of evolveOptions(state, player)) {
    const old = player.tableau.find((c) => c.id === option.cardId);
    const next = cardById(state, player, option.nextId);
    const gain = next.points - old.points;
    if (gain > 0 && (!best || gain > best.gain)) best = { gain, action: legal.find((a) => a.type === 'evolve' && a.cardId === option.cardId) };
  }
  return best?.action ?? { type: 'skipEvolve' };
}

// Design 3.1-5: return colors the target does not need first; master balls last.
function chooseDiscard(state, player, count, rnd, jit) {
  const bonuses = getBonuses(player);
  const target = pickTarget(state, player, bonuses, rnd, jit);
  const need = Object.fromEntries(COLORS.map((c) => [c, target ? Math.max(0, (target.cost[c] || 0) - bonuses[c]) : 0]));
  const demand = demandByColor(state, player, bonuses);
  const left = { ...player.tokens };
  const out = {};
  for (let i = 0; i < count; i++) {
    let worst = null;
    for (const k of TOKEN_KEYS) {
      if (left[k] < 1) continue;
      const keep = k === MASTER ? 1000 : (left[k] <= need[k] ? 100 : 0) + demand[k] * 0.1 - left[k] * 0.5 + rnd() * jit;
      if (!worst || keep < worst.keep) worst = { k, keep };
    }
    left[worst.k] -= 1;
    out[worst.k] = (out[worst.k] || 0) + 1;
  }
  return out;
}

export function chooseAction(state, rnd = Math.random, difficulty = 'normal', personality = 'random') {
  const jit = difficulty === 'easy' ? 2.0 : difficulty === 'hard' ? 0 : BASE_JITTER;
  const pers = resolvePersonality(state, personality);
  const player = getCurrentPlayer(state);
  const legal = legalActions(state);

  if (state.phase === PHASES.DISCARD) return { type: 'discard', tokens: chooseDiscard(state, player, legal[0].count, rnd, jit) };
  if (state.phase === PHASES.EVOLVE) return chooseEvolve(state, player, legal, difficulty, rnd);

  const buy = chooseBuy(state, player, legal, rnd, jit, pers);
  if (buy) return buy;

  const bonuses = getBonuses(player);
  const target = pickTarget(state, player, bonuses, rnd, jit);
  const reserve = chooseReserve(state, player, legal, target, bonuses, rnd, jit, difficulty, pers);
  if (reserve) return reserve;

  const take = chooseTake(state, player, legal, target, bonuses, rnd, jit, difficulty, pers);
  if (take) return take;

  // Supply has no colors left: reserving is the only productive move, otherwise pass.
  const reserves = legal.filter((a) => a.type === 'reserve');
  return reserves.length ? bestReserve(state, player, reserves, bonuses, rnd, jit) : legal[0];
}
