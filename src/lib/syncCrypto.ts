// End-to-end encryption for live sync. The app and the sync server share a
// secret; the relay in the Worker only ever sees ciphertext and a token hash.
// Keep in step with bridge/crypto.mjs (syncCrypto.test.ts checks both agree).

export type BlobKind = 'state' | 'config' | 'messages' | 'notice' | 'archive';

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: Uint8Array<ArrayBuffer>, label: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(label)));
}

export interface SyncKeys {
  room: string;
  token: string;
  key: CryptoKey;
}

/** Derive the relay token and the AES key from the shared secret. */
export async function deriveKeys(room: string, secretB64: string): Promise<SyncKeys> {
  const secret = unb64url(secretB64);
  const token = b64url(await hmac(secret, 'group-digest auth v1'));
  const raw = await hmac(secret, 'group-digest enc v1');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { room, token, key };
}

export async function seal(k: SyncKeys, kind: BlobKind, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${k.room}/${kind}`) }, k.key, enc.encode(JSON.stringify(value))),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

export async function open<T>(k: SyncKeys, kind: BlobKind, blob: string): Promise<T> {
  const raw = unb64url(blob);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(`${k.room}/${kind}`) },
    k.key,
    raw.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

/** Encrypt raw bytes (backups). The label goes into the authenticated data, like kind does in seal. */
export async function sealBytes(k: SyncKeys, label: string, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${k.room}/${label}`) }, k.key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function openBytes(k: SyncKeys, label: string, raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(`${k.room}/${label}`) }, k.key, raw.slice(12)),
  );
}

/** A new room id (128-bit, hex) and secret (256-bit, base64url). */
export function newPairing(): { room: string; secret: string } {
  const r = crypto.getRandomValues(new Uint8Array(16));
  return { room: [...r].map((b) => b.toString(16).padStart(2, '0')).join(''), secret: b64url(crypto.getRandomValues(new Uint8Array(32))) };
}

// ---- host inbox (see public/bridge/crypto.mjs) ----

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** The owner's inbox room and secret, derived from the owner pairing. */
export async function hostInbox(ownerSecretB64: string): Promise<{ room: string; secret: string }> {
  const s = unb64url(ownerSecretB64);
  return { room: hex(await hmac(s, 'group-digest host inbox v1')).slice(0, 32), secret: b64url(await hmac(s, 'group-digest host secret v1')) };
}

/** Seal a note so only the sync server (holder of the host private key) can read it. */
export async function sealTo(hostPubB64: string, value: unknown): Promise<string> {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const pub = await crypto.subtle.importKey('raw', unb64url(hostPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('group-digest inbox v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(65 + 12 + ct.length);
  out.set(ephPub);
  out.set(iv, 65);
  out.set(ct, 77);
  return b64url(out);
}

/** A random one-time invite code. */
export const newInviteCode = () => b64url(crypto.getRandomValues(new Uint8Array(12)));
