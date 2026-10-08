// Sound effects via Web Audio API. Shares the AudioContext with bgm.js.
import { unlockAudio } from './bgm.js?v=1791458692';

let ctx = null;
let sfxGain = null;
let enabled = true;

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.4;
  sfxGain.connect(ctx.destination);
}

export function setSFXEnabled(v) {
  enabled = v;
}

function tone(freq, time, duration, type = 'square', volume = 1) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(volume * 0.2, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  osc.connect(gain);
  gain.connect(sfxGain);
  osc.start(time);
  osc.stop(time + duration + 0.05);
}

function seq(notes, type = 'square', stepDur = 0.08, volume = 1) {
  if (!enabled) return;
  try {
    unlockAudio();
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    notes.forEach(([freq, dur], i) => {
      if (freq) tone(freq, t0 + i * stepDur, dur || stepDur * 0.9, type, volume);
    });
  } catch (e) { /* noop */ }
}

const F = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, B5: 987.77,
  C6: 1046.50, E6: 1318.51, G6: 1567.98,
};

export const sfx = {
  // UI click
  click() { seq([[F.C5, 0.05]], 'square', 0.06, 0.5); },
  // Take balls
  takeBall() { seq([[F.E4, 0.06], [F.G4, 0.08]], 'square', 0.07, 0.7); },
  // Catch a pokemon: happy ascending arpeggio
  catch() { seq([[F.C4, 0.08], [F.E4, 0.08], [F.G4, 0.08], [F.C5, 0.15]], 'square', 0.09, 0.9); },
  // Reserve: soft chime
  reserve() { seq([[F.A4, 0.1], [F.E5, 0.15]], 'sine', 0.1, 0.8); },
  // Evolve: shimmering rise
  evolve() { seq([[F.C4,0.07],[F.D4,0.07],[F.E4,0.07],[F.G4,0.07],[F.A4,0.07],[F.C5,0.07],[F.E5,0.2]], 'triangle', 0.08, 0.9); },
  // Your turn notification
  yourTurn() { seq([[F.G5, 0.1], [F.C6, 0.15]], 'sine', 0.12, 0.7); },
  // Discard balls
  discard() { seq([[F.G4, 0.06], [F.E4, 0.08]], 'square', 0.07, 0.6); },
  // Win fanfare
  win() { seq([[F.C4,0.1],[F.E4,0.1],[F.G4,0.1],[F.C5,0.2],[F.E5,0.1],[F.G5,0.3]], 'square', 0.12, 1.0); },
  // Lose
  lose() { seq([[F.E4,0.15],[F.D4,0.15],[F.C4,0.3]], 'triangle', 0.18, 0.8); },
  // Master ball (special)
  masterBall() { seq([[F.C5,0.06],[F.E5,0.06],[F.G5,0.06],[F.C6,0.2]], 'sine', 0.07, 0.9); },
};
