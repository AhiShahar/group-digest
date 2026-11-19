import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the sync server
import * as server from '../../public/bridge/crypto.mjs';
import { deriveKeys, newPairing, open, seal } from './syncCrypto';

describe('live sync crypto', () => {
  it('app and sync server derive the same token and can read each other', async () => {
    const { room, secret } = newPairing();
    const app = await deriveKeys(room, secret);
    const srv = await server.deriveKeys(room, secret);
    expect(app.token).toBe(srv.token);
    const fromServer = await server.seal(srv, 'messages', { messages: [{ text: 'שלום 👋' }] });
    expect(await open(app, 'messages', fromServer)).toEqual({ messages: [{ text: 'שלום 👋' }] });
    const fromApp = await seal(app, 'config', { groups: ['1@g.us'] });
    expect(await server.open(srv, 'config', fromApp)).toEqual({ groups: ['1@g.us'] });
  });

  it('rejects a blob used under another kind or room', async () => {
    const a = newPairing();
    const k = await deriveKeys(a.room, a.secret);
    const blob = await seal(k, 'state', { x: 1 });
    await expect(open(k, 'config', blob)).rejects.toThrow();
    const other = await deriveKeys(newPairing().room, a.secret);
    await expect(open(other, 'state', blob)).rejects.toThrow();
  });
});
