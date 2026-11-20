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
// seconds), and is never written to logs. It is written to disk only for a
// person who turns on scheduled digests: then the groups they chose are kept,
// encrypted with their own key, for about a week (archive/), so the server can
// summarize them at the chosen time with that person's own AI. Also on disk:
// each person's WhatsApp link, their pairing key (so restarts reconnect), and
// the server's own key pair for invites.
//
// Config: /etc/group-digest/sync.json  {"relay": "https://...", "room": "...", "secret": "..."}
//   or env GD_RELAY, GD_ROOM, GD_SECRET.  Data dir: GD_DATA (default /var/lib/group-digest).
//   GD_MAX_USERS: friends allowed besides the owner (default: what memory allows).

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
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

const VERSION = '0.5.1';
const SELF = fileURLToPath(import.meta.url);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Give Node a heap that matches the machine, so more people fit on bigger VMs.
const memMb = Math.round(totalmem() / 2 ** 20);
const wantHeapMb = Math.max(384, Math.round(memMb * 0.7));
// Files the server is made of. Newer versions can add files: older installers
// only fetch the first few, so fetch any that are missing before using them,
// and teach update.sh to read the list from files.txt from now on.
const BASE_FILES = ['bridge.mjs', 'crypto.mjs', 'parse.mjs', 'package.json'];
function relayUrl() {
  try {
    return (process.env.GD_RELAY || JSON.parse(readFileSync(process.env.GD_CONFIG || '/etc/group-digest/sync.json', 'utf8')).relay || '').replace(/\/+$/, '');
  } catch {
    return (process.env.GD_RELAY || '').replace(/\/+$/, '');
  }
}
async function serverFiles() {
  try {
    const res = await fetch(`${relayUrl()}/bridge/files.txt`, { signal: AbortSignal.timeout(20e3) });
    if (res.ok) {
      const list = (await res.text()).split(/\s+/).filter((f) => /^[a-z0-9-]+\.(mjs|json)$/.test(f));
      if (list.length) return list;
    }
  } catch {
    /* offline: use what is here */
  }
  return [...BASE_FILES, 'digest.mjs', 'backup.mjs', 'hygiene.mjs', 'activity.mjs'];
}
async function loadModule(name) {
  const here = join(SELF, '..');
  const local = join(here, name);
  if (!existsSync(local)) {
    const res = await fetch(`${relayUrl()}/bridge/${name}`, { signal: AbortSignal.timeout(30e3) });
    if (!res.ok) throw new Error(`could not download ${name} (${res.status})`);
    writeFileSync(local, Buffer.from(await res.arrayBuffer()));
  }
  upgradeUpdater(here);
  return import(`./${name}`);
}
function upgradeUpdater(here) {
  const file = join(here, 'update.sh');
  try {
    const cur = readFileSync(file, 'utf8');
    if (cur.includes('files.txt')) return;
    const relay = relayUrl();
    if (!relay) return;
    writeFileSync(
      file,
      `#!/bin/bash
set -e
cd "${here}"
FILES=$(curl -fsSL "${relay}/bridge/files.txt" 2>/dev/null | tr -cd 'a-z0-9.\\n-' || true)
[ -n "$FILES" ] || FILES="bridge.mjs crypto.mjs parse.mjs package.json"
for f in $FILES; do
  curl -fsSL "${relay}/bridge/$f" -o "$f.new" && mv "$f.new" "$f"
done
if ! cmp -s package.json .installed-package.json || [ ! -d node_modules ]; then
  /usr/local/bin/npm install --omit=dev --no-audit --no-fund --loglevel=error
  cp package.json .installed-package.json
fi
`,
      { mode: 0o755 },
    );
  } catch {
    /* not installed by setup.sh (tests, a laptop): nothing to upgrade */
  }
}

if (!process.env.GD_CHILD && getHeapStatistics().heap_size_limit / 2 ** 20 < wantHeapMb * 0.9) {
  const child = spawn(process.execPath, [`--max-old-space-size=${wantHeapMb}`, SELF], { stdio: 'inherit', env: { ...process.env, GD_CHILD: '1' } });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  await main();
}

