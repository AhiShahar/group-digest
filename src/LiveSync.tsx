// Settings section: live WhatsApp sync through your own small server.
// Styling uses the shared classes from styles.css (card, row, small, muted...).
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import {
  createPairing,
  inviteLink,
  joinWithInvite,
  newInvite,
  parseInvite,
  type ParsedInvite,
  fetchState,
  gcloudCommand,
  installLine,
  loadPairing,
  oracleScript,
  pushConfig,
  dropPending,
  savePairing,
  type BridgeState,
  type SyncPairing,
  INVITE_DAYS,
  inviteExpired,
} from './lib/liveSync';
import type { AppSettings } from './lib/store';
import Scheduled, { AlertsToggle, RecentNotices } from './Scheduled';
import { turnOffNotices } from './lib/schedule';

type Host = 'oracle' | 'google' | 'computer';

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function Copy({ text, label = 'Copy', onToast }: { text: string; label?: string; onToast: (s: string) => void }) {
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          onToast('Copied.');
        } catch {
          onToast('Could not copy. Select the text and copy it by hand.');
        }
      }}
    >
      {label}
    </button>
  );
}

function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 2, width: 280, errorCorrectionLevel: 'L' }).then(setSrc, () => setSrc(''));
  }, [value]);
  return src ? <img className="sync-qr" src={src} alt="QR code to link WhatsApp" width={280} height={280} style={{ background: '#fff', borderRadius: 12 }} /> : null;
}

function SetupSteps({ p, onToast }: { p: SyncPairing; onToast: (s: string) => void }) {
  const [host, setHost] = useState<Host>('oracle');
  const code = host === 'oracle' ? oracleScript(p) : host === 'google' ? gcloudCommand(p) : installLine(p);
  return (
    <>
      <h3>1. Start your sync server</h3>
      <div className="row">
        <button className={host === 'oracle' ? 'primary' : ''} onClick={() => setHost('oracle')}>
          Oracle Cloud (free)
        </button>
        <button className={host === 'google' ? 'primary' : ''} onClick={() => setHost('google')}>
          Google Cloud
        </button>
        <button className={host === 'computer' ? 'primary' : ''} onClick={() => setHost('computer')}>
          My computer
        </button>
      </div>
      {host === 'oracle' && (
        <ol className="small">
          <li>
            Open{' '}
            <a href="https://cloud.oracle.com/compute/instances/create" target="_blank" rel="noreferrer">
              Oracle Cloud, Create instance
            </a>{' '}
            (sign up for the Always Free tier first if you have no account).
          </li>
          <li>
            Image: <b>Ubuntu 24.04</b>. Shape: <b>Ampere VM.Standard.A1.Flex</b> with 1 OCPU and 1 GB memory (if it says out of capacity, use{' '}
            <b>VM.Standard.E2.1.Micro</b>). SSH keys: <b>No SSH keys</b> is fine.
          </li>
          <li>
            Under <b>Show advanced options</b>, <b>Management</b>, choose <b>Paste cloud-init script</b> and paste the script below.
          </li>
          <li>Press Create. Setup takes about 5 minutes, then this screen moves on by itself.</li>
        </ol>
      )}
      {host === 'google' && (
        <>
          <ol className="small">
            <li>
              Open{' '}
              <a href="https://shell.cloud.google.com/?show=terminal" target="_blank" rel="noreferrer">
                Google Cloud Shell
              </a>
              .
            </li>
            <li>Paste the command below and press Enter. If asked, allow Cloud Shell and pick your project.</li>
          </ol>
          <p className="small warn">
            Google bills the VM's public IP address, about $3.65 a month, after the trial credit. The VM and disk themselves are in the free tier.
          </p>
        </>
      )}
      {host === 'computer' && (
        <p className="small">
          On a Linux computer or Raspberry Pi that stays on, paste this into a terminal. Live sync only works while it is on and online.
        </p>
      )}
      <pre className="sync-code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, userSelect: 'all' }}>
        {code}
      </pre>
      <div className="row">
        <Copy text={code} label={host === 'oracle' ? 'Copy script' : 'Copy command'} onToast={onToast} />
      </div>
      <p className="small muted">This contains your private sync key. Do not share it.</p>
    </>
  );
}

