import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module shared with the sync server
import { Limiter, makeReadOnly, reconnectDelay } from '../../public/bridge/hygiene.mjs';

describe('ban-risk hygiene on the sync server', () => {
  it('blocks every way of acting as the user, keeps reading', async () => {
    const calls: string[] = [];
    const fn = (name: string) => async () => calls.push(name);
    const names = ['sendMessage', 'sendPresenceUpdate', 'readMessages', 'chatModify', 'groupLeave', 'groupParticipantsUpdate', 'updateProfileName', 'rejectCall', 'newsletterFollow', 'communityLeave',
      'groupFetchAllParticipating', 'groupMetadata', 'requestPairingCode', 'logout', 'end', 'sendReceipt', 'sendNode', 'query'];
    const sock: Record<string, () => Promise<unknown>> = Object.fromEntries(names.map((n) => [n, fn(n)]));
    const blockedSeen: string[] = [];
    const blocked = makeReadOnly(sock, (n: string) => blockedSeen.push(n));
    expect(blocked.sort()).toEqual(['chatModify', 'communityLeave', 'groupLeave', 'groupParticipantsUpdate', 'newsletterFollow', 'readMessages', 'rejectCall', 'sendMessage', 'sendPresenceUpdate', 'updateProfileName']);
    await expect(sock.sendMessage()).rejects.toThrow(/read-only/);
    expect(blockedSeen).toEqual(['sendMessage']);
    await sock.groupFetchAllParticipating();
    await sock.requestPairingCode();
    expect(calls).toEqual(['groupFetchAllParticipating', 'requestPairingCode']);
  });

  it('limits events per window', () => {
    const l = new Limiter(2, 1000);
    expect([l.allow(0), l.allow(10), l.allow(20), l.allow(1001), l.allow(1011)]).toEqual([true, true, false, true, true]);
    expect(l.count(1500)).toBe(2);
  });

  it('backs off with jitter, and pauses after many drops', () => {
    expect(reconnectDelay(0, 0, () => 0.5)).toBe(2000);
    expect(reconnectDelay(10, 0, () => 1)).toBe(360000); // 5 min + 20%
    expect(reconnectDelay(0, 6, () => 0.5)).toBe(30 * 60e3);
  });
});
