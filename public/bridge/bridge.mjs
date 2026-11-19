// Group Digest sync server.
//
// Links one WhatsApp account as a linked device (like WhatsApp Web), and
// forwards new messages from the groups chosen in the app. It only makes
// outgoing connections: to WhatsApp, and to the relay in the app's own
// Cloudflare Worker. Everything sent to the relay is end-to-end encrypted with
// a secret that only this server and the app know.
//
// Message text is held in memory only until it is handed to the relay (a few
// seconds), and is never written to disk or logs. The only thing on disk is
// the WhatsApp link itself (auth/), so restarts reconnect without a new scan.
//
// Config: /etc/group-digest/sync.json  {"relay": "https://...", "room": "...", "secret": "..."}
//   or env GD_RELAY, GD_ROOM, GD_SECRET.  Data dir: GD_DATA (default /var/lib/group-digest).

import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
import { deriveKeys, open, seal } from './crypto.mjs';
import { toRecord as parseMessage } from './parse.mjs';

const groupNames = new Map();
const toRecord = (msg) => parseMessage(msg, groupNames, state.me?.name);

const VERSION = '0.1.0';
const DATA = process.env.GD_DATA || '/var/lib/group-digest';
const AUTH_DIR = join(DATA, 'auth');
const LINK_WINDOW_MS = 10 * 60e3; // show QR codes for 10 minutes after the app asks
const CONFIG_EVERY_MS = 45e3;
const FLUSH_EVERY_MS = 15e3;
const HEARTBEAT_MS = 5 * 60e3;
const HISTORY_KEEP_MS = 60 * 60e3; // recent history from the first link, kept in memory for an hour
const HISTORY_MAX = 5000;

function loadConfig() {
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
}

const cfg = loadConfig();
const keys = await deriveKeys(cfg.room, cfg.secret);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const quiet = pino({ level: process.env.GD_DEBUG ? 'debug' : 'silent' });

// ---- relay ------------------------------------------------------------------