function Friends({ p, st, onUpdate, onToast }: { p: SyncPairing; st: BridgeState; onUpdate: (p: SyncPairing) => Promise<void>; onToast: (s: string) => void }) {
  const [name, setName] = useState('');
  const [lastLink, setLastLink] = useState<string | null>(null);
  const host = st.host;
  if (!host) return null;
  const members = host.members;
  const used = new Set(members.map((m) => m.code));
  const pending = (p.invites ?? []).filter((i) => !used.has(i.code));
  const open = pending.filter((i) => !inviteExpired(i));
  const from = st.me?.name ?? '';
  return (
    <>
      <h3>Friends on your server</h3>
      <p className="small muted">
        Invite someone and they can link their own WhatsApp to your server with no setup. Each person has their own link and key: their
        messages go to their phone only and never show in your app. You see their name and, if they allow it, whether they are linked.{' '}
        {members.length} of {host.max} places used.
      </p>
      <div className="row">
        <input placeholder="Friend's name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button
          className="primary"
          disabled={!name.trim() || members.length + open.length >= host.max}
          onClick={async () => {
            const inv = newInvite(name);
            const next = { ...p, host: { inbox: host.inbox, pub: host.pub }, invites: [...(p.invites ?? []), inv] };
            await onUpdate(next);
            const link = inviteLink(next, inv, from);
            setLastLink(link);
            setName('');
            try {
              if (navigator.share) await navigator.share({ title: 'Group Digest invite', text: `Join my Group Digest live sync: ${link}` });
              else {
                await navigator.clipboard.writeText(link);
                onToast('Invite link copied.');
              }
            } catch {
              /* share sheet closed */
            }
          }}
        >
          Create invite
        </button>
      </div>
      {lastLink && <InviteShare link={lastLink} from={from} onToast={onToast} />}
      {(members.length > 0 || pending.length > 0) && (
        <ul className="groups">
          {members.map((m) => (
            <li key={m.room} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {m.name || 'Friend'}{' '}
                <span className="muted small">
                  ·{' '}
                  {m.status === 'hidden'
                    ? 'keeps their status private'
                    : m.status === 'connected'
                      ? 'linked'
                      : m.status === 'qr' || m.status === 'code'
                        ? 'linking'
                        : m.status === 'unlinked'
                          ? 'not linked yet'
                          : m.status}
                  {m.lastMessageAt ? ` · last sync ${ago(m.lastMessageAt)}` : ''}
                </span>
              </span>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm(`Remove ${m.name || 'this friend'}? Their WhatsApp is unlinked from your server.`)) return;
                  await onUpdate({ ...p, remove: [...new Set([...(p.remove ?? []), m.room])] });
                  onToast('Removing. This takes up to a minute.');
                }}
              >
                Remove
              </button>
            </li>
          ))}
          {pending.map((i) => (
            <li key={i.code} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {i.name || 'Invite'}{' '}
                <span className="muted small">
                  · {inviteExpired(i) ? 'invite expired' : `invite not used yet, works for ${Math.max(1, Math.ceil((i.createdAt + INVITE_DAYS * 864e5 - Date.now()) / 864e5))} more day(s)`}
                </span>
              </span>
              <span className="row">
                {!inviteExpired(i) && <button onClick={() => setLastLink(inviteLink(p.host ? p : { ...p, host }, i, from))}>Share again</button>}
                <button onClick={() => onUpdate({ ...p, invites: (p.invites ?? []).filter((x) => x.code !== i.code) })}>
                  {inviteExpired(i) ? 'Remove' : 'Cancel'}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PhoneLink({ p, st, member, onUpdate }: { p: SyncPairing; st: BridgeState; member: boolean; onUpdate: (p: SyncPairing) => Promise<void> }) {
  const [phone, setPhone] = useState(p.pairPhone ?? '');
  const [open, setOpen] = useState(st.status === 'code' || (member && /Android|iPhone|iPad/i.test(navigator.userAgent)));
  const [asked, setAsked] = useState(false);
  if (st.version < '0.3.0') {
    return member ? null : (
      <p className="small muted">
        Linking on this same phone? Reboot your instance in Oracle Cloud once to get "Link with phone number", then come back here.
      </p>
    );
  }
  const digits = phone.replace(/\D/g, '').replace(/^00/, '');
  if (!open)
    return (
      <p className="small">
        <button className="link inline" onClick={() => setOpen(true)}>
          On this same phone? Link with your phone number instead
        </button>
      </p>
    );
  return (
    <>
      <label>
        Your WhatsApp number, with country code
        <input inputMode="tel" placeholder="+972 50 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </label>
      <div className="row">
        <button
          className={st.status === 'code' ? '' : 'primary'}
          disabled={digits.length < 8 || digits.length > 15}
          onClick={() => {
            setAsked(true);
            onUpdate({ ...p, pairPhone: digits, pairAt: Date.now(), linkRequestedAt: Date.now() });
          }}
        >
          {st.status === 'code' ? 'Get a new code' : 'Get a code'}
        </button>
        {asked && st.status !== 'code' ? <span className="small muted">Asking the server…</span> : null}
      </div>
    </>
  );
}

function InviteShare({ link, from, onToast }: { link: string; from: string; onToast: (s: string) => void }) {
  const text = `${from ? `${from} invited you` : "You're invited"} to Group Digest live sync. Open this link on your phone: ${link}`;
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <p className="small">
        <b>Send this to your friend.</b> They open it on their phone, type their name, and link WhatsApp there. It works once, for {INVITE_DAYS}{' '}
        days. Anyone with the link can use it, so send it privately.
      </p>
      <div className="row">
        <a className="btn primary" style={{ textDecoration: "none" }} href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
          Send on WhatsApp
        </a>
        <Copy text={link} label="Copy link" onToast={onToast} />
        {typeof navigator.share === 'function' && (
          <button
            onClick={() =>
              navigator.share({ title: 'Group Digest invite', text }).catch(() => {
                /* closed */
              })
            }
          >
            Share…
          </button>
        )}
      </div>
      <p className="small muted">Or, if they are next to you, they can scan this with their phone camera:</p>
      <Qr value={link} />
    </div>
  );
}

/** What a friend's host can and cannot see, and the switch for link status. */
function MemberPrivacy({ p, onUpdate }: { p: SyncPairing; onUpdate: (p: SyncPairing) => Promise<void> }) {
  const host = p.hostName || 'your friend';
  const showStatus = p.share?.status !== false;
  return (
    <details className="small">
      <summary>What {host} can see</summary>
      <ul>
        <li>Your name{showStatus ? ', whether your WhatsApp is linked, and when your messages last synced' : ' and that you joined'}.</li>
        <li>Not your groups, messages, digests or AI key: those are encrypted for this phone and never show in {host}'s app.</li>
        <li>
          The server runs on {host}'s cloud machine, which links your WhatsApp the way WhatsApp Web does. Only join a server of someone you
          trust, and press Leave any time to unlink and delete your data from it.
        </li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={showStatus} onChange={(e) => onUpdate({ ...p, share: { status: e.target.checked } })} />
        Let {host} see my link status and last sync (helps them spot problems)
      </label>
    </details>
  );
}

/** A friend's first steps after joining, until the basics are done. */
function MemberSteps({ p, st, settingsReady }: { p: SyncPairing; st: BridgeState | null; settingsReady: boolean }) {
  const steps = [
    { done: true, text: 'Join' },
    { done: st?.status === 'connected', text: 'Link your WhatsApp (below)' },
    { done: p.groups.length > 0, text: 'Tick the groups to sync' },
    { done: settingsReady, text: 'Connect a free AI at the top of this page' },
  ];
  if (steps.every((x) => x.done)) return null;
  return (
    <ol className="small steps">
      {steps.map((x, i) => (
        <li key={i} className={x.done ? 'muted' : ''}>
          {x.done ? '✓ ' : ''}
          {x.text}
        </li>
      ))}
    </ol>
  );
}

function JoinCard({ inv, onJoined, onToast }: { inv: ParsedInvite; onJoined: (p: SyncPairing) => void; onToast: (s: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="small">
        <b>{inv.from || 'A friend'}</b> invited you to live sync. Link your WhatsApp once and messages from the groups you choose flow into
        this app automatically, with no setup. They are encrypted on the way to this phone and never show in {inv.from || 'your friend'}'s app.
        The link runs on {inv.from || 'your friend'}'s cloud machine, so join only if you trust them; you can leave any time.
      </p>
      <p className="small muted">
        This uses an unofficial WhatsApp connection. WhatsApp could in rare cases restrict an account that uses one.
      </p>
      <label>
        Your name (so {inv.from || 'your friend'} knows who joined)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const p = await joinWithInvite(inv, name);
              history.replaceState(null, '', location.pathname + location.search);
              onJoined(p);
            } catch (e) {
              onToast(e instanceof Error ? e.message : String(e));
            }
            setBusy(false);
          }}
        >
          Join and link WhatsApp
        </button>
      </div>
    </>
  );
}

export default function LiveSync({ settings, onToast, onSynced }: { settings: AppSettings; onToast: (s: string) => void; onSynced: () => void }) {
  const settingsReady = settings.provider === 'compatible' || !!settings.apiKey;
  const [p, setP] = useState<SyncPairing | null | undefined>(undefined);
  const [st, setSt] = useState<BridgeState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const invite = useMemo(() => parseInvite(location.hash), []);

  useEffect(() => {
    loadPairing().then((v) => {
      setP(v ?? null);
      if (invite) setTimeout(() => document.getElementById('live-sync')?.scrollIntoView({ behavior: 'smooth' }), 100);
    });
  }, [invite]);

  const update = async (next: SyncPairing) => {
    setP(next);
    await savePairing(next);
    try {
      await pushConfig(next);
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
  };

  // Poll the server's status while this screen is open.
  useEffect(() => {
    if (!p) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await fetchState(p);
        if (stop) return;
        setSt(s);
        setErr(null);
        // The owner learns the server's invite key from its status.
        if (s?.host && p.role !== 'member' && (p.host?.pub !== s.host.pub || p.host?.inbox !== s.host.inbox)) {
          const next = { ...p, role: 'owner' as const, host: { inbox: s.host.inbox, pub: s.host.pub } };
          setP(next);
          await savePairing(next);
          return;
        }
        // Ask for QR codes when the server is up but not linked.
        if (s && s.status === 'unlinked' && Date.now() - p.linkRequestedAt > 8 * 60e3) await update({ ...p, linkRequestedAt: Date.now() });
      } catch (e) {
        if (!stop) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, st?.status === 'qr' || !st ? 4000 : 15000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, st?.status]);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (st?.groups ?? []).filter((g) => !f || g.name.toLowerCase().includes(f) || p?.groups.includes(g.id));
  }, [st?.groups, filter, p?.groups]);

  if (p === undefined) return null;

  const member = p?.role === 'member';
  const serverSeen = st ? Date.now() - st.at < 25 * 60e3 : false;
  const whose = member ? `${p?.hostName || 'your friend'}'s sync server` : 'Sync server';
  const forget = async () => {
    try {
      // Tell the server to unlink (and, for a friend, to drop us), and delete undelivered messages.
      await update({ ...p!, groups: [], unlink: p!.unlink + 1, linkRequestedAt: 0, leave: member ? true : undefined });
      await dropPending(p!);
      await turnOffNotices(p!);
    } catch {
      /* relay may already be gone */
    }
    await savePairing(null);
    setP(null);
    setSt(null);
  };

  return (
    <>
      <h2 id="live-sync">Live sync from WhatsApp</h2>
      <div className="card">
        {!p && invite && <JoinCard inv={invite} onJoined={setP} onToast={onToast} />}
        {!p && !invite && (
          <>
            <p className="small">
              Link WhatsApp once with a QR code, like WhatsApp Web, and messages from the groups you choose flow in automatically, on iPhone and
              Android. It runs on a small server of your own (free on Oracle Cloud), and messages are end-to-end encrypted between that server
              and this app.
            </p>
            <p className="small muted">
              Got an invite link from a friend? Open it on this phone instead. This uses an unofficial WhatsApp connection; WhatsApp could in
              rare cases restrict an account that uses one, so start with your own number.
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    setP(await createPairing());
                  } catch (e) {
                    onToast(e instanceof Error ? e.message : String(e));
                  }
                  setBusy(false);
                }}
              >
                Set up live sync
              </button>
            </div>
          </>
        )}
        {p && (
          <>
            {err && <p className="small warn">{err}</p>}
            {!st && !member && <SetupSteps p={p} onToast={onToast} />}
            {!st && <p className="small muted">{member ? `Waiting for ${whose}…` : 'Waiting for your server to check in…'}</p>}

            {st && st.status !== 'removed' && (
              <p className={serverSeen ? 'small ok' : 'small warn'}>
                {serverSeen ? `${whose} is online` : `${whose} last seen ${ago(st.at)}.${member ? '' : ' Check that the VM is running.'}`}
                {st.status === 'connected' && st.me ? ` · linked to ${st.me.name ?? ''} +${st.me.number}` : ''}
              </p>
            )}
            {st?.error && <p className="small warn">{st.error}</p>}
            {member && <MemberSteps p={p} st={st} settingsReady={settingsReady} />}
            {member && <MemberPrivacy p={p} onUpdate={update} />}
            {!member && st && st.status !== 'removed' && st.version >= '0.4.2' && (
              <p className="small muted">
                {st.backupAt ? `Server backup saved ${ago(st.backupAt)}: if the VM is ever lost, a new one made with the same setup script restores your WhatsApp link and friends.` : 'The server saves a backup of its WhatsApp link and friends about 10 minutes after it starts, then daily.'}
              </p>
            )}
            {st && st.status !== 'removed' && <AlertsToggle p={p} member={member} onUpdate={update} onToast={onToast} />}
            {!member && st && st.version < '0.2.0' && (
              <p className="small warn">
                Your server needs a one-time restart to get friend invites: in Oracle Cloud open your instance and press Reboot. It updates itself
                after that.
              </p>
            )}

            {st?.status === 'unlinked' && <p className="small">Getting a QR code from the server…</p>}
            {st?.status === 'starting' && <p className="small">Connecting to WhatsApp…</p>}

            {st?.status === 'qr' && st.qr && (
              <>
                <h3>{member ? 'Link WhatsApp' : '2. Link WhatsApp'}</h3>
                <p className="small">
                  On your phone open WhatsApp, then <b>Settings</b> (iPhone) or <b>⋮</b> (Android), <b>Linked devices</b>, <b>Link a device</b>,
                  and scan this code.
                </p>
                <Qr value={st.qr} />
              </>
            )}

            {st?.status === 'code' && st.code && (
              <>
                <h3>{member ? 'Link WhatsApp' : '2. Link WhatsApp'}</h3>
                <p className="sync-pair-code" style={{ fontSize: 34, fontWeight: 700, letterSpacing: 4, fontFamily: 'ui-monospace, monospace', margin: '8px 0' }}>
                  {st.code}
                </p>
                <div className="row">
                  <Copy text={st.code.replace('-', '')} label="Copy code" onToast={onToast} />
                </div>
                <ol className="small">
                  <li>
                    Open WhatsApp, then <b>Settings</b> (iPhone) or <b>⋮</b> (Android), <b>Linked devices</b>, <b>Link a device</b>.
                  </li>
                  <li>
                    On the scan screen, tap <b>Link with phone number instead</b>. WhatsApp may also show a notification asking for the code: tap it.
                  </li>
                  <li>Type the code above. It is good for a few minutes; if it changes, use the new one.</li>
                </ol>
              </>
            )}

            {st && ['qr', 'code', 'unlinked'].includes(st.status) && (
              <PhoneLink p={p} st={st} member={member} onUpdate={update} />
            )}

            {st?.status === 'connected' && (
              <>
                <h3>Groups to sync</h3>
                <p className="small muted">
                  Only ticked groups are sent to this app. New messages arrive within a minute or so while the app is open, and the rest are
                  waiting for you next time (up to 7 days).
                  {st.lastMessageAt ? ` Last message sent ${ago(st.lastMessageAt)}.` : ''}
                </p>
                {st.groups.length > 8 && <input placeholder="Search groups" value={filter} onChange={(e) => setFilter(e.target.value)} />}
                {st.groups.length === 0 ? (
                  <p className="small muted">Loading your groups…</p>
                ) : (
                  <ul className="groups">
                    {groups.map((g) => (
                      <li key={g.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={p.groups.includes(g.id)}
                            onChange={async (e) => {
                              const next = e.target.checked ? [...new Set([...p.groups, g.id])] : p.groups.filter((x) => x !== g.id);
                              await update({ ...p, groups: next });
                              onSynced();
                            }}
                          />
                          {g.name} <span className="muted small">· {g.size}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {st?.status === 'connected' && p.groups.length > 0 && <Scheduled p={p} st={st} settings={settings} onUpdate={update} onToast={onToast} />}
            {st && st.status !== 'removed' && <RecentNotices p={p} />}

            {!member && st?.host && <Friends p={p} st={st} onUpdate={update} onToast={onToast} />}

            {st?.status === 'removed' ? (
              <div className="row">
                <button className="primary" onClick={forget}>
                  OK
                </button>
              </div>
            ) : (
              <div className="row">
                {st?.status === 'connected' && (
                  <button
                    onClick={async () => {
                      if (!confirm('Unlink WhatsApp from the sync server? You can link again with a new QR code.')) return;
                      await update({ ...p, unlink: p.unlink + 1, linkRequestedAt: 0 });
                      onToast('Unlinking. This takes up to a minute.');
                    }}
                  >
                    Unlink WhatsApp
                  </button>
                )}
                <button
                  className="danger"
                  onClick={async () => {
                    const q = member
                      ? `Leave ${whose}? Your WhatsApp is unlinked from it. Messages already saved stay on this device.`
                      : 'Forget this sync server? Messages already saved stay on this device. You will need to set up a server again.';
                    if (confirm(q)) await forget();
                  }}
                >
                  {member ? 'Leave' : 'Forget sync server'}
                </button>
              </div>
            )}
            {st && !member && (
              <details className="small">
                <summary>Server setup again</summary>
                <SetupSteps p={p} onToast={onToast} />
              </details>
            )}
          </>
        )}
      </div>
    </>
  );
}
