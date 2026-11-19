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
} from './lib/liveSync';

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
  const from = st.me?.name ?? '';
  return (
    <>
      <h3>Friends on your server</h3>
      <p className="small muted">
        Invite someone and they can link their own WhatsApp to your server with no setup. Each person's messages are encrypted for their phone
        only: you can't read theirs and they can't read yours. {members.length} of {host.max} places used.
      </p>
      <div className="row">
        <input placeholder="Friend's name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button
          className="primary"
          disabled={!name.trim() || members.length + pending.length >= host.max}
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
      {lastLink && (
        <>
          <pre className="sync-code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, userSelect: 'all' }}>
            {lastLink}
          </pre>
          <p className="small muted">Send this link to your friend. It works once. Anyone with the link can use it, so send it privately.</p>
          <div className="row">
            <Copy text={lastLink} label="Copy link" onToast={onToast} />
          </div>
        </>
      )}
      {(members.length > 0 || pending.length > 0) && (
        <ul className="groups">
          {members.map((m) => (
            <li key={m.room} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {m.name || 'Friend'}{' '}
                <span className="muted small">
                  · {m.status === 'connected' ? 'linked' : m.status === 'qr' ? 'scanning QR' : m.status}
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
                {i.name || 'Invite'} <span className="muted small">· invite not used yet</span>
              </span>
              <span className="row">
                <Copy text={inviteLink(p.host ? p : { ...p, host }, i, from)} label="Copy link" onToast={onToast} />
                <button onClick={() => onUpdate({ ...p, invites: (p.invites ?? []).filter((x) => x.code !== i.code) })}>Cancel</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function JoinCard({ inv, onJoined, onToast }: { inv: ParsedInvite; onJoined: (p: SyncPairing) => void; onToast: (s: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="small">
        <b>{inv.from || 'A friend'}</b> invited you to live sync. Link your WhatsApp once with a QR code and messages from the groups you choose
        flow into this app automatically. Your messages are encrypted for this phone only; {inv.from || 'your friend'} can't read them.
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

export default function LiveSync({ onToast, onSynced }: { onToast: (s: string) => void; onSynced: () => void }) {
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
                  and scan this code. If you are on the phone itself, open this page on another screen to scan it.
                </p>
                <Qr value={st.qr} />
              </>
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