async function relay(method, op, body) {
  const res = await fetch(`${cfg.relay}/api/sync/${cfg.room}/${op}`, {
    method,
    headers: { authorization: `Bearer ${keys.token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20e3),
  });
  if (!res.ok) throw new Error(`relay ${op} ${res.status}`);
  return res.json();
}

// ---- state shown in the app ---------------------------------------------------

const state = { v: 1, version: VERSION, status: 'starting', qr: null, me: null, groups: [], error: null, lastMessageAt: 0, at: 0 };
let stateTimer = null;
let lastPushedState = '';

function setState(patch) {
  Object.assign(state, patch);
  clearTimeout(stateTimer);
  stateTimer = setTimeout(pushState, patch.qr ? 0 : 1500);
}

async function pushState(force = false) {
  state.at = Date.now();
  const { at: _at, ...rest } = state;
  const sig = JSON.stringify(rest);
  if (!force && sig === lastPushedState) return;
  try {
    await relay('PUT', 'state', { blob: await seal(keys, 'state', state) });
    lastPushedState = sig;
  } catch (e) {
    log('state push failed:', e.message);
    clearTimeout(stateTimer);
    stateTimer = setTimeout(pushState, 30e3);
  }
}

// ---- config from the app --------------------------------------------------------

let selected = new Set();
let linkRequestedAt = 0;
let unlinkSeen = null;

async function pollConfig() {
  try {
    const r = await relay('GET', 'config');
    if (!r.blob) return;
    const c = await open(keys, 'config', r.blob);
    const before = selected;
    selected = new Set(Array.isArray(c.groups) ? c.groups : []);
    const added = [...selected].filter((g) => !before.has(g));
    if (added.length) queueHistory(added);
    const wantLink = Number(c.linkRequestedAt) || 0;
    if (wantLink > linkRequestedAt) {
      linkRequestedAt = wantLink;
      if (!sock && Date.now() - linkRequestedAt < LINK_WINDOW_MS) connect();
    }
    if (unlinkSeen === null) {
      try {
        unlinkSeen = Number(readFileSync(join(DATA, 'unlink-seen'), 'utf8')) || 0;
      } catch {
        unlinkSeen = Number(c.unlink) || 0; // first run: nothing to undo
      }
    }
    if ((Number(c.unlink) || 0) > unlinkSeen) {
      unlinkSeen = Number(c.unlink);
      log('unlink requested from the app');
      await unlink();
    }
    writeFileSync(join(DATA, 'unlink-seen'), String(unlinkSeen));
  } catch (e) {
    log('config poll failed:', e.message);
  }
}

// ---- outgoing messages ------------------------------------------------------------

let queue = [];
const seenIds = new Set();
const history = []; // {group, msg} from the first-link history sync, in memory only

function remember(id) {
  seenIds.add(id);
  if (seenIds.size > 20000) seenIds.delete(seenIds.values().next().value);
}

async function flush() {
  if (!queue.length) return;
  const batch = queue.slice(0, 500);
  try {
    await relay('POST', 'messages', { blob: await seal(keys, 'messages', { v: 1, messages: batch }) });
    queue = queue.slice(batch.length);
    setState({ lastMessageAt: Date.now() });
    if (queue.length) setTimeout(flush, 1000);
  } catch (e) {
    log('flush failed, will retry:', e.message);
    if (queue.length > 20000) queue = queue.slice(-20000);
  }
}

function queueHistory(groupIds) {
  const want = new Set(groupIds);
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  let n = 0;
  for (const h of history) {
    if (h.keptAt >= cutoff && want.has(h.group) && !seenIds.has(h.msg.id)) {
      queue.push(h.msg);
      remember(h.msg.id);
      n++;
    }
  }
  if (n) log(`queued ${n} recent messages for newly chosen groups`);
}

// ---- WhatsApp -----------------------------------------------------------------------

let sock = null;
let retry = 0;

async function refreshGroups() {
  if (!sock) return;
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all)
      .map((g) => ({ id: g.id, name: g.subject || g.id, size: g.participants?.length || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const g of groups) groupNames.set(g.id, g.name);
    setState({ groups });
  } catch (e) {
    log('group list failed:', e.message);
  }
}

async function unlink() {
  try {
    await sock?.logout();
  } catch {
    /* already gone */
  }
  sock?.end?.(undefined);
  sock = null;
  rmSync(AUTH_DIR, { recursive: true, force: true });
  history.length = 0;
  setState({ status: 'unlinked', qr: null, me: null, groups: [], error: null });
}

async function connect() {
  mkdirSync(AUTH_DIR, { recursive: true });
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- Baileys helper, not a React hook
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const linked = !!auth.creds.registered;
  if (!linked && Date.now() - linkRequestedAt > LINK_WINDOW_MS) {
    // Not linked and nobody is looking at the app's link screen: stay idle.
    setState({ status: 'unlinked', qr: null });
    return;
  }
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    /* use the bundled one */
  }
  // Optional outbound proxy (GD_PROXY=http://host:port), needs `npm i https-proxy-agent`.
  let agent;
  if (process.env.GD_PROXY) agent = new (await import('https-proxy-agent')).HttpsProxyAgent(process.env.GD_PROXY);
  const s = makeWASocket({
    auth,
    agent,
    fetchAgent: agent,
    version,
    logger: quiet,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false, // keep phone notifications working
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    shouldSyncHistoryMessage: () => true,
    getMessage: async () => undefined,
  });
  sock = s;
  // Watchdog: if WhatsApp neither connects nor sends a QR code in 90 s, start over.
  let progressed = false;
  setTimeout(() => {
    if (sock !== s || progressed) return;
    log('no answer from WhatsApp in 90s, retrying');
    setState({ status: state.status === 'connected' ? 'starting' : state.status, error: 'Cannot reach WhatsApp from the server yet, retrying' });
    sock = null;
    s.end(undefined);
    setTimeout(connect, Math.min(5 * 60e3, 5000 * 2 ** retry++));
  }, 90e3);
  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (u) => {
    if (sock !== s) return;
    if (u.qr || u.connection === 'open') progressed = true;
    if (u.qr) {
      if (Date.now() - linkRequestedAt > LINK_WINDOW_MS) {
        log('link window closed, stopping QR codes');
        sock = null;
        s.end(undefined);
        setState({ status: 'unlinked', qr: null });
        return;
      }
      setState({ status: 'qr', qr: u.qr, error: null });
    }
    if (u.connection === 'open') {
      retry = 0;
      const me = s.user ? { name: s.user.name || s.user.verifiedName || null, number: (s.user.id || '').split(':')[0].split('@')[0] } : null;
      log('connected');
      setState({ status: 'connected', qr: null, me, error: null });
      refreshGroups();
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      sock = null;
      if (code === DisconnectReason.loggedOut) {
        log('logged out from the phone; waiting for a new link');
        rmSync(AUTH_DIR, { recursive: true, force: true });
        setState({ status: 'unlinked', qr: null, me: null, groups: [], error: 'Logged out from the phone' });
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        setState({ status: 'error', error: 'Another copy of the sync server took over this link' });
      }
      const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(5 * 60e3, 2000 * 2 ** retry++);
      log(`connection closed (${code ?? 'no code'}), reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(connect, wait);
    }
  });

  s.ev.on('groups.upsert', refreshGroups);
  s.ev.on('groups.update', (ups) => {
    if (ups.some((g) => g.subject)) refreshGroups();
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      const group = msg.key?.remoteJid;
      if (!group || !selected.has(group) || seenIds.has(msg.key.id)) continue;
      const rec = toRecord(msg);
      if (!rec) continue;
      remember(rec.id);
      queue.push(rec);
    }
  });

  // Recent history sent right after linking. Kept in memory for an hour so the
  // groups chosen in the app just after linking start with recent messages.
  s.ev.on('messaging-history.set', ({ messages }) => {
    const keptAt = Date.now();
    const recent = keptAt - 14 * 864e5;
    for (const msg of messages || []) {
      const rec = toRecord(msg);
      if (!rec || rec.ts < recent) continue;
      if (selected.has(rec.group)) {
        if (!seenIds.has(rec.id)) {
          remember(rec.id);
          queue.push(rec);
        }
      } else {
        history.push({ group: rec.group, msg: rec, keptAt });
      }
    }
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  });
}

// ---- main -------------------------------------------------------------------------------

log(`Group Digest sync ${VERSION} starting, relay ${cfg.relay}`);
setState({ status: 'starting' });
await pollConfig();
await connect();
setInterval(pollConfig, CONFIG_EVERY_MS);
setInterval(flush, FLUSH_EVERY_MS);
setInterval(() => pushState(true), HEARTBEAT_MS);
setInterval(refreshGroups, 6 * 3600e3);
setInterval(() => {
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  while (history.length && history[0].keptAt < cutoff) history.shift();
}, 5 * 60e3);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('stopping');
    await flush();
    sock?.end?.(undefined);
    process.exit(0);
  });
}