async function main() {
  const { duePeriod, friendlyAiError, summarizeGroup } = await loadModule('digest.mjs');
  const backup = await loadModule('backup.mjs');
  const { Limiter, jitter, makeReadOnly, reconnectDelay } = await loadModule('hygiene.mjs');
  const { Activity } = await loadModule('activity.mjs');
  const DATA = process.env.GD_DATA || '/var/lib/group-digest';
  const LINK_WINDOW_MS = 10 * 60e3; // show QR codes for 10 minutes after the app asks
  const HISTORY_KEEP_MS = 60 * 60e3; // recent history from linking, kept in memory for an hour
  const HISTORY_MAX = 3000;
  const INVITE_DAYS = 7;
  // Friends besides the owner. Many WhatsApp accounts from one IP address look
  // like an account farm, so the default stays small even on a big VM.
  const MAX_USERS = Number(process.env.GD_MAX_USERS) || Math.max(1, Math.min(15, Math.floor((memMb - 350) / 110)));
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
      this.state = { v: 2, version: VERSION, hygiene: { readOnly: true, reconnectsLastHour: 0, blockedWrites: 0 }, status: 'starting', qr: null, me: null, groups: [], error: null, lastMessageAt: 0, at: 0 };
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
      this.archiveDir = join(dir, 'archive');
      this.toArchive = [];
      this.digestRun = null; // the scheduled digest in progress
      this.downSince = 0; // linked, but not connected to WhatsApp since then
      this.closes = new Limiter(1000, 3600e3); // connection drops in the last hour
      this.codes = new Limiter(5, 3600e3); // pairing codes asked of WhatsApp
      this.groupFetches = new Limiter(6, 3600e3);
      this.groupTimer = null;
      this.blockedWrites = 0;
      this.downAlerted = false;
      this.digestState = { lastKey: null, ends: {}, tries: 0, nextTry: 0, testSeen: null };
      this.activity = new Activity();
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
      try {
        Object.assign(this.digestState, JSON.parse(readFileSync(join(this.dir, 'digest-state.json'), 'utf8')));
      } catch {
        /* no digests yet */
      }
      try {
        this.activity = new Activity(JSON.parse(readFileSync(join(this.dir, 'activity.json'), 'utf8')));
      } catch {
        /* nothing seen yet */
      }
    }

    // ---- notices: small sealed notes the Worker pushes to this person's phones ----

    async notice(title, body, tag = 'notice') {
      try {
        const blob = await seal(this.keys, 'notice', { title: String(title).slice(0, 120), body: String(body).slice(0, 1200), tag, at: Date.now() });
        await relay(this.keys, 'POST', 'notice', { blob, tag });
      } catch (e) {
        log(this.label(), 'notice failed:', e.message);
      }
    }

    // ---- archive: chosen groups kept on disk, encrypted, for scheduled digests ----

    keepDays() {
      const d = this.config.digest;
      if (!d?.on) return 0;
      return d.freq === 'weekly' ? 9 : 3;
    }

    keep(rec) {
      if (this.keepDays() > 0) this.toArchive.push(rec);
    }

    async writeArchive() {
      if (!this.toArchive.length) return;
      const batch = this.toArchive;
      this.toArchive = [];
      try {
        mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
        const line = await seal(this.keys, 'archive', batch);
        appendFileSync(join(this.archiveDir, `${new Date().toISOString().slice(0, 10)}.log`), line + '\n', { mode: 0o600 });
      } catch (e) {
        log(this.label(), 'archive write failed:', e.message);
      }
    }

    async readArchive(since) {
      const out = new Map();
      let files = [];
      try {
        files = readdirSync(this.archiveDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
      } catch {
        return [];
      }
      const fromDay = new Date(since - 864e5).toISOString().slice(0, 10);
      for (const f of files) {
        if (f.slice(0, 10) < fromDay) continue;
        for (const line of readFileSync(join(this.archiveDir, f), 'utf8').split('\n')) {
          if (!line) continue;
          try {
            for (const m of await open(this.keys, 'archive', line)) if (m.ts > since) out.set(m.id, m);
          } catch {
            /* written with an old key */
          }
        }
      }
      return [...out.values()].sort((a, b) => a.ts - b.ts);
    }

    pruneArchive() {
      const days = this.keepDays();
      if (!days) {
        if (existsSync(this.archiveDir)) rmSync(this.archiveDir, { recursive: true, force: true });
        return;
      }
      const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      try {
        for (const f of readdirSync(this.archiveDir)) if (f.slice(0, 10) < cutoff) rmSync(join(this.archiveDir, f), { force: true });
      } catch {
        /* nothing kept yet */
      }
    }

    saveDigestState() {
      try {
        writeFileSync(join(this.dir, 'digest-state.json'), JSON.stringify(this.digestState), { mode: 0o600 });
      } catch (e) {
        log(this.label(), 'could not save digest state:', e.message);
      }
    }

    // ---- scheduled digests -----------------------------------------------------------

    hygiene() {
      return { readOnly: true, reconnectsLastHour: this.closes.count(), blockedWrites: this.blockedWrites };
    }

    /** Called every minute: one alert when a linked account cannot reach WhatsApp for an hour. */
    checkHealth() {
      if (this.downSince && !this.downAlerted && Date.now() - this.downSince > 60 * 60e3) {
        this.downAlerted = true;
        this.notice(
          'Sync server cannot reach WhatsApp',
          'It has been trying for an hour. It keeps trying by itself; if this lasts, open Oracle Cloud, open your instance and press Reboot.',
          'health',
        );
      }
    }

    /** Called every minute. Runs the person's digest when it is due (or when they asked for a test). */
    async maybeDigest() {
      const d = this.config.digest;
      if (!d?.on || this.digestRun || this.stopped) return;
      const st = this.digestState;
      const test = Number(d.testAt) || 0;
      if (st.testSeen === null) st.testSeen = test; // first run: ignore old test requests
      const wantTest = test > st.testSeen && Date.now() - test < 30 * 60e3;
      const key = duePeriod(d);
      const wantScheduled = key && key !== st.lastKey && Date.now() >= (st.nextTry || 0);
      if (!wantTest && !wantScheduled) return;
      this.digestRun = this.runDigest(d, wantTest ? 'test' : key)
        .catch((e) => log(this.label(), 'digest run failed:', e.message))
        .finally(() => (this.digestRun = null));
    }

    async runDigest(d, key) {
      const test = key === 'test';
      const st = this.digestState;
      if (test) st.testSeen = Number(d.testAt) || 0;
      await this.writeArchive();
      const span = d.freq === 'weekly' ? 7 : 1;
      const floor = Date.now() - span * 864e5 - 3600e3;
      const groups = (Array.isArray(d.groups) && d.groups.length ? d.groups : [...this.selected]).filter((g) => this.selected.has(g));
      const since = Math.min(...groups.map((g) => (test ? floor : Math.max(floor, st.ends[g] || 0))), Date.now());
      const all = await this.readArchive(since);
      const out = [];
      let failure = null;
      for (const g of groups) {
        const from = test ? floor : Math.max(floor, st.ends[g] || 0);
        const msgs = all.filter((m) => m.group === g && m.ts > from);
        if (!msgs.length) continue;
        const chat = msgs[msgs.length - 1].chat || this.groupNames.get(g) || g;
        try {
          const r = await summarizeGroup(
            d.ai,
            d.models,
            { chatName: chat, focus: (d.focus && d.focus[chat]) || '', language: d.language || 'English', timeZone: d.tz || 'UTC' },
            msgs,
            { referer: cfg.relay },
          );
          out.push({ group: g, chat, from: r.from, to: r.to, messageCount: r.count, model: `${d.ai.provider}/${r.model}`, digest: r.digest });
        } catch (e) {
          log(this.label(), `digest for one group failed: ${e.message}`);
          failure = e;
          if (e.status === 401 || e.status === 403 || e.status === 402) break; // the same for every group
        }
        await new Promise((r) => setTimeout(r, 3000)); // gentle on free AI limits
      }
      const label = test ? 'Test digest' : d.freq === 'weekly' ? 'Weekly digest' : 'Daily digest';
      if (out.length) {
        await relay(this.keys, 'POST', 'messages', { blob: await seal(this.keys, 'messages', { v: 2, messages: [], digests: out }) });
        const lines = out.map((x) => `${x.chat}: ${x.digest.headline}`);
        await this.notice(`${label}: ${out.length} group${out.length === 1 ? '' : 's'}`, lines.join('\n'), 'digest');
      }
      if (failure && (!out.length || test)) {
        // Nothing made: try again in 20 minutes, up to 3 times, then tell the person.
        if (!test && ++st.tries < 3 && failure.status !== 401 && failure.status !== 403) {
          st.nextTry = Date.now() + 20 * 60e3;
          this.saveDigestState();
          return;
        }
        await this.notice(`${label} not made`, friendlyAiError(failure), 'digest-error');
      } else if (!out.length && test) {
        await this.notice('Test digest', 'No new messages in your chosen groups in the last day, so there was nothing to summarize.', 'digest');
      }
      if (!test) {
        for (const x of out) st.ends[x.group] = x.to;
        st.lastKey = key;
        st.tries = 0;
        st.nextTry = 0;
      }
      this.saveDigestState();
      log(this.label(), `${label.toLowerCase()} done: ${out.length} groups`);
    }

    setState(patch) {
      Object.assign(this.state, patch);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.pushState(), patch.qr ? 0 : 1500);
    }

    /** Put each group's last activity in the state, and save it now and then. */
    applyActivity() {
      for (const g of this.state.groups) if (this.activity.last[g.id]) g.last = this.activity.last[g.id];
      if (!this.activity.dirty) return;
      this.activity.dirty = false;
      try {
        writeFileSync(join(this.dir, 'activity.json'), JSON.stringify(this.activity.last), { mode: 0o600 });
      } catch (e) {
        log(this.label(), 'could not save group activity:', e.message);
      }
    }

    async pushState(force = false) {
      if (this.stopped && this.state.status !== 'removed') return;
      this.state.at = Date.now();
      this.applyActivity();
      if (this.owner) {
        this.state.host = host.summary();
        this.state.backupAt = lastBackupAt;
      }
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
        if (!this.keepDays()) this.pruneArchive();
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
        const share = c.share?.status !== false;
        if (!this.owner && this.lastShare !== undefined && share !== this.lastShare) sessions.get(cfg.room)?.pushState();
        this.lastShare = share;
        if (this.owner) await host.ownerConfig(c);
      } catch (e) {
        log(this.label(), 'config poll failed:', e.message);
      }
    }

    async requestCode(s) {
      if (this.pairDone === s || !this.pairPhone || Date.now() - this.pairAt > LINK_WINDOW_MS) return;
      this.pairDone = s;
      const reusing = this.lastCode && this.lastCode.phone === this.pairPhone && Date.now() - this.lastCode.at < 3 * 60e3;
      if (!reusing && !this.codes.allow()) {
        this.setState({ error: 'Too many codes asked for in the last hour. Wait a while, then try again.' });
        return;
      }
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
          this.keep(h.msg);
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

    /** Group names change rarely: ask WhatsApp at most a few times an hour, batched. */
    refreshGroupsSoon(delay = jitter(20e3, 60e3)) {
      clearTimeout(this.groupTimer);
      this.groupTimer = setTimeout(() => this.refreshGroups(), delay);
    }

    async refreshGroups() {
      if (!this.sock) return;
      if (!this.groupFetches.allow()) return this.refreshGroupsSoon(15 * 60e3);
      try {
        const all = await this.sock.groupFetchAllParticipating();
        const groups = Object.values(all)
          .map((g) => ({ id: g.id, name: g.subject || g.id, size: g.participants?.length || 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const g of groups) this.groupNames.set(g.id, g.name);
        if (groups.length) this.activity.keepOnly(groups.map((g) => g.id));
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
      rmSync(this.archiveDir, { recursive: true, force: true });
      rmSync(join(this.dir, 'activity.json'), { force: true });
      this.activity = new Activity();
      this.toArchive.length = 0;
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

    /** One WhatsApp connection per person, ever: a second one in parallel would fight the first. */
    async connect() {
      if (this.stopped || this.sock || this.connecting) return;
      this.connecting = true;
      try {
        await this.openSocket();
      } finally {
        this.connecting = false;
      }
    }

    async openSocket() {
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
      makeReadOnly(s, (name) => {
        this.blockedWrites++;
        log(this.label(), `blocked ${name}: the sync server is read-only`);
      });
      s.ev.on('creds.update', saveCreds);

      // Watchdog: if WhatsApp neither connects nor sends a QR code in 90 s, start over.
      let progressed = false;
      setTimeout(() => {
        if (this.sock !== s || progressed) return;
        log(this.label(), 'no answer from WhatsApp in 90s, retrying');
        if (!this.downSince && auth.creds.registered) this.downSince = Date.now();
        this.setState({ status: this.state.status === 'connected' ? 'starting' : this.state.status, error: 'Cannot reach WhatsApp from the server yet, retrying' });
        this.sock = null;
        s.end(undefined);
        this.closes.allow();
        setTimeout(() => this.connect(), reconnectDelay(this.retry++, this.closes.count()));
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
          const wasNew = !this.state.me;
          if (wasNew) backupSoon();
          this.downSince = 0;
          if (this.downAlerted) {
            this.downAlerted = false;
            this.notice('Connected to WhatsApp again', 'Live sync is working again.', 'health');
          } else if (wasNew && this.linkRequestedAt && Date.now() - Math.max(this.linkRequestedAt, this.pairAt) < LINK_WINDOW_MS) {
            this.notice('WhatsApp linked', 'Your sync server is linked. Pick the groups to sync in Group Digest.', 'health');
          }
          this.pairPhone = null;
          this.setState({ status: 'connected', qr: null, code: null, me, error: null });
          this.refreshGroupsSoon(jitter(3e3, 15e3));
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          this.sock = null;
          if (this.stopped) return;
          if (code === DisconnectReason.loggedOut) {
            log(this.label(), 'logged out from the phone; waiting for a new link');
            this.downSince = 0;
            this.notice(
              'WhatsApp unlinked your sync server',
              'Live sync stopped: the linked device was logged out, from your phone or by WhatsApp. Open Group Digest, Live sync, to link again.',
              'unlinked',
            );
            rmSync(this.authDir, { recursive: true, force: true });
            this.setState({ status: 'unlinked', qr: null, me: null, groups: [], error: 'Logged out from the phone' });
            return;
          }
          if (code === DisconnectReason.connectionReplaced) {
            this.setState({ status: 'error', error: 'Another copy of the sync server took over this link' });
            if (!this.replacedAlerted) {
              this.replacedAlerted = true;
              this.notice('Two sync servers on one link', 'Another copy of the sync server took over this WhatsApp link. Turn off the old VM if you made a new one.', 'health');
            }
          }
          if (!this.downSince && auth.creds.registered) this.downSince = Date.now();
          this.closes.allow();
          const wait = code === DisconnectReason.restartRequired ? 0 : reconnectDelay(this.retry++, this.closes.count());
          this.setState({ hygiene: this.hygiene() });
          log(this.label(), `connection closed (${code ?? 'no code'}), reconnecting in ${Math.round(wait / 1000)}s`);
          setTimeout(() => this.connect(), wait);
        }
      });

      s.ev.on('chats.upsert', (cs) => cs.forEach((c) => this.activity.noteChat(c)));
      s.ev.on('chats.update', (cs) => cs.forEach((c) => this.activity.noteChat(c)));
      s.ev.on('groups.upsert', () => this.refreshGroupsSoon());
      s.ev.on('groups.update', (ups) => {
        if (ups.some((g) => g.subject)) this.refreshGroupsSoon();
      });

      s.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;
        for (const msg of messages) {
          const group = msg.key?.remoteJid;
          if (type === 'notify') this.activity.noteMessage(msg);
          if (!group || !this.selected.has(group) || this.seen.has(msg.key.id)) continue;
          const rec = this.record(msg);
          if (!rec) continue;
          this.remember(rec.id);
          this.queue.push(rec);
          this.keep(rec);
        }
      });

      // Recent history sent right after linking, kept in memory for an hour so
      // groups chosen just after linking start with recent messages.
      s.ev.on('messaging-history.set', ({ messages, chats }) => {
        for (const c of chats || []) this.activity.noteChat(c);
        for (const m of messages || []) this.activity.noteMessage(m);
        const keptAt = Date.now();
        const recent = keptAt - 14 * 864e5;
        for (const msg of messages || []) {
          const rec = this.record(msg);
          if (!rec || rec.ts < recent) continue;
          if (this.selected.has(rec.group)) {
            if (!this.seen.has(rec.id)) {
              this.remember(rec.id);
              this.queue.push(rec);
              this.keep(rec);
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
  let restoredFrom = 0; // when the restored backup was made
  let lastBackupAt = 0;
  let backupSoon = () => {};
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
        // Each friend chooses whether the owner sees their link status and last sync.
        members: this.friends().map((s) => {
          const show = s.config.share?.status !== false;
          return {
            room: s.room,
            name: s.name,
            code: s.code,
            joinedAt: s.joinedAt,
            status: show ? s.state.status : 'hidden',
            lastMessageAt: show ? s.state.lastMessageAt : 0,
          };
        }),
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
      if (Date.now() - (Number(invite.createdAt) || 0) > INVITE_DAYS * 864e5) return this.refuse(note, 'This invite has expired. Ask for a new one.');
      if (this.friends().some((s) => s.code === note.code)) return this.refuse(note, 'This invite was already used. Ask for a new one.');
      if (this.friends().length >= MAX_USERS) return this.refuse(note, 'This sync server is full right now.');
      const name = String(note.name || invite.name || '').slice(0, 60) || null;
      const s = new Session({ room: note.room, secret: note.secret, dir: join(USERS, note.room), name, code: note.code });
      await s.init();
      writeFileSync(join(s.dir, 'user.json'), JSON.stringify({ room: s.room, secret: s.secret, name, code: s.code, joinedAt: s.joinedAt }), { mode: 0o600 });
      sessions.set(s.room, s);
      s.setState({ status: 'starting' });
      log(`friend ${s.room.slice(0, 6)} joined (${sessions.size - 1} of ${MAX_USERS})`);
      backupSoon();
      await s.pollConfig();
      await s.connect();
      sessions.get(cfg.room)?.pushState();
    },

    async remove(room, why) {
      const s = sessions.get(room);
      if (!s || s.owner) return;
      log(`friend ${room.slice(0, 6)} ${why}`);
      backupSoon();
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
      const files = await serverFiles();
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
    for (const s of sessions.values()) await s.writeArchive();
    for (const s of sessions.values()) await s.stop();
    process.exit(code);
  }

  // ---- start --------------------------------------------------------------------------------

  log(`Group Digest sync ${VERSION} starting, relay ${cfg.relay}, room for ${MAX_USERS} friends`);
  const ownerKeys = await deriveKeys(cfg.room, cfg.secret);
  const ownerCall = (method, op, body, query = '') => relay(ownerKeys, method, op, body, query);

  // A new VM made with the same setup script: bring back the links and friends from the last backup.
  if (backup.isFreshInstall(DATA)) {
    try {
      const got = await backup.download(ownerCall, ownerKeys, 'server');
      if (got) {
        const n = backup.restore(DATA, got.value.files || {});
        log(`restored ${n} files from the backup of ${new Date(got.at).toISOString()}`);
        restoredFrom = got.at;
      }
    } catch (e) {
      log('no backup restored:', e.message);
    }
  }

  let backupTimer = null;
  async function backupNow() {
    try {
      for (const s of sessions.values()) await s.writeArchive();
      const size = await backup.upload(ownerCall, ownerKeys, 'server', { v: 1, version: VERSION, at: Date.now(), files: backup.collect(DATA) });
      lastBackupAt = Date.now();
      log(`server backup saved (${Math.round(size / 1024)} KB)`);
    } catch (e) {
      log('server backup failed:', e.message);
    }
  }
  /** Back up soon (after a link or a friend joining), at most once per few minutes. */
  backupSoon = () => {
    clearTimeout(backupTimer);
    backupTimer = setTimeout(backupNow, 3 * 60e3);
  };
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
    await new Promise((r) => setTimeout(r, jitter(3e3, 8e3))); // stagger reconnects, like separate devices
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
    for (const s of sessions.values()) s.flush().then(() => s.writeArchive());
  }, 15e3);
  setInterval(() => {
    for (const s of sessions.values()) {
      s.checkHealth();
      s.maybeDigest();
    }
  }, 60e3);
  setInterval(() => {
    for (const s of sessions.values()) s.pruneArchive();
  }, 6 * 3600e3);
  setInterval(() => {
    for (const s of sessions.values()) {
      s.pruneHistory();
      s.pushState(true);
    }
  }, 15 * 60e3);
  setInterval(() => {
    for (const s of sessions.values()) s.refreshGroupsSoon(jitter(0, 3600e3));
  }, 24 * 3600e3);
  setTimeout(backupNow, Number(process.env.GD_BACKUP_AFTER_MS) || 10 * 60e3);
  setInterval(backupNow, 24 * 3600e3);
  if (restoredFrom) setTimeout(() => owner.notice('Sync server restored', `This server came back from the backup of ${new Date(restoredFrom).toUTCString()}. WhatsApp links and friends carried over.`, 'health'), 60e3);
  setTimeout(checkForUpdate, 5 * 60e3);
  setInterval(checkForUpdate, 6 * 3600e3);

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
}
