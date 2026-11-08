// Firebase Auth (Google sign-in) for the wallet. Loaded only when the compat
// SDK and config are present; the game itself never requires login — only
// paid rooms, betting and the wallet screen do.
//
// Why Google sign-in and not anonymous auth: balances are real money, so a
// user must be able to come back to the same wallet from another device, and
// the operator must be able to tell who sent a bank transfer.

let _auth = null;
let _user = null;
const _subs = new Set();

function fb() {
  return (typeof window !== 'undefined' && window.firebase) || null;
}

function cfgOk() {
  const cfg = (typeof window !== 'undefined' && window.__FIREBASE_CONFIG) || null;
  return !!(cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY');
}

/** True when the auth SDK is loaded and Firebase is configured. */
export function authAvailable() {
  const f = fb();
  return !!(f && typeof f.auth === 'function' && cfgOk());
}

function getAuth() {
  if (_auth) return _auth;
  const f = fb();
  if (!authAvailable()) throw new Error('auth-not-available');
  if (!f.apps || f.apps.length === 0) f.initializeApp(window.__FIREBASE_CONFIG);
  _auth = f.auth();
  try { _auth.languageCode = 'ko'; } catch {}
  _auth.onAuthStateChanged((u) => {
    _user = u ? { uid: u.uid, name: u.displayName || '', email: u.email || '', photo: u.photoURL || '' } : null;
    for (const cb of _subs) { try { cb(_user); } catch {} }
  });
  return _auth;
}

/** Current user ({uid, name, email, photo}) or null. */
export function currentUser() {
  return _user;
}

/** Subscribe to auth changes. Returns unsubscribe. Starts the SDK lazily. */
export function watchAuth(cb) {
  _subs.add(cb);
  try { getAuth(); } catch { /* not configured: stays signed out */ }
  try { cb(_user); } catch {}
  return () => _subs.delete(cb);
}

/** Google popup sign-in; falls back to redirect where popups are blocked (in-app browsers). */
export async function signIn() {
  const auth = getAuth();
  const f = fb();
  const provider = new f.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    const code = (e && e.code) || '';
    if (/popup-blocked|popup-closed|operation-not-supported|cancelled-popup/.test(code)) {
      await auth.signInWithRedirect(provider);
      return;
    }
    throw e;
  }
}

export async function signOut() {
  try { await getAuth().signOut(); } catch {}
}
