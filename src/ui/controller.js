// UI controller: holds the engine state plus transient selection state. No DOM access here,
// so it can be unit-tested and driven headlessly. All rules live in the engine; this layer
// only translates taps into engine actions and surfaces engine error codes.

import {
  COLORS, MASTER, PHASES, MAX_HAND,
  createGame, applyAction, legalActions, computePayment, evolveOptions, getCurrentPlayer, tokenCount,
} from '../core/index.js';
import { chooseAction } from '../ai/heuristic.js';

export const BALLS = {
  monster: { file: 'poke-ball', name: '몬스터볼', short: '몬스터' },
  super: { file: 'great-ball', name: '슈퍼볼', short: '슈퍼' },
  hyper: { file: 'ultra-ball', name: '하이퍼볼', short: '하이퍼' },
  heal: { file: 'heal-ball', name: '힐볼', short: '힐' },
  quick: { file: 'quick-ball', name: '퀵볼', short: '퀵' },
  master: { file: 'master-ball', name: '마스터볼', short: '마스터' },
};

export const TRAINERS = ['지우', '이슬', '웅이', '레드'];

const ERROR_TEXT = {
  bad_ball_count: '서로 다른 볼 3개를 골라주세요 (남은 종류가 적으면 그만큼만).',
  supply_empty: '공급처에 없는 볼이에요.',
  supply_too_low: '같은 볼 2개는 공급처에 4개 이상 남아야 해요.',
  hand_full: '찜한 카드는 최대 3장이에요.',
  cannot_reserve: '희귀·전설 카드는 찜할 수 없어요.',
  deck_empty: '덱에 카드가 없어요.',
  cannot_afford: '볼이 부족해서 잡을 수 없어요.',
  master_required: '희귀·전설은 마스터볼이 1개 필요해요.',
  bad_discard_count: '반환할 개수가 맞지 않아요.',
  discard_full: '필요한 개수를 다 골랐어요. 바꾸려면 − 로 줄이세요.',
  discard_owned: '가진 볼보다 많이 반환할 수 없어요.',
  cannot_evolve: '진화할 수 없어요.',
  pass_not_allowed: '아직 할 수 있는 행동이 있어요.',
};

export const errorText = (code) => ERROR_TEXT[code] ?? `실행할 수 없어요 (${code})`;

