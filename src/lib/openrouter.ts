// OpenRouter OAuth PKCE: the user signs in on openrouter.ai and we receive an
// API key tied to their account, billed to their own credits.
// https://openrouter.ai/docs/guides/overview/auth/oauth

const VERIFIER_KEY = 'openrouter_pkce_verifier';

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  arr.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function callbackUrl(): string {
  return location.origin + location.pathname;
}

export async function startOpenRouterSignIn(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  // localStorage, not sessionStorage: on iPhone the sign-in page can return in a
  // fresh browsing context, which would lose sessionStorage.
  localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, at: Date.now() }));
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callbackUrl());
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  location.assign(url.toString());
}

/** If we just came back from OpenRouter with ?code=, exchange it for a key. */
export async function finishOpenRouterSignIn(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return null;
  history.replaceState(null, '', callbackUrl());
  let verifier: string | null = null;
  try {
    const saved = JSON.parse(localStorage.getItem(VERIFIER_KEY) ?? 'null') as { verifier: string; at: number } | null;
    if (saved && Date.now() - saved.at < 15 * 60_000) verifier = saved.verifier;
  } catch {
    /* ignore */
  }
  localStorage.removeItem(VERIFIER_KEY);
  if (!verifier) {
    throw new Error('Sign-in finished in a different window. Open Nutshell from your Home Screen and tap Sign in again.');
  }
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter sign-in failed (${res.status}).`);
  const data = (await res.json()) as { key?: string };
  if (!data.key) throw new Error('OpenRouter did not return a key.');
  return data.key;
}
