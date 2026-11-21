// Keeps an open copy of the web app in step with the live site, and tells the
// person when a newer version is out.
//
// After a deploy the new service worker takes over at once and drops the old
// build's files from its cache. A page that was opened before the deploy (an
// iPhone Home Screen app can stay open for days) still runs the old code, and
// when it lazily loads a piece of it that file is gone: the server answers with
// the app page and the browser says "'text/html' is not a valid JavaScript
// MIME type". So:
// 1. if a lazy piece fails to load, reload once to get the current build;
// 2. when a new version is out (a new service worker took over, or the live
//    version.json names another build), show an "update ready" banner, and
//    reload on our own the next time the app is out of sight or comes back;
// 3. check for a new version whenever the app comes back to the screen, and
//    from Settings > App.
import { useSyncExternalStore } from 'react';
import { isAndroidApp } from './android';

export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD = __APP_BUILD__;

type Live = { version: string; build: string };

const KEY = 'nutshell-reloaded-at';
const webApp = () => !isAndroidApp && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

let available: string | null = null; // version of the newer build, '' when unknown
let swTookOver = false;
const listeners = new Set<() => void>();
function setAvailable(v: string) {
  if (available === v) return;
  available = v;
  listeners.forEach((l) => l());
}

/** The newer version waiting ('' if its number is unknown), or null when up to date. */
export function useUpdateAvailable(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => available,
  );
}

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

async function fetchLive(): Promise<Live | null> {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<Live>;
    return typeof j.build === 'string' ? { version: String(j.version ?? ''), build: j.build } : null;
  } catch {
    return null; // offline, or an old deploy without version.json
  }
}

/**
 * Looks for a newer version. Returns its version number, or null when this
 * copy is the live one. Throws when the site can't be reached.
 */
export async function checkForUpdate(): Promise<string | null> {
  if (!webApp()) return null;
  navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => undefined);
  const live = await fetchLive();
  if (!live) {
    if (swTookOver) return available ?? '';
    if (!navigator.onLine) throw new Error('You are offline. Try again when you are connected.');
    throw new Error('Could not reach Nutshell to check. Try again in a moment.');
  }
  if (live.build !== APP_BUILD) {
    setAvailable(live.version);
    return live.version;
  }
  return null;
}

/** Fetch the newest version and restart the app on it. */
export async function applyUpdate(): Promise<void> {
  if (webApp()) {
    const sw = navigator.serviceWorker;
    const reg = await sw.getRegistration().catch(() => undefined);
    if (reg && !swTookOver) {
      // Wait (briefly) for the new service worker to take over so the reload gets the new files.
      const changed = new Promise<void>((resolve) => sw.addEventListener('controllerchange', () => resolve(), { once: true }));
      await reg.update().catch(() => undefined);
      if (reg.installing || reg.waiting) await Promise.race([changed, new Promise((r) => setTimeout(r, 6000))]);
    }
  }
  try {
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  location.reload();
}

export function keepFresh(): void {
  window.addEventListener('vite:preloadError', () => {
    reloadOnce();
  });

  if (!webApp()) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    // The first install on a fresh visit also fires this; the page is already current then.
    if (!hadController) return;
    swTookOver = true;
    if (document.visibilityState === 'hidden') return void reloadOnce();
    setAvailable(available ?? '');
  });
  document.addEventListener('visibilitychange', () => {
    if (swTookOver) {
      reloadOnce();
      return;
    }
    if (document.visibilityState === 'visible') checkForUpdate().catch(() => undefined);
  });
  // Also look now and then while the app stays open on screen.
  setTimeout(() => checkForUpdate().catch(() => undefined), 5000);
  setInterval(() => document.visibilityState === 'visible' && checkForUpdate().catch(() => undefined), 30 * 60e3);
}
