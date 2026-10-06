// Pure HTML-string renderers. Each takes the controller and returns markup; main.js owns the DOM.
// All text interpolated here comes from our own card data / constants (no user input).

import { COLORS, MASTER, PHASES, TOKEN_KEYS } from '../core/constants.js';
import { getBonuses, getPoints, tokenCount, bonusList, isSpecial } from '../core/engine.js';
import { BALLS, TRAINERS, evoText } from './controller.js';
import { dexSummary } from '../storage/store.js';

const ASSET = 'assets';
export const ballSrc = (key) => `${ASSET}/items/${BALLS[key].file}.png`;
const pokeSrc = (dex) => `${ASSET}/pokemon/${dex}.png`;
const animSrc = (dex) => `${ASSET}/anim/${dex}.gif`;

const ballImg = (key, cls = 'miniball') => `<img class="${cls}" src="${ballSrc(key)}" alt="${BALLS[key].name}">`;
const staticSprite = (card, cls = 'tiny') => `<img class="${cls}" src="${pokeSrc(card.dex)}" alt="">`;
const animSprite = (card) =>
  `<img class="sprite" src="${animSrc(card.dex)}" onerror="this.onerror=null;this.src='${pokeSrc(card.dex)}'" alt="${card.name}">`;

const tierLabel = { 1: '1단계', 2: '2단계', 3: '3단계', rare: '희귀', legend: '전설' };

// ---------- cards ----------

export function cardHTML(card, ctrl, { zone = 'table', buyable = false, animated = true, interactive = true } = {}) {
  const bonuses = bonusList(card);
  const special = isSpecial(card);
  const cost = COLORS.filter((c) => card.cost[c])
    .map((c) => `<span class="costchip">${ballImg(c)}${card.cost[c]}</span>`).join('')
    + (special ? `<span class="costchip">${ballImg(MASTER)}1</span>` : '');
  const classes = ['card', `b-${bonuses[0]}`, special ? card.tier : '', buyable ? 'buyable' : ''].filter(Boolean).join(' ');
  const tag = special ? `<span class="tag ${card.tier}">${tierLabel[card.tier]}</span><br>` : '';
  const attrs = interactive ? `data-action="card" data-card="${card.id}" data-zone="${zone}"` : 'disabled';
  return `<button class="${classes}" ${attrs}>
    ${card.points ? `<span class="pts">${card.points}</span>` : ''}
    <span class="bonusicons">${bonuses.map((b) => ballImg(b, 'bonusdotimg')).join('')}</span>
    ${animated ? animSprite(card) : `<img class="sprite" src="${pokeSrc(card.dex)}" alt="${card.name}">`}
    <span class="nm">${tag}${card.name}</span>
    <span class="cost">${cost}</span>
    <span class="evo">${evoText(card, ctrl.cardsById)}</span>
  </button>`;
}

const emptySlot = () => '<div class="card empty"></div>';

function tierRow(ctrl, key) {
  const s = ctrl.state;
  const reservableDeck = ['1', '2', '3'].includes(key);
  const deckN = s.decks[key].length;
  const canDeck = reservableDeck && ctrl.canReserve() && deckN > 0;
  const deck = `<button class="deck px" ${canDeck ? `data-action="deck" data-tier="${key}"` : 'disabled'}>
      <b>${deckN}</b>${tierLabel[key]}</button>`;
  const cards = s.table[key].map((card) => (card ? cardHTML(card, ctrl, { buyable: ctrl.canBuy(card.id) }) : emptySlot())).join('');
  return { deck, cards };
}

export function boardHTML(ctrl) {
  const rows = ['3', '2', '1'].map((key) => {
    const { deck, cards } = tierRow(ctrl, key);
    return `<div class="tier-row">${deck}<div class="cards">${cards}</div></div>`;
  }).join('');
  const rare = tierRow(ctrl, 'rare');
  const legend = tierRow(ctrl, 'legend');
  return `${rows}<div class="tier-row special">
    <div class="half">${rare.deck}<div class="cards">${rare.cards}</div></div>
    <div class="half">${legend.deck}<div class="cards">${legend.cards}</div></div>
  </div>`;
}

// ---------- header / opponents ----------

export function headerHTML(ctrl) {
  const s = ctrl.state;
  let badge;
  if (ctrl.finished) badge = '게임 종료';
  else if (ctrl.isHumanTurn) badge = '▶ 당신의 차례';
  else badge = `${ctrl.current.name} 차례`;
  const last = ctrl.lastRound ? `<div class="lastround">마지막 라운드! ${s.players[s.endTriggeredBy].name}이(가) 18점 달성</div>` : '';
  return `<div class="header">
      <div class="title">포켓몬 스플렌더<small>POKEMON SPLENDOR · DOT EDITION</small></div>
      <div class="turn ${ctrl.isHumanTurn ? 'mine' : ''}">${badge}</div>
    </div>${last}`;
}

