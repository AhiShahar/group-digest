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

// ---- host inbox: notes sealed to the server's public key (ECDH P-256 + AES-GCM) ----

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The owner's inbox room and secret, derived from the owner pairing so nothing new needs configuring. */
export async function hostInbox(ownerSecretB64) {
  const s = unb64url(ownerSecretB64);
  return { room: hex(await hmac(s, 'group-digest host inbox v1')).slice(0, 32), secret: b64url(await hmac(s, 'group-digest host secret v1')) };
}

export async function newHostKey() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { pub: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

export async function importHostKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

async function boxKey(priv, pubRaw) {
  const pub = await crypto.subtle.importKey('raw', pubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('group-digest inbox v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Seal a note so only the holder of the host's private key can read it. */
export async function sealTo(hostPubB64, value) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const key = await boxKey(eph.privateKey, unb64url(hostPubB64));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  return b64url(Buffer.concat([ephPub, iv, ct]));
}

export async function openSealed(hostPriv, blob) {
  const raw = unb64url(blob);
  const key = await boxKey(hostPriv, raw.slice(0, 65));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(65, 77) }, key, raw.slice(77));
  return JSON.parse(new TextDecoder().decode(pt));
}
