import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the sync server
import * as srvBackup from '../../public/bridge/backup.mjs';
// @ts-expect-error plain JS module shared with the sync server
import * as srvCrypto from '../../public/bridge/crypto.mjs';
import { parseRecoveryKey, recoveryKey } from './backup';
import type { SyncPairing } from './liveSync';
import { deriveKeys, newPairing, openBytes, sealBytes } from './syncCrypto';

describe('backups', () => {
  it('app and server seal bytes the same way', async () => {
    const { room, secret } = newPairing();
    const app = await deriveKeys(room, secret);
    const srv = await srvCrypto.deriveKeys(room, secret);
    const data = new TextEncoder().encode('hello backup');
    const fromApp = await sealBytes(app, 'backup-app', data);
    expect(new TextDecoder().decode(await srvCrypto.openBytes(srv, 'backup-app', fromApp))).toBe('hello backup');
    const fromSrv = new Uint8Array(await srvCrypto.sealBytes(srv, 'backup-server', data));
    expect(new TextDecoder().decode(await openBytes(app, 'backup-server', fromSrv))).toBe('hello backup');
    await expect(openBytes(app, 'backup-app', fromSrv)).rejects.toThrow();
  });

  it('server state round-trips through the relay, without archives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-'));
    mkdirSync(join(dir, 'auth'));
    mkdirSync(join(dir, 'archive'));
    mkdirSync(join(dir, 'users', 'abc', 'auth'), { recursive: true });
    writeFileSync(join(dir, 'host-key.json'), '{"pub":"x"}');
    writeFileSync(join(dir, 'auth', 'creds.json'), '{"me":1}');
    writeFileSync(join(dir, 'archive', '2026-11-20.log'), 'secret messages');
    writeFileSync(join(dir, 'users', 'abc', 'user.json'), '{"room":"abc"}');
    const store = new Map<string, unknown>();
    const call = async (method: string, op: string, body: { blob?: string; gen?: number; parts?: number }, query = '') => {
      const q = Object.fromEntries(new URLSearchParams(query));
      if (method === 'PUT') store.set(`${q.name}:${q.part}`, body.blob);
      else if (op === 'backup-commit') store.set('man', { parts: body.parts, at: 1 });
      else if (q.part === undefined) {
        if (!store.has('man')) throw new Error('relay backup 404');
        return store.get('man');
      } else return { blob: store.get(`${q.name}:${q.part}`) };
      return { ok: true };
    };
    const { room, secret } = newPairing();
    const keys = await srvCrypto.deriveKeys(room, secret);
    expect(await srvBackup.download(call, keys, 'server')).toBeNull();
    const files = srvBackup.collect(dir);
    expect(Object.keys(files).sort()).toEqual(['auth/creds.json', 'host-key.json', 'users/abc/user.json']);
    await srvBackup.upload(call, keys, 'server', { files });
    const fresh = mkdtempSync(join(tmpdir(), 'gd-'));
    expect(srvBackup.isFreshInstall(fresh)).toBe(true);
    const got = await srvBackup.download(call, keys, 'server');
    expect(srvBackup.restore(fresh, { ...got.value.files, '../evil': 'eA==' })).toBe(3);
    expect(readFileSync(join(fresh, 'users', 'abc', 'user.json'), 'utf8')).toBe('{"room":"abc"}');
    expect(srvBackup.isFreshInstall(fresh)).toBe(false);
  });

  it('recovery keys survive copy and paste', () => {
    const { room, secret } = newPairing();
    const key = recoveryKey({ room, secret } as SyncPairing);
    expect(parseRecoveryKey(` ${key.slice(0, 20)}\n${key.slice(20)} `)).toEqual({ room, secret });
    expect(parseRecoveryKey('hello')).toBeNull();
  });
});
