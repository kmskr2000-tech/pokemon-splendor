// Seeded RNG (mulberry32). The generator state lives in `state.rng` so a game is
// fully reproducible and the state stays plain JSON.

export function nextFloat(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function nextInt(state, maxExclusive) {
  return Math.floor(nextFloat(state) * maxExclusive);
}

// In-place Fisher-Yates shuffle.
export function shuffle(state, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = nextInt(state, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
