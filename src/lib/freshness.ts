// Keeps an open copy of the web app in step with the live site.
//
// After a deploy the new service worker takes over at once and drops the old
// build's files from its cache. A page that was opened before the deploy (an
// iPhone Home Screen app can stay open for days) still runs the old code, and
// when it lazily loads a piece of it (for example the AI providers module when
// Scheduled digests is switched on) that file is gone: the server answers with
// the app page instead and the browser says "'text/html' is not a valid
// JavaScript MIME type". So:
// 1. if a lazy piece fails to load, reload once to get the current build;
// 2. when a new version takes over, reload the next time the app is out of
//    sight or comes back, so nothing is lost mid-tap;
// 3. check for a new version whenever the app comes back to the screen.
import { isAndroidApp } from './android';

const KEY = 'nutshell-reloaded-at';

function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 30_000) return false; // just reloaded: don't loop
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage blocked: still reload */
  }
  location.reload();
  return true;
}

export function keepFresh(): void {
  window.addEventListener('vite:preloadError', () => {
    reloadOnce();
  });

  if (isAndroidApp || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  let stale = false;
  sw.addEventListener('controllerchange', () => {
    // The first install on a fresh visit also fires this; the page is already current then.
    if (!hadController) return;
    stale = true;
    if (document.visibilityState === 'hidden') reloadOnce();
  });
  document.addEventListener('visibilitychange', () => {
    if (stale) {
      reloadOnce();
      return;
    }
    if (document.visibilityState === 'visible') sw.getRegistration().then((r) => r?.update()).catch(() => undefined);
  });
}
