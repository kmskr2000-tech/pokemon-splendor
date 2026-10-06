// Local achievements. Each has a check(ctx) where ctx is built at game end
// (plus live flags for event-based ones):
// { won, turns, evolutions, difficulty, points, bonusColors:Set, caughtLegend }

export const ACHIEVEMENTS = [
  { id: 'first-win', icon: '🏆', name: '첫 승리', desc: 'AI를 상대로 처음 승리하기', check: (c) => c.won },
  { id: 'speed-win', icon: '⚡', name: '스피드러너', desc: '40턴 안에 승리하기', check: (c) => c.won && c.turns <= 40 },
  { id: 'big-win', icon: '💯', name: '압도적 승리', desc: '24점 이상으로 승리하기', check: (c) => c.won && c.points >= 24 },
  { id: 'no-evo-win', icon: '🌱', name: '순수 육성', desc: '진화 없이 승리하기', check: (c) => c.won && c.evolutions === 0 },
  { id: 'evo-master', icon: '🌀', name: '진화 마스터', desc: '한 게임에서 5회 진화하기', check: (c) => c.evolutions >= 5 },
  { id: 'rainbow', icon: '🌈', name: '무지개', desc: '5가지 색상 보너스를 모두 보유하기', check: (c) => c.bonusColors.size >= 5 },
  { id: 'legend-catch', icon: '✨', name: '전설 포획', desc: '전설·환상 포켓몬 잡기', check: (c) => c.caughtLegend },
  { id: 'hard-win', icon: '👑', name: '진정한 챔피언', desc: '어려움 난이도에서 승리하기', check: (c) => c.won && c.difficulty === 'hard' },
];

export function checkAchievements(ctx, unlocked) {
  return ACHIEVEMENTS.filter((a) => !unlocked[a.id] && a.check(ctx));
}
