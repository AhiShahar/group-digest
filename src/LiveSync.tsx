// Settings section: live WhatsApp sync through your own small server.
// Styling uses the shared classes from styles.css (card, row, small, muted...).
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import {
  createPairing,
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
          <li>Keep the defaults: an "Always Free-eligible" shape and Ubuntu or Oracle Linux.</li>
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

export default function LiveSync({ onToast, onSynced }: { onToast: (s: string) => void; onSynced: () => void }) {
  const [p, setP] = useState<SyncPairing | null | undefined>(undefined);
  const [st, setSt] = useState<BridgeState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadPairing().then((v) => setP(v ?? null));
  }, []);

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

  const serverSeen = st ? Date.now() - st.at < 12 * 60e3 : false;

  return (
    <>
      <h2 id="live-sync">Live sync from WhatsApp</h2>
      <div className="card">
        {!p ? (
          <>
            <p className="small">
              Link WhatsApp once with a QR code, like WhatsApp Web, and messages from the groups you choose flow in automatically, on iPhone and
              Android. It runs on a small server of your own (free on Oracle Cloud), and messages are end-to-end encrypted between that server
              and this app.
            </p>
            <p className="small muted">
              This uses an unofficial WhatsApp connection. WhatsApp could in rare cases restrict an account that uses one, so start with your own
              number.
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
        ) : (
          <>
            {err && <p className="small warn">{err}</p>}
            {!st && <SetupSteps p={p} onToast={onToast} />}
            {!st && <p className="small muted">Waiting for your server to check in…</p>}

            {st && (
              <p className={serverSeen ? 'small ok' : 'small warn'}>
                {serverSeen ? 'Sync server is online' : `Sync server last seen ${ago(st.at)}. Check that the VM is running.`}
                {st.status === 'connected' && st.me ? ` · linked to ${st.me.name ?? ''} +${st.me.number}` : ''}
              </p>
            )}
            {st?.error && <p className="small warn">{st.error}</p>}

            {st?.status === 'unlinked' && <p className="small">Getting a QR code from your server…</p>}
            {st?.status === 'starting' && <p className="small">Connecting to WhatsApp…</p>}

            {st?.status === 'qr' && st.qr && (
              <>
                <h3>2. Link WhatsApp</h3>
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

            <div className="row">
              {st?.status === 'connected' && (
                <button
                  onClick={async () => {
                    if (!confirm('Unlink WhatsApp from your sync server? You can link again with a new QR code.')) return;
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
                  if (!confirm('Forget this sync server? Messages already saved stay on this device. You will need to set up a server again.')) return;
                  try {
                    // Tell the server to unlink, and delete any undelivered messages.
                    await update({ ...p, groups: [], unlink: p.unlink + 1, linkRequestedAt: 0 });
                    await dropPending(p);
                  } catch {
                    /* relay may already be gone */
                  }
                  await savePairing(null);
                  setP(null);
                  setSt(null);
                }}
              >
                Forget sync server
              </button>
            </div>
            {st && (
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
