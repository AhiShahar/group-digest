// Group Digest sync server.
//
// Links WhatsApp accounts as linked devices (like WhatsApp Web) and forwards
// new messages from the groups each person chose in the app. One server can
// host its owner plus invited friends; each person is a separate session with
// their own WhatsApp link, their own relay room and their own encryption key,
// so nobody can see anyone else's messages.
//
// It only makes outgoing connections: to WhatsApp, and to the relay in the
// app's own Cloudflare Worker. Everything sent to the relay is end-to-end
// encrypted; the relay never sees message text or keys.
//
// Message text is held in memory only until it is handed to the relay (a few
// seconds), and is never written to disk or logs. On disk: each person's
// WhatsApp link, their pairing key (so restarts reconnect), and the server's
// own key pair for invites.
//
// Config: /etc/group-digest/sync.json  {"relay": "https://...", "room": "...", "secret": "..."}
//   or env GD_RELAY, GD_ROOM, GD_SECRET.  Data dir: GD_DATA (default /var/lib/group-digest).
//   GD_MAX_USERS: friends allowed besides the owner (default: what memory allows).

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import pino from 'pino';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState as loadAuthState } from 'baileys';
import { deriveKeys, hostInbox, importHostKey, newHostKey, open, openSealed, seal } from './crypto.mjs';
import { toRecord } from './parse.mjs';

const VERSION = '0.3.0';
const SELF = fileURLToPath(import.meta.url);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Give Node a heap that matches the machine, so more people fit on bigger VMs.
const memMb = Math.round(totalmem() / 2 ** 20);
const wantHeapMb = Math.max(384, Math.round(memMb * 0.7));
if (!process.env.GD_CHILD && getHeapStatistics().heap_size_limit / 2 ** 20 < wantHeapMb * 0.9) {
  const child = spawn(process.execPath, [`--max-old-space-size=${wantHeapMb}`, SELF], { stdio: 'inherit', env: { ...process.env, GD_CHILD: '1' } });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  await main();
}

