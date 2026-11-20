// Backups of the sync server's own state (WhatsApp links, the invite key,
// friends), sealed with the owner's key and kept in the relay. If the free VM
// is reclaimed, a new VM made with the same setup script restores it on first
// start, so nobody has to link WhatsApp again. Message archives are left out.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openBytes, sealBytes } from './crypto.mjs';

export const PART = 120_000; // characters per relay part
const MAX_BYTES = 25 * 2 ** 20;

/** Every file under dir except message archives, as {relative path: base64}. */
export function collect(dir) {
  const files = {};
  let total = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (name === 'archive' || name === 'node_modules') continue;
        walk(p);
      } else if (st.isFile() && st.size < 2 ** 20) {
        total += st.size;
        if (total > MAX_BYTES) throw new Error('server state too large to back up');
        files[relative(dir, p).split(sep).join('/')] = readFileSync(p).toString('base64');
      }
    }
  };
  walk(dir);
  return files;
}

/** Write files back under dir. Refuses paths that would leave it. */
export function restore(dir, files) {
  let n = 0;
  for (const [rel, b64] of Object.entries(files)) {
    if (rel.startsWith('/') || rel.split('/').some((x) => x === '..' || x === '')) continue;
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, Buffer.from(b64, 'base64'), { mode: 0o600 });
    n++;
  }
  return n;
}

/** Seal, split and upload one backup. call(method, op, body, query) talks to the relay room. */
export async function upload(call, keys, name, value) {
  const sealed = (await sealBytes(keys, `backup-${name}`, gzipSync(Buffer.from(JSON.stringify(value))))).toString('base64url');
  const gen = Date.now();
  const parts = Math.max(1, Math.ceil(sealed.length / PART));
  for (let i = 0; i < parts; i++) {
    await call('PUT', 'backup', { blob: sealed.slice(i * PART, (i + 1) * PART) }, `?name=${name}&gen=${gen}&part=${i}`);
  }
  await call('POST', 'backup-commit', { name, gen, parts, size: sealed.length });
  return sealed.length;
}

/** Download and open the last backup, or null when there is none. */
export async function download(call, keys, name) {
  let man;
  try {
    man = await call('GET', 'backup', undefined, `?name=${name}`);
  } catch (e) {
    if (/ 404$/.test(e.message)) return null;
    throw e;
  }
  let sealed = '';
  for (let i = 0; i < man.parts; i++) sealed += (await call('GET', 'backup', undefined, `?name=${name}&part=${i}`)).blob;
  const raw = await openBytes(keys, `backup-${name}`, Buffer.from(sealed, 'base64url'));
  return { at: man.at, value: JSON.parse(gunzipSync(raw).toString()) };
}

export const isFreshInstall = (dir) => !existsSync(join(dir, 'host-key.json')) && !existsSync(join(dir, 'auth', 'creds.json'));