const bonusPips = (p) => {
  const b = getBonuses(p);
  return COLORS.map((c) => `<span class="pip d-${c}" title="${BALLS[c].name}">${b[c]}</span>`).join('');
};

export function opponentsHTML(ctrl) {
  const s = ctrl.state;
  return s.players.filter((p) => p.id !== ctrl.human).map((p) => `
    <div class="opp px ${s.current === p.id && !ctrl.finished ? 'active' : ''}">
      <div class="nm">AI ${p.name}</div>
      <div class="sc">${getPoints(p)}</div>
      <div class="pips">${bonusPips(p)}</div>
      <div class="meta">볼 ${tokenCount(p)}개 · 찜 ${p.hand.length}<br>포켓몬 ${p.tableau.length}마리</div>
    </div>`).join('');
}

// ---------- supply ----------

export function supplyHTML(ctrl) {
  const s = ctrl.state;
  const sel = (c) => ctrl.balls.filter((x) => x === c).length;
  const canPick = ctrl.isHumanTurn && s.phase === PHASES.ACTION;
  return TOKEN_KEYS.map((k) => {
    const n = sel(k);
    const empty = s.supply[k] === 0;
    const pickable = canPick && k !== MASTER;
    return `<button class="ball ${n ? 'sel' : ''} ${empty ? 'empty' : ''}" ${pickable ? `data-action="ball" data-color="${k}"` : 'disabled'}>
      <span class="ballwrap">${ballImg(k, 'ballspr')}${n ? `<span class="selcount">×${n}</span>` : ''}</span>
      <span class="bnm">${BALLS[k].name}</span><span class="cnt">${s.supply[k]}개</span></button>`;
  }).join('');
}

// ---------- my area ----------

function tokensHTML(ctrl) {
  const me = ctrl.me;
  const discarding = ctrl.isHumanTurn && ctrl.state.phase === PHASES.DISCARD;
  return TOKEN_KEYS.map((k) => {
    const d = ctrl.discard[k] || 0;
    const attr = discarding && me.tokens[k] > 0 ? `data-action="discard" data-token="${k}"` : 'disabled';
    const minus = discarding && d ? `<button class="tkminus" data-action="undiscard" data-token="${k}" aria-label="${BALLS[k].name} 반환 취소">−</button>` : '';
    return `<span class="tkwrap"><button class="mytk ${d ? 'dsel' : ''}" ${attr}>${ballImg(k, 'mytkimg')}<span>${me.tokens[k]}</span>${d ? `<em>-${d}</em>` : ''}</button>${minus}</span>`;
  }).join('');
}

function tableauHTML(ctrl) {
  const me = ctrl.me;
  if (!me.tableau.length) return '<div class="empty-note">아직 잡은 포켓몬이 없어요</div>';
  const evolvable = ctrl.evolvableIds();
  const groups = COLORS.map((c) => {
    const list = me.tableau.filter((card) => bonusList(card)[0] === c);
    if (!list.length) return '';
    return `<div class="grp g-${c}">${list.map((card) => `
      <span class="mp ${evolvable.has(card.id) ? 'evolvable' : ''}">${staticSprite(card)}
        <span>${card.name}${card.points ? ` <i>${card.points}점</i>` : ''}</span>
        ${bonusList(card).map((b) => ballImg(b, 'mini2')).join('')}
        ${evolvable.has(card.id) ? '<span class="ev">진화 가능!</span>' : ''}</span>`).join('')}</div>`;
  });
  return groups.join('');
}

function handHTML(ctrl) {
  const me = ctrl.me;
  if (!me.hand.length) return '<div class="empty-note">찜한 카드 없음 (최대 3장)</div>';
  return me.hand.map((card) => `
    <button class="rsv ${ctrl.canBuy(card.id) ? 'buyable' : ''}" data-action="card" data-card="${card.id}" data-zone="hand" ${ctrl.isHumanTurn ? '' : 'disabled'}>
      ${staticSprite(card)}${card.name} <small>${tierLabel[card.tier]}${card.points ? ` · ${card.points}점` : ''}</small></button>`).join('');
}

export function meHTML(ctrl) {
  const me = ctrl.me;
  const b = getBonuses(me);
  return `<div class="row1">
      <div class="who">${me.name}<span class="sc">${getPoints(me)}점</span></div>
      <div class="evcount">진화 ${me.evolved.length}회</div>
    </div>
    <div class="mytokens">${tokensHTML(ctrl)}</div>
    <div class="lbl">■ 보너스 (할인)</div>
    <div class="pips big">${COLORS.map((c) => `<span class="pip d-${c}">${ballImg(c, 'mini2')}${b[c]}</span>`).join('')}</div>
    <div class="lbl">■ 내 포켓몬 (${me.tableau.length})</div>
    <div class="mypoke">${tableauHTML(ctrl)}</div>
    <div class="lbl">■ 찜한 카드 (${me.hand.length}/3)</div>
    <div class="reserved">${handHTML(ctrl)}</div>`;
}

