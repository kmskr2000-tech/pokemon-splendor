// Shared constants for the game core. No DOM / Node built-ins allowed in src/core/.

export const COLORS = ['monster', 'super', 'hyper', 'heal', 'quick'];
export const MASTER = 'master';
export const TOKEN_KEYS = [...COLORS, MASTER];

export const MASTER_TOTAL = 5;
// Tokens per color by player count (WING rules: 3p removes 2 per color, 2p removes 3).
export const TOKENS_PER_COLOR = { 2: 4, 3: 5, 4: 7 };

export const MAX_TOKENS = 10;
export const MAX_HAND = 3;
export const WIN_POINTS = 18;

// Deck / table keys. Card.tier is 1 | 2 | 3 | 'rare' | 'legend'.
export const TIER_KEYS = ['1', '2', '3', 'rare', 'legend'];
export const RESERVABLE_TIER_KEYS = ['1', '2', '3'];
export const TABLE_SLOTS = { 1: 4, 2: 4, 3: 4, rare: 1, legend: 1 };
export const SPECIAL_TIER_KEYS = ['rare', 'legend'];

export const PHASES = {
  ACTION: 'action',
  DISCARD: 'discard',
  EVOLVE: 'evolve',
  FINISHED: 'finished',
};

// Rule interpretations the written rules leave open. Change here, not in engine logic.
export const RULE_CHOICES = {
  // Rare/legend purchase: the required master ball is paid IN ADDITION to any
  // master balls substituting for missing colors (matches design doc 2.2 "cost + master 1").
  specialMasterIsExtra: true,
  // Number of master balls a rare/legend card requires.
  specialMasterCount: 1,
};