async function main() {
  const DATA = process.env.GD_DATA || '/var/lib/group-digest';
  const LINK_WINDOW_MS = 10 * 60e3; // show QR codes for 10 minutes after the app asks
  const HISTORY_KEEP_MS = 60 * 60e3; // recent history from linking, kept in memory for an hour
  const HISTORY_MAX = 3000;
  const MAX_USERS = Number(process.env.GD_MAX_USERS) || Math.max(1, Math.min(300, Math.floor((memMb - 350) / 110)));
  const quiet = pino({ level: process.env.GD_DEBUG ? 'debug' : 'silent' });

  const cfg = (() => {
    let file = {};
    try {
      file = JSON.parse(readFileSync(process.env.GD_CONFIG || '/etc/group-digest/sync.json', 'utf8'));
    } catch {
      /* env only */
    }
    const relay = (process.env.GD_RELAY || file.relay || '').replace(/\/+$/, '');
    const room = process.env.GD_ROOM || file.room;
    const secret = process.env.GD_SECRET || file.secret;
    if (!relay || !/^[a-f0-9]{32}$/.test(room || '') || !secret) {
      console.error('Missing or bad config: need relay, room (32 hex) and secret.');
      process.exit(2);
    }
    return { relay, room, secret };
  })();

  async function relay(keys, method, op, body, query = '') {
    const res = await fetch(`${cfg.relay}/api/sync/${keys.room}/${op}${query}`, {
      method,
      headers: { authorization: `Bearer ${keys.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20e3),
    });
    if (!res.ok) throw new Error(`relay ${op} ${res.status}`);
    return res.json();
  }

  let waVersion;
  async function whatsappVersion() {
    if (!waVersion) {
      try {
        waVersion = (await fetchLatestBaileysVersion()).version;
        setTimeout(() => (waVersion = undefined), 6 * 3600e3);
      } catch {
        /* use the bundled one */
      }
    }
    return waVersion;
  }

  // ---- one person: their WhatsApp link, their relay room, their key ----------------

  class Session {
    constructor({ room, secret, dir, owner = false, name = null, code = null, joinedAt = Date.now() }) {
      Object.assign(this, { room, secret, dir, owner, name, code, joinedAt });
      this.authDir = join(dir, 'auth');
      this.state = { v: 2, version: VERSION, status: 'starting', qr: null, me: null, groups: [], error: null, lastMessageAt: 0, at: 0 };
      this.config = { groups: [] };
      this.selected = new Set();
      this.linkRequestedAt = 0;
      this.pairAt = 0;
      this.pairPhone = null;
      this.pairDone = null;
      this.unlinkSeen = null;
      this.queue = [];
      this.seen = new Set();
      this.history = [];
      this.groupNames = new Map();
      this.sock = null;
      this.retry = 0;
      this.stopped = false;
      this.lastPushed = '';
      this.timer = null;
    }

    label() {
      return this.owner ? 'owner' : `friend ${this.room.slice(0, 6)}`;
    }

    async init() {
      this.keys = await deriveKeys(this.room, this.secret);
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try {
        this.unlinkSeen = Number(readFileSync(join(this.dir, 'unlink-seen'), 'utf8')) || 0;
      } catch {
        /* first run */
      }
    }

    setState(patch) {
      Object.assign(this.state, patch);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pushState(), patch.qr ? 0 : 1500);
    }

    async pushState(force = false) {
      if (this.stopped && this.state.status !== 'removed') return;
      this.state.at = Date.now();
      if (this.owner) this.state.host = host.summary();
      const { at: _at, ...rest } = this.state;
      const sig = JSON.stringify(rest);
      if (!force && sig === this.lastPushed) return;
      try {
        await relay(this.keys, 'PUT', 'state', { blob: await seal(this.keys, 'state', this.state) });
        this.lastPushed = sig;
      } catch (e) {
        log(this.label(), 'state push failed:', e.message);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.pushState(), 30e3);
      }
    }

    async pollConfig() {
      if (this.stopped) return;
      try {
        const r = await relay(this.keys, 'GET', 'config');
        if (!r.blob) return;
        const c = await open(this.keys, 'config', r.blob);
        this.config = c;
        const before = this.selected;
        this.selected = new Set(Array.isArray(c.groups) ? c.groups : []);
        this.queueHistory([...this.selected].filter((g) => !before.has(g)));
        const wantLink = Number(c.linkRequestedAt) || 0;
        if (wantLink > this.linkRequestedAt) {
          this.linkRequestedAt = wantLink;
          if (!this.sock && Date.now() - this.linkRequestedAt < LINK_WINDOW_MS) this.connect();
        }
        // Link with phone number: the app asks for an 8-character code instead of a QR scan.
        const pairAt = Number(c.pairAt) || 0;
        if (pairAt > this.pairAt && typeof c.pairPhone === 'string' && /^\d{7,15}$/.test(c.pairPhone)) {
          this.pairAt = pairAt;
          this.pairPhone = c.pairPhone;
          this.pairDone = null;
          if (this.sock && !this.sock.authState?.creds?.registered && this.state.status === 'qr') this.requestCode(this.sock);
        }
        if (this.owner && this.updateSeen !== undefined && (Number(c.update) || 0) > this.updateSeen) checkForUpdate();
        this.updateSeen = Number(c.update) || 0;
        const unlink = Number(c.unlink) || 0;
        if (this.unlinkSeen === null) this.unlinkSeen = unlink; // first run: nothing to undo
        if (unlink > this.unlinkSeen) {
          this.unlinkSeen = unlink;
          log(this.label(), 'unlink requested from the app');
          await this.logout();
        }
        writeFileSync(join(this.dir, 'unlink-seen'), String(this.unlinkSeen));
        if (!this.owner && c.leave) await host.remove(this.room, 'left');
        if (this.owner) await host.ownerConfig(c);
      } catch (e) {
        log(this.label(), 'config poll failed:', e.message);
      }
    }

    async requestCode(s) {
      if (this.pairDone === s || !this.pairPhone || Date.now() - this.pairAt > LINK_WINDOW_MS) return;
      this.pairDone = s;
      try {
        // Reuse the code for a few minutes across reconnects, so it doesn't change while someone types it.
        const reuse = this.lastCode && this.lastCode.phone === this.pairPhone && Date.now() - this.lastCode.at < 3 * 60e3 ? this.lastCode.raw : undefined;
        const raw = await s.requestPairingCode(this.pairPhone, reuse);
        if (!reuse) this.lastCode = { raw, phone: this.pairPhone, at: Date.now() };
        const code = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
        log(this.label(), 'pairing code ready');
        this.setState({ status: 'code', code, qr: null, error: null });
      } catch (e) {
        this.pairDone = null;
        log(this.label(), 'pairing code failed:', e.message);
        this.setState({ error: 'Could not get a code for that number. Check it, with country code, and try again.' });
      }
    }

    remember(id) {
      this.seen.add(id);
      if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
    }

    queueHistory(groupIds) {
      if (!groupIds.length) return;
      const want = new Set(groupIds);
      const cutoff = Date.now() - HISTORY_KEEP_MS;
      for (const h of this.history) {
        if (h.keptAt >= cutoff && want.has(h.msg.group) && !this.seen.has(h.msg.id)) {
          this.queue.push(h.msg);
          this.remember(h.msg.id);
        }
      }
    }

    async flush() {
      if (!this.queue.length || this.stopped) return;
      const batch = this.queue.slice(0, 500);
      try {
        await relay(this.keys, 'POST', 'messages', { blob: await seal(this.keys, 'messages', { v: 1, messages: batch }) });
        this.queue = this.queue.slice(batch.length);
        this.setState({ lastMessageAt: Date.now() });
      } catch (e) {
        log(this.label(), 'flush failed, will retry:', e.message);
        if (this.queue.length > 5000) this.queue = this.queue.slice(-5000);
      }
    }

    record(msg) {
      return toRecord(msg, this.groupNames, this.state.me?.name);
    }

    async refreshGroups() {
      if (!this.sock) return;
      try {
        const all = await this.sock.groupFetchAllParticipating();
        const groups = Object.values(all)
          .map((g) => ({ id: g.id, name: g.subject || g.id, size: g.participants?.length || 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const g of groups) this.groupNames.set(g.id, g.name);
        this.setState({ groups });
      } catch (e) {
        log(this.label(), 'group list failed:', e.message);
      }
    }

    async logout() {
      const s = this.sock;
      this.sock = null;
      try {
        await s?.logout();
      } catch {
        /* already gone */
      }
      s?.end?.(undefined);
      rmSync(this.authDir, { recursive: true, force: true });
      this.history.length = 0;
      this.queue.length = 0;
      this.setState({ status: 'unlinked', qr: null, me: null, groups: [], error: null });
    }

    async stop() {
      this.stopped = true;
      clearTimeout(this.timer);
      const s = this.sock;
      this.sock = null;
      s?.end?.(undefined);
    }

    async connect() {
      if (this.stopped) return;
      mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
      const { state: auth, saveCreds } = await loadAuthState(this.authDir);
      if (!auth.creds.registered && Date.now() - this.linkRequestedAt > LINK_WINDOW_MS) {
        // Not linked and nobody is looking at the link screen: stay idle.
        this.setState({ status: 'unlinked', qr: null });
        return;
      }
      let agent;
      if (process.env.GD_PROXY) agent = new (await import('https-proxy-agent')).HttpsProxyAgent(process.env.GD_PROXY);
      const s = makeWASocket({
        auth,
        version: await whatsappVersion(),
        agent,
        fetchAgent: agent,
        logger: quiet,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, // keep phone notifications working
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: () => true,
        getMessage: async () => undefined,
      });
      this.sock = s;
      s.ev.on('creds.update', saveCreds);

      // Watchdog: if WhatsApp neither connects nor sends a QR code in 90 s, start over.
      let progressed = false;
      setTimeout(() => {
        if (this.sock !== s || progressed) return;
        log(this.label(), 'no answer from WhatsApp in 90s, retrying');
        this.setState({ status: this.state.status === 'connected' ? 'starting' : this.state.status, error: 'Cannot reach WhatsApp from the server yet, retrying' });
        this.sock = null;
        s.end(undefined);
        setTimeout(() => this.connect(), Math.min(5 * 60e3, 5000 * 2 ** this.retry++));
      }, 90e3);

      s.ev.on('connection.update', (u) => {
        if (this.sock !== s) return;
        if (u.qr || u.connection === 'open') progressed = true;
        if (u.qr) {
          if (Date.now() - this.linkRequestedAt > LINK_WINDOW_MS) {
            log(this.label(), 'link window closed, stopping QR codes');
            this.sock = null;
            s.end(undefined);
            this.setState({ status: 'unlinked', qr: null });
            return;
          }
          if (this.pairPhone && Date.now() - this.pairAt < LINK_WINDOW_MS) {
            this.requestCode(s); // keep showing the code; ignore new QR codes
          } else this.setState({ status: 'qr', qr: u.qr, code: null, error: null });
        }
        if (u.connection === 'open') {
          this.retry = 0;
          const me = s.user ? { name: s.user.name || s.user.verifiedName || null, number: (s.user.id || '').split(':')[0].split('@')[0] } : null;
          log(this.label(), 'connected');
          this.pairPhone = null;
          this.setState({ status: 'connected', qr: null, code: null, me, error: null });
          this.refreshGroups();
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          this.sock = null;
          if (this.stopped) return;
          if (code === DisconnectReason.loggedOut) {
            log(this.label(), 'logged out from the phone; waiting for a new link');
            rmSync(this.authDir, { recursive: true, force: true });
            this.setState({ status: 'unlinked', qr: null, me: null, groups: [], error: 'Logged out from the phone' });
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            this.setState({ status: 'error', error: 'Another copy of the sync server took over this link' });
          }
          const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(5 * 60e3, 2000 * 2 ** this.retry++);
          log(this.label(), `connection closed (${code ?? 'no code'}), reconnecting in ${Math.round(wait / 1000)}s`);
          setTimeout(() => this.connect(), wait);
        }
      });

      s.ev.on('groups.upsert', () => this.refreshGroups());
      s.ev.on('groups.update', (ups) => {
        if (ups.some((g) => g.subject)) this.refreshGroups();
      });

      s.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
          const group = msg.key?.remoteJid;
          if (!group || !this.selected.has(group) || this.seen.has(msg.key.id)) continue;
          const rec = this.record(msg);
          if (!rec) continue;
          this.remember(rec.id);
          this.queue.push(rec);
        }
      });

      // Recent history sent right after linking, kept in memory for an hour so
      // groups chosen just after linking start with recent messages.
      s.ev.on('messaging-history.set', ({ messages }) => {
        const keptAt = Date.now();
        const recent = keptAt - 14 * 864e5;
        for (const msg of messages || []) {
          const rec = this.record(msg);
          if (!rec || rec.ts < recent) continue;
          if (this.selected.has(rec.group)) {
            if (!this.seen.has(rec.id)) {
              this.remember(rec.id);
              this.queue.push(rec);
            }
          } else this.history.push({ msg: rec, keptAt });
        }
        if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
      });
    }

    pruneHistory() {
      const cutoff = Date.now() - HISTORY_KEEP_MS;
      while (this.history.length && this.history[0].keptAt < cutoff) this.history.shift();
    }
  }

  // ---- the host: owner + invited friends -------------------------------------------------

  const sessions = new Map(); // room -> Session
  const USERS = join(DATA, 'users');

  const host = {
    key: null,
    inbox: null,
    inviteKeys: null,
    invites: [],

    async init() {
      const keyFile = join(DATA, 'host-key.json');
      let k;
      try {
        k = JSON.parse(readFileSync(keyFile, 'utf8'));
      } catch {
        k = await newHostKey();
        writeFileSync(keyFile, JSON.stringify(k), { mode: 0o600 });
      }
      this.pub = k.pub;
      this.key = await importHostKey(k.priv);
      const ib = await hostInbox(cfg.secret);
      this.inbox = ib.room;
      this.inboxKeys = await deriveKeys(ib.room, ib.secret);
    },

    friends() {
      return [...sessions.values()].filter((s) => !s.owner);
    },

    summary() {
      return {
        inbox: this.inbox,
        pub: this.pub,
        max: MAX_USERS,
        members: this.friends().map((s) => ({
          room: s.room,
          name: s.name,
          code: s.code,
          joinedAt: s.joinedAt,
          status: s.state.status,
          lastMessageAt: s.state.lastMessageAt,
        })),
      };
    },

    async ownerConfig(c) {
      this.invites = Array.isArray(c.invites) ? c.invites : [];
      for (const room of Array.isArray(c.remove) ? c.remove : []) if (sessions.has(room)) await this.remove(room, 'removed');
    },

    async pollInbox() {
      let notes;
      try {
        notes = (await relay(this.inboxKeys, 'GET', 'inbox', undefined, '?after=0')).notes;
      } catch (e) {
        log('inbox poll failed:', e.message);
        return;
      }
      if (!notes.length) return;
      let ownerFresh = false;
      for (const n of notes) {
        let note;
        try {
          note = await openSealed(this.key, n.blob);
        } catch {
          continue; // not for us or tampered
        }
        if (note.type === 'ping') {
          await sessions.get(note.room)?.pollConfig();
        } else if (note.type === 'join') {
          if (!ownerFresh) {
            await sessions.get(cfg.room)?.pollConfig(); // pick up invites made a moment ago
            ownerFresh = true;
          }
          await this.join(note);
        }
      }
      try {
        await relay(this.inboxKeys, 'POST', 'inbox-ack', { upTo: Math.max(...notes.map((n) => n.seq)) });
      } catch {
        /* acked next time */
      }
    },

    async refuse(note, why) {
      try {
        const keys = await deriveKeys(note.room, note.secret);
        const state = { v: 2, version: VERSION, status: 'error', qr: null, me: null, groups: [], error: why, lastMessageAt: 0, at: Date.now() };
        await relay(keys, 'PUT', 'state', { blob: await seal(keys, 'state', state) });
      } catch {
        /* nothing more to do */
      }
    },

    async join(note) {
      if (typeof note.room !== 'string' || !/^[a-f0-9]{32}$/.test(note.room) || typeof note.secret !== 'string' || note.room === cfg.room) return;
      if (sessions.has(note.room)) return sessions.get(note.room).pollConfig(); // already in
      const invite = this.invites.find((i) => i.code === note.code);
      if (!invite) return this.refuse(note, 'This invite is not valid any more. Ask for a new one.');
      if (this.friends().some((s) => s.code === note.code)) return this.refuse(note, 'This invite was already used. Ask for a new one.');
      if (this.friends().length >= MAX_USERS) return this.refuse(note, 'This sync server is full right now.');
      const name = String(note.name || invite.name || '').slice(0, 60) || null;
      const s = new Session({ room: note.room, secret: note.secret, dir: join(USERS, note.room), name, code: note.code });
      await s.init();
      writeFileSync(join(s.dir, 'user.json'), JSON.stringify({ room: s.room, secret: s.secret, name, code: s.code, joinedAt: s.joinedAt }), { mode: 0o600 });
      sessions.set(s.room, s);
      s.setState({ status: 'starting' });
      log(`friend ${s.room.slice(0, 6)} joined (${sessions.size - 1} of ${MAX_USERS})`);
      await s.pollConfig();
      await s.connect();
      sessions.get(cfg.room)?.pushState();
    },

    async remove(room, why) {
      const s = sessions.get(room);
      if (!s || s.owner) return;
      log(`friend ${room.slice(0, 6)} ${why}`);
      await s.logout();
      await s.stop();
      sessions.delete(room);
      rmSync(s.dir, { recursive: true, force: true });
      s.state = { ...s.state, status: 'removed', qr: null, me: null, groups: [], error: why === 'left' ? null : 'You were removed from this sync server.' };
      await s.pushState(true);
      sessions.get(cfg.room)?.pushState();
    },
  };

  // ---- self-update: restart when the Worker serves a newer server ---------------------

  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  async function checkForUpdate() {
    try {
      const files = ['bridge.mjs', 'parse.mjs', 'crypto.mjs', 'package.json'];
      for (const f of files) {
        const res = await fetch(`${cfg.relay}/bridge/${f}`, { signal: AbortSignal.timeout(20e3) });
        if (!res.ok) return;
        const local = join(SELF, '..', f);
        if (!existsSync(local) || sha(Buffer.from(await res.arrayBuffer())) !== sha(readFileSync(local))) {
          log(`update available (${f} changed), restarting to install it`);
          await shutdown(0);
        }
      }
    } catch {
      /* try again later */
    }
  }

  async function shutdown(code) {
    for (const s of sessions.values()) await s.flush();
    for (const s of sessions.values()) await s.stop();
    process.exit(code);
  }

  // ---- start --------------------------------------------------------------------------------

  log(`Group Digest sync ${VERSION} starting, relay ${cfg.relay}, room for ${MAX_USERS} friends`);
  mkdirSync(USERS, { recursive: true, mode: 0o700 });
  await host.init();

  // The owner keeps the original data layout, so existing links carry over.
  const owner = new Session({ room: cfg.room, secret: cfg.secret, dir: DATA, owner: true });
  await owner.init();
  sessions.set(owner.room, owner);
  for (const room of readdirSync(USERS)) {
    try {
      const u = JSON.parse(readFileSync(join(USERS, room, 'user.json'), 'utf8'));
      const s = new Session({ ...u, dir: join(USERS, room) });
      await s.init();
      sessions.set(s.room, s);
    } catch {
      /* incomplete join */
    }
  }

  for (const s of sessions.values()) s.setState({ status: 'starting' });
  // Claim the inbox so friends can drop join requests into it.
  await host.pollInbox();
  for (const s of sessions.values()) {
    await s.pollConfig();
    s.connect();
    await new Promise((r) => setTimeout(r, 1500)); // stagger reconnects
  }

  setInterval(() => host.pollInbox(), 30e3);
  // The apps nudge the server through the inbox when they change settings; this is the fallback.
  setInterval(() => {
    for (const s of sessions.values()) if (s.owner && s.state.status !== 'connected') s.pollConfig();
  }, 45e3);
  let i = 0;
  setInterval(() => {
    const all = [...sessions.values()];
    if (!all.length) return;
    const s = all[i++ % all.length];
    s.pollConfig();
  }, Math.max(10e3, (30 * 60e3) / Math.max(1, sessions.size)));
  setInterval(() => {
    for (const s of sessions.values()) s.flush();
  }, 15e3);
  setInterval(() => {
    for (const s of sessions.values()) {
      s.pruneHistory();
      s.pushState(true);
    }
  }, 15 * 60e3);
  setInterval(() => {
    for (const s of sessions.values()) s.refreshGroups();
  }, 6 * 3600e3);
  setTimeout(checkForUpdate, 5 * 60e3);
  setInterval(checkForUpdate, 6 * 3600e3);

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
}
