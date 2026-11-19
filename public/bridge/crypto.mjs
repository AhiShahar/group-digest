// End-to-end encryption shared with the app (src/lib/syncCrypto.ts). The relay
// only sees ciphertext. Keep both files in step.
const enc = new TextEncoder();

export const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
export const unb64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

async function hmac(secret, label) {
  const k = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(label)));
}

export async function deriveKeys(room, secretB64) {
  const secret = unb64url(secretB64);
  const token = b64url(await hmac(secret, 'group-digest auth v1'));
  const raw = await hmac(secret, 'group-digest enc v1');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { room, token, key };
}

export async function seal(k, kind, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${k.room}/${kind}`) }, k.key, enc.encode(JSON.stringify(value))),
  );
  return b64url(Buffer.concat([iv, ct]));
}

export async function open(k, kind, blob) {
  const raw = unb64url(blob);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(`${k.room}/${kind}`) },
    k.key,
    raw.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}