// `resume` ({ game, log }) restores a saved game instead of dealing a new one.
// `hooks.onCatch(cardId, kind)` fires for the human's captures/evolutions, `hooks.onChange()` after
// every accepted action, `hooks.onEnd(won)` once when the game finishes (persistence lives outside).
export function createController({ cards, seed, humanName = '나', aiNames = ['지우', '이슬', '웅이'], resume = null, hooks = {} }) {
  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const game = resume?.game ?? createGame({
    cards,
    seed,
    players: [{ name: humanName, isAI: false }, ...aiNames.map((name) => ({ name, isAI: true }))],
  });

  const ctrl = {
    game,
    cardsById,
    human: 0,
    balls: [], // selected supply colors (a repeated color means "take two")
    discard: {}, // token map selected for return
    sheet: null, // { kind: 'card', cardId } | { kind: 'deck', tier }
    message: '', // last engine error shown in the hint bar
    log: resume?.log ? resume.log.slice(-6) : [], // recent human-readable events, newest last
    seed,
    humanName,
    aiNames,
    errors: 0, // failed applyAction calls (tests assert 0 for UI-generated actions)

    get state() { return this.game; },
    get me() { return this.game.players[this.human]; },
    get current() { return getCurrentPlayer(this.game); },
    get finished() { return this.game.phase === PHASES.FINISHED; },
    get isHumanTurn() { return !this.finished && this.game.current === this.human; },
    get lastRound() { return this.game.endTriggeredBy !== null && !this.finished; },
    get discardNeed() { return Math.max(0, tokenCount(this.me) - 10); },

    // ---- queries used by the view ----
    pendingAction() {
      const b = this.balls;
      if (b.length === 0) return null;
      if (b.length === 2 && b[0] === b[1]) return { type: 'takeTwo', color: b[0] };
      return { type: 'takeBalls', colors: [...b] };
    },
    pendingValid() {
      const a = this.pendingAction();
      return !!a && this.isHumanTurn && this.game.phase === PHASES.ACTION && applyAction(this.game, a).ok;
    },
    pendingError() {
      const a = this.pendingAction();
      if (!a) return null;
      const res = applyAction(this.game, a);
      return res.ok ? null : res.error;
    },
    canPass() {
      const legal = legalActions(this.game);
      return this.isHumanTurn && this.game.phase === PHASES.ACTION && legal.length === 1 && legal[0].type === 'pass';
    },
    payment(cardId) {
      const card = this.cardsById.get(cardId);
      return card ? computePayment(this.me, card) : null;
    },
    canBuy(cardId) {
      return this.isHumanTurn && this.game.phase === PHASES.ACTION && !!this.payment(cardId);
    },
    canReserve() {
      return this.isHumanTurn && this.game.phase === PHASES.ACTION && this.me.hand.length < MAX_HAND;
    },
    evolveChoices() {
      return this.isHumanTurn && this.game.phase === PHASES.EVOLVE ? evolveOptions(this.game, this.me) : [];
    },
    evolvableIds() {
      return new Set(evolveOptions(this.game, this.me).map((o) => o.cardId));
    },
    discardCount() {
      return Object.values(this.discard).reduce((a, b) => a + b, 0);
    },
    zone(cardId) {
      if (this.me.hand.some((c) => c.id === cardId)) return 'hand';
      return 'table';
    },

    // ---- selection ----
    toggleBall(color) {
      if (!this.isHumanTurn || this.game.phase !== PHASES.ACTION || color === MASTER) return;
      this.message = '';
      this.sheet = null;
      const supply = this.game.supply[color];
      const b = this.balls;
      const isTwo = b.length === 2 && b[0] === b[1];
      if (isTwo) {
        this.balls = b[0] === color ? [] : supply > 0 ? [color] : [];
        if (b[0] !== color && supply === 0) this.message = errorText('supply_empty');
        return;
      }
      if (b.includes(color)) {
        if (b.length === 1 && supply >= 4) this.balls = [color, color];
        else this.balls = b.filter((c) => c !== color);
        return;
      }
      if (supply < 1) { this.message = errorText('supply_empty'); return; }
      if (b.length >= 3) { this.message = errorText('bad_ball_count'); return; }
      this.balls = [...b, color];
    },
    clearSelection() {
      this.balls = [];
      this.discard = {};
      this.message = '';
    },
    // Tap = +1 (never wraps back to 0 — that surprised players). `undoDiscard` takes one back.
    toggleDiscard(token) {
      if (!this.isHumanTurn || this.game.phase !== PHASES.DISCARD) return;
      const owned = this.me.tokens[token];
      const cur = this.discard[token] || 0;
      if (this.discardCount() >= this.discardNeed) { this.message = errorText('discard_full'); return; }
      if (cur >= owned) { this.message = errorText('discard_owned'); return; }
      this.message = '';
      this.discard = { ...this.discard, [token]: cur + 1 };
    },
    undoDiscard(token) {
      if (!this.isHumanTurn || this.game.phase !== PHASES.DISCARD) return;
      const cur = this.discard[token] || 0;
      if (cur > 0) this.discard = { ...this.discard, [token]: cur - 1 };
      this.message = '';
    },

    openCard(cardId) {
      if (!this.isHumanTurn || this.game.phase !== PHASES.ACTION) return;
      this.balls = [];
      this.message = '';
      this.sheet = { kind: 'card', cardId };
    },
    openDeck(tier) {
      if (!this.isHumanTurn || this.game.phase !== PHASES.ACTION) return;
      this.balls = [];
      this.message = '';
      this.sheet = { kind: 'deck', tier };
    },
    openOpp(playerId) {
      this.sheet = { kind: 'opp', playerId: Number(playerId) };
    },
    closeSheet() { this.sheet = null; },

    // ---- actions (all go through the engine) ----
    dispatch(action) {
      const res = applyAction(this.game, action);
      if (!res.ok) {
        this.errors += 1;
        this.message = errorText(res.error);
        return res;
      }
      this.game = res.state;
      this.balls = [];
      this.discard = {};
      this.sheet = null;
      this.message = '';
      for (const ev of res.events) {
        const line = describeEvent(ev, this);
        if (line) this.log.push(line);
      }
      if (this.log.length > 6) this.log = this.log.slice(-6);
      for (const ev of res.events) {
        if (ev.player !== this.human) continue;
        if (ev.type === 'buy') hooks.onCatch?.(ev.cardId, 'buy');
        else if (ev.type === 'evolve') hooks.onCatch?.(ev.to, 'evolve');
      }
      if (this.finished) hooks.onEnd?.(this.game.ranking[0].player === this.human);
      hooks.onChange?.();
      return res;
    },
    confirmBalls() { const a = this.pendingAction(); return a ? this.dispatch(a) : null; },
    buy(cardId) { return this.dispatch({ type: 'buy', cardId }); },
    reserveCard(cardId) {
      const card = this.cardsById.get(cardId);
      return this.dispatch({ type: 'reserve', tier: Number(card.tier), source: 'table', cardId });
    },
    reserveDeck(tier) { return this.dispatch({ type: 'reserve', tier: Number(tier), source: 'deck' }); },
    confirmDiscard() { return this.dispatch({ type: 'discard', tokens: { ...this.discard } }); },
    evolve(cardId) { return this.dispatch({ type: 'evolve', cardId }); },
    skipEvolve() { return this.dispatch({ type: 'skipEvolve' }); },
    pass() { return this.dispatch({ type: 'pass' }); },

    snapshot() {
      return { seed: this.seed, humanName: this.humanName, aiNames: this.aiNames, log: this.log, game: this.game };
    },

    // One opponent action. Returns false when it is not an AI turn.
    stepAI(rnd) {
      if (this.finished || this.game.players[this.game.current].isAI !== true) return false;
      this.dispatch(chooseAction(this.game, rnd));
      return true;
    },
  };
  return ctrl;
}

