// Chiptune BGM via Web Audio API. Original composition, no audio files needed.
// Starts on first user gesture (browser autoplay policy).

let ctx = null;
let masterGain = null;
let musicGain = null;
let playing = false;
let currentTrack = null;
let schedulerTimer = null;
let nextNoteTime = 0;
let step = 0;

// Note frequencies (Hz)
const N = {
  C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, B3: 246.94,
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00, B5: 987.77,
  C6: 1046.50, D6: 1174.66, E6: 1318.51,
};

// Tracks: 16 steps per bar, 4 bars = 64 steps. null = rest.
// Each step: [melodyNote, bassNote]
const TRACKS = {
  main: {
    bpm: 132,
    // Cheerful adventure loop: C - F - G - C
    melody: [
      'E4','G4','C5',null,'D5','C5',null,'G4',
      'A4','C5','F5',null,'E5','D5','C5',null,
      'D5','E5','G5',null,'F5','E5','D5',null,
      'E4','G4','C5',null,'G5',null,'E5','C5',
      'F4','A4','C5',null,'D5','F5',null,'E5',
      'D5','C5','D5',null,'C5','A4','G4',null,
      'E4','G4','B4',null,'D5','G5',null,'F5',
      'E5','D5','C5',null,'D5',null,'C5',null,
    ],
    bass: [
      'C3',null,null,null,'C3',null,null,null,
      'F3',null,null,null,'F3',null,null,null,
      'G3',null,null,null,'G3',null,null,null,
      'C3',null,null,null,'C3',null,'G3',null,
      'F3',null,null,null,'F3',null,null,null,
      'C3',null,null,null,'C3',null,null,null,
      'G3',null,null,null,'G3',null,null,null,
      'C3',null,null,null,'C3',null,null,null,
    ],
  },
  calm: {
    bpm: 100,
    // Gentle menu loop: Am - F - C - G
    melody: [
      'E4',null,'A4',null,'C5',null,'A4',null,
      'F4',null,'A4',null,'C5',null,'A4',null,
      'E4',null,'G4',null,'C5',null,'G4',null,
      'D4',null,'G4',null,'B4',null,'G4',null,
      'E4',null,'A4',null,'C5',null,'B4',null,
      'A4',null,'F4',null,'A4',null,'G4',null,
      'E4',null,'C4',null,'E4',null,'D4',null,
      'C4',null,null,null,null,null,null,null,
    ],
    bass: [
      'A3',null,null,null,null,null,null,null,
      'F3',null,null,null,null,null,null,null,
      'C3',null,null,null,null,null,null,null,
      'G3',null,null,null,null,null,null,null,
      'A3',null,null,null,null,null,null,null,
      'F3',null,null,null,null,null,null,null,
      'C3',null,null,null,null,null,null,null,
      'G3',null,null,null,null,null,null,null,
    ],
  },
};

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.5;
  masterGain.connect(ctx.destination);
  musicGain = ctx.createGain();
  musicGain.gain.value = 0.35;
  musicGain.connect(masterGain);
}

function playNote(freq, time, duration, type = 'square', volume = 1) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, time);
  gain.gain.linearRampToValueAtTime(volume * 0.15, time + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  osc.connect(gain);
  gain.connect(musicGain);
  osc.start(time);
  osc.stop(time + duration + 0.05);
}

function scheduler() {
  if (!playing || !currentTrack) return;
  const track = TRACKS[currentTrack];
  const stepDur = 60 / track.bpm / 2; // 8th notes
  
  while (nextNoteTime < ctx.currentTime + 0.1) {
    const mel = track.melody[step];
    const bass = track.bass[step];
    if (mel) playNote(N[mel], nextNoteTime, stepDur * 0.9, 'square', 0.8);
    if (bass) playNote(N[bass], nextNoteTime, stepDur * 1.8, 'triangle', 1.0);
    
    nextNoteTime += stepDur;
    step = (step + 1) % track.melody.length;
  }
  schedulerTimer = setTimeout(scheduler, 25);
}

export function startBGM(trackName = 'main') {
  try {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
    if (playing && currentTrack === trackName) return;
    stopBGM();
    currentTrack = trackName;
    playing = true;
    step = 0;
    nextNoteTime = ctx.currentTime + 0.05;
    scheduler();
  } catch (e) {
    // Audio not available; fail silently.
  }
}

export function stopBGM() {
  playing = false;
  currentTrack = null;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

export function setBGMVolume(v) {
  if (musicGain) musicGain.gain.value = v;
}

// Call on first user interaction to unlock audio.
export function unlockAudio() {
  try {
    ensureCtx();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* noop */ }
}
