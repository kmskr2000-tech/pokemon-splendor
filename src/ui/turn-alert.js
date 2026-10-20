// "Your turn" alerts (2026-10-20): banner + screen flash + repeated chime +
// vibration + browser Notification + blinking tab title. The old version was a
// single quiet chime, easy to miss in multiplayer or a background tab.
// Sound goes through sfx (its own on/off setting); banner/vibration/browser
// alerts follow the `turnNotify` option. All DOM access is guarded so this
// module is safe to import from Node tests.
import { sfx } from '../audio/sfx.js?v=1791962003';
import { PHASES } from '../core/constants.js?v=1791962003';

export function turnAlertMessage(phase) {
  if (phase === PHASES.DISCARD) return '볼을 반환할 차례예요!';
  if (phase === PHASES.EVOLVE) return '진화시킬 수 있어요!';
  return '당신의 차례예요!';
}

const BANNER_MS = 2400;

export function createTurnAlerter(getOptions) {
  const hasDoc = typeof document !== 'undefined';
  const originalTitle = hasDoc ? document.title : '포켓몬 스플렌더';
  let titleTimer = null;
  let bannerTimer = null;

  function stopTitleBlink() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    if (hasDoc && document.title !== originalTitle) document.title = originalTitle;
  }
  function startTitleBlink() {
    if (!hasDoc || titleTimer) return;
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '🔔 당신의 차례! · 포켓몬 스플렌더' : originalTitle;
    }, 800);
    if (titleTimer.unref) titleTimer.unref();
  }
  function showBanner(msg) {
    if (!hasDoc) return;
    const el = document.getElementById('turnbanner');
    if (!el) return;
    el.textContent = `▶ ${msg}`;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), BANNER_MS);
    if (bannerTimer.unref) bannerTimer.unref();
  }
  function flash() {
    if (!hasDoc) return;
    const app = document.getElementById('app');
    if (!app) return;
    app.classList.remove('turnflash');
    void app.offsetWidth; // restart the animation
    app.classList.add('turnflash');
    setTimeout(() => app.classList.remove('turnflash'), 1200);
  }
  function vibrate(pattern) {
    try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* unsupported */ }
  }
  function notifyBrowser(msg) {
    try {
      if (!hasDoc || !document.hidden) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const n = new Notification('포켓몬 스플렌더', { body: msg, tag: 'pks-turn' });
      n.onclick = () => { try { window.focus(); } catch { /* noop */ } n.close(); };
    } catch { /* unsupported */ }
  }

  return {
    // strong: a new turn became mine. light: mid-turn phase change
    // (discard / evolve) right after my own action — banner + short buzz only.
    alert(phase, strong) {
      const opts = getOptions ? getOptions() : null;
      if (opts && opts.turnNotify === false) return;
      const msg = turnAlertMessage(phase);
      showBanner(msg);
      flash();
      if (strong) {
        sfx.yourTurn();
        setTimeout(() => sfx.yourTurn(), 400);
        vibrate([180, 90, 180]);
        notifyBrowser(msg);
        startTitleBlink();
      } else {
        vibrate(80);
      }
    },
    // Turn moved on (or game ended): stop pestering.
    clear() {
      stopTitleBlink();
      if (hasDoc) document.getElementById('turnbanner')?.classList.remove('show');
    },
    // Any tap/keypress means the player is here — stop the title blink.
    acknowledge() { stopTitleBlink(); },
    async requestPermission() {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
          await Notification.requestPermission();
        }
      } catch { /* unsupported */ }
    },
  };
}