// ---------- action bar ----------

export function actionBarHTML(ctrl) {
  const s = ctrl.state;
  if (ctrl.finished) return '<div class="hint">게임이 끝났어요.</div>';
  if (!ctrl.isHumanTurn) {
    return `<div class="hint">${ctrl.current.name}이(가) 생각 중…</div>`;
  }
  const err = ctrl.message ? `<div class="hint err">${ctrl.message}</div>` : '';
  if (s.phase === PHASES.DISCARD) {
    const need = ctrl.discardNeed;
    const have = ctrl.discardCount();
    return `<div class="hint">볼이 10개를 넘었어요. 내 볼을 눌러 <b>${need}개</b> 반환하세요. 누를 때마다 +1, 빨간 − 로 되돌려요. (${have}/${need})</div>${err}
      <div class="btnrow"><button class="btn ghost" data-action="clear">초기화</button>
      <button class="btn primary" data-action="confirm-discard" ${have === need ? '' : 'disabled'}>${need}개 반환</button></div>`;
  }
  if (s.phase === PHASES.EVOLVE) {
    const opts = ctrl.evolveChoices().map((o) => {
      const from = ctrl.cardsById.get(o.cardId);
      const to = ctrl.cardsById.get(o.nextId);
      return `<button class="btn evo" data-action="evolve" data-card="${o.cardId}">${from.name} → ${to.name} 진화</button>`;
    }).join('');
    return `<div class="hint evohint">진화할 수 있어요! 한 마리만 골라 진화하거나 건너뛰세요.</div>${err}
      <div class="btnrow col">${opts}<button class="btn ghost" data-action="skip-evolve">진화 안 함</button></div>`;
  }
  if (ctrl.canPass()) {
    return `<div class="hint">할 수 있는 행동이 없어요.</div>
      <div class="btnrow"><button class="btn primary" data-action="pass">차례 넘기기</button></div>`;
  }
  const n = ctrl.balls.length;
  const valid = ctrl.pendingValid();
  const pe = ctrl.pendingError();
  let hint = '볼을 고르거나, 카드를 눌러 잡기·찜하기를 하세요.';
  if (n) {
    const names = ctrl.balls.map((c) => BALLS[c].name).join('·');
    hint = valid ? `${names} 선택! 가져가기를 눌러 턴을 마치세요.` : `${names} 선택 중 — ${pe ? ({ bad_ball_count: '서로 다른 볼을 3개까지 골라주세요.' }[pe] ?? '') : ''}`;
  }
  const label = n === 2 && ctrl.balls[0] === ctrl.balls[1] ? `${BALLS[ctrl.balls[0]].name} 2개 가져가기` : (n ? `볼 ${n}개 가져가기` : '볼 가져가기');
  return `<div class="hint">${hint}</div>${err}
    <div class="btnrow"><button class="btn ghost" data-action="clear" ${n ? '' : 'disabled'}>선택 취소</button>
    <button class="btn primary" data-action="confirm-balls" ${valid ? '' : 'disabled'}>${label}</button></div>`;
}

export function logHTML(ctrl) {
  if (!ctrl.log.length) return '';
  return `<div class="log">${ctrl.log.slice(-4).map((l) => `<div>${l}</div>`).join('')}</div>`;
}

// ---------- sheet + overlays ----------