export function evoText(card, cardsById) {
  if (!card.evolvesTo) {
    if (card.tier === 'rare' || card.tier === 'legend') return '보너스 2개 · 마스터볼 필수';
    return card.tier === 3 ? '최종 진화' : '진화 없음';
  }
  const next = cardsById.get(card.evolvesTo);
  const req = COLORS.filter((c) => card.evolveReq?.[c]).map((c) => `${BALLS[c].short} 보너스 ${card.evolveReq[c]}`).join(' ');
  return `→ ${next?.name ?? '?'}<br>(${req})`;
}

export function describeEvent(ev, ctrl) {
  const who = ctrl.game.players[ev.player]?.name;
  const name = (id) => ctrl.cardsById.get(id)?.name ?? id;
  const balls = (map) => COLORS.concat(MASTER).filter((k) => map[k]).map((k) => `${BALLS[k].name}${map[k] > 1 ? ` ${map[k]}` : ''}`).join('·');
  switch (ev.type) {
    case 'takeBalls': return `${who}: ${ev.colors.map((c) => BALLS[c].name).join('·')} 가져감`;
    case 'takeTwo': return `${who}: ${BALLS[ev.color].name} 2개 가져감`;
    case 'reserve': return `${who}: ${ev.source === 'deck' ? '덱 위 카드를' : `${name(ev.cardId)}을(를)`} 찜`;
    case 'buy': return `${who}: ${name(ev.cardId)} 잡음!`;
    case 'discard': return `${who}: ${balls(ev.tokens)} 반환`;
    case 'evolve': return `${who}: ${name(ev.from)} → ${name(ev.to)} 진화!`;
    case 'pass': return `${who}: 차례 넘김`;
    case 'endTriggered': return `${who}가 18점 달성! 마지막 라운드`;
    case 'gameEnd': return '게임 종료';
    default: return null;
  }
}