export function sheetHTML(ctrl) {
  const sh = ctrl.sheet;
  if (!sh) return '';
  if (sh.kind === 'deck') {
    return `<div class="sheet-back" data-action="close"></div><div class="sheet">
      <div class="sheet-title">${tierLabel[sh.tier]} 덱 맨 위 카드</div>
      <p class="sheet-p">뒷면 그대로 찜해요. 마스터볼이 남아 있으면 1개를 받아요.</p>
      <div class="btnrow"><button class="btn ghost" data-action="close">닫기</button>
      <button class="btn primary" data-action="reserve-deck" data-tier="${sh.tier}" ${ctrl.canReserve() ? '' : 'disabled'}>찜하기</button></div></div>`;
  }
  const card = ctrl.cardsById.get(sh.cardId);
  const inHand = ctrl.zone(card.id) === 'hand';
  const pay = ctrl.payment(card.id);
  const payText = pay
    ? TOKEN_KEYS.filter((k) => pay[k]).map((k) => `${ballImg(k)}${pay[k]}`).join(' ') || '무료!'
    : '볼이 부족해요';
  const canReserve = !inHand && !isSpecial(card) && ctrl.canReserve();
  const reserveNote = inHand ? '' : isSpecial(card) ? '희귀·전설은 찜 불가' : !ctrl.canReserve() ? '찜 한도(3장) 초과' : '';
  return `<div class="sheet-back" data-action="close"></div><div class="sheet">
    <div class="sheet-card">${cardHTML(card, ctrl, { interactive: false })}</div>
    <div class="sheet-info">
      <div class="sheet-title">${card.name}</div>
      <div class="paylbl">내가 낼 볼 (보너스 할인 적용)</div>
      <div class="pay ${pay ? '' : 'no'}">${payText}</div>
      ${reserveNote ? `<div class="note">${reserveNote}</div>` : ''}
    </div>
    <div class="btnrow col">
      <button class="btn primary" data-action="buy" data-card="${card.id}" ${pay ? '' : 'disabled'}>포켓몬 잡기</button>
      ${inHand ? '' : `<button class="btn alt" data-action="reserve" data-card="${card.id}" ${canReserve ? '' : 'disabled'}>찜하기 (+마스터볼)</button>`}
      <button class="btn ghost" data-action="close">닫기</button>
    </div></div>`;
}

export function startHTML({ save = null, dex = null, cards = [] } = {}) {
  const sum = dex ? dexSummary(dex, cards) : null;
  const resume = save
    ? `<button class="btn primary resume" data-action="resume">이어하기<small>${save.humanName} · ${save.game.turn}턴째 · ${new Date(save.savedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></button>`
    : '';
  return `<div class="overlay"><div class="panel">
    <div class="title big">포켓몬 스플렌더<small>POKEMON SPLENDOR · DOT EDITION</small></div>
    <p class="sheet-p">트레이너를 골라 AI 3명과 4인전을 시작해요.<br>18점을 먼저 모으는 트레이너가 승리!</p>
    ${resume}
    <div class="tiles">${TRAINERS.map((t, i) => `<button class="tile t${i}" data-action="start" data-name="${t}"><span class="tilebox"></span>${t}</button>`).join('')}</div>
    ${save ? '<p class="sheet-p warn">새로 시작하면 저장된 게임은 사라져요.</p>' : ''}
    <div class="btnrow"><button class="btn alt" data-action="dex">도감 ${sum ? `${sum.caught}/${sum.total}` : ''}</button></div>
  </div></div>`;
}

export function dexHTML(dex, cards) {
  const sum = dexSummary(dex, cards);
  const order = { 1: 1, 2: 2, 3: 3, rare: 4, legend: 5 };
  const list = [...cards].sort((a, b) => order[a.tier] - order[b.tier] || a.dex - b.dex);
  const cell = (c) => {
    const e = dex.caught[c.id];
    return e
      ? `<div class="dexcell got"><img src="${pokeSrc(c.dex)}" alt="${c.name}"><span class="dn">${c.name}</span><span class="dc">×${e.n}${e.evolved ? ` · 진화 ${e.evolved}` : ''}</span></div>`
      : `<div class="dexcell"><img class="sil" src="${pokeSrc(c.dex)}" alt=""><span class="dn">???</span><span class="dc">${tierLabel[c.tier]}</span></div>`;
  };
  const g = dex.games;
  return `<div class="overlay"><div class="panel dexpanel">
    <div class="title big">도감<small>잡은 포켓몬 ${sum.caught}/${sum.total} · ${g.played}판 ${g.won}승</small></div>
    <div class="dexgrid">${list.map(cell).join('')}</div>
    <div class="btnrow"><button class="btn primary" data-action="dex-close">닫기</button></div>
  </div></div>`;
}

export function endHTML(ctrl) {
  const s = ctrl.state;
  const rows = s.ranking.map((r) => {
    const p = s.players[r.player];
    return `<tr class="${r.rank === 1 ? 'win' : ''} ${p.id === ctrl.human ? 'me' : ''}"><td>${r.rank}</td><td>${p.isAI ? 'AI ' : ''}${p.name}</td><td>${r.points}점</td><td>진화 ${r.evolutions}</td><td>${r.pokemon}마리</td></tr>`;
  }).join('');
  const top = s.ranking[0].player === ctrl.human;
  return `<div class="overlay"><div class="panel">
    <div class="title big">${top ? '우승!' : '게임 종료'}<small>${s.stalled ? '아무도 행동할 수 없어 종료됐어요' : '최종 순위'}</small></div>
    <table class="rank">${rows}</table>
    <p class="sheet-p">동점은 진화 횟수가 많은 쪽 → 앞면 포켓몬 수가 적은 쪽이 이겨요.</p>
    <div class="btnrow"><button class="btn alt" data-action="dex">도감</button>
    <button class="btn primary" data-action="restart">다시 하기</button></div>
  </div></div>`;
}
