// Settings > Backup: automatic daily backup of this device's data to the
// live-sync relay (sealed), the recovery key, and restore on a new phone.
import { useEffect, useState } from 'react';
import { backupInfo, backupNow, recoveryKey, restoreFromKey, type BackupInfo } from './lib/backup';
import { loadPairing, savePairing, type SyncPairing } from './lib/liveSync';

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const kb = (n: number) => (n > 2 ** 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function Backup({ onToast, onRestored }: { onToast: (s: string) => void; onRestored: () => void }) {
  const [p, setP] = useState<SyncPairing | null | undefined>(undefined);
  const [info, setInfo] = useState<BackupInfo | undefined>();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');

  useEffect(() => {
    loadPairing().then((v) => setP(v ?? null));
    backupInfo().then(setInfo);
  }, []);
  if (p === undefined) return null;

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    try {
      await what();
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <>
      <h2 id="backup">Backup</h2>
      <div className="card">
        {p ? (
          <>
            <p className="small">
              {p.backup === false ? 'Automatic backup is off.' : 'Your groups, messages, digests and settings are backed up about once a day, encrypted with your live-sync key, next to your sync server.'}
              {info ? ` Last backup ${when(info.at)} (${kb(info.size)}).` : ''}
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const i = await backupNow();
                    setInfo(i);
                    onToast(`Backed up (${kb(i.size)}).`);
                  })
                }
              >
                {busy ? 'Working…' : 'Back up now'}
              </button>
              <button onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide recovery key' : 'Show recovery key'}</button>
              <button
                onClick={async () => {
                  const next = { ...p, backup: p.backup === false };
                  await savePairing(next);
                  setP(next);
                }}
              >
                {p.backup === false ? 'Turn on automatic backup' : 'Turn off automatic backup'}
              </button>
            </div>
            {showKey && (
              <>
                <pre className="sync-code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, userSelect: 'all' }}>
                  {recoveryKey(p)}
                </pre>
                <div className="row">
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(recoveryKey(p));
                        onToast('Recovery key copied. Keep it somewhere private, like your password manager.');
                      } catch {
                        onToast('Could not copy. Select the text and copy it by hand.');
                      }
                    }}
                  >
                    Copy recovery key
                  </button>
                </div>
                <p className="small muted">
                  Save this somewhere private (a password manager, or a note only you can see). With it, a new phone gets everything back. Anyone
                  with it can read your synced messages, so never share it.
                </p>
              </>
            )}
          </>
        ) : (
          <p className="small muted">Backups are kept next to your live-sync server, so they start once live sync is set up.</p>
        )}
        <details className="small">
          <summary>Restore from a backup</summary>
          <p className="small muted">
            Paste your recovery key. Groups and digests are added to what is on this phone; live sync moves here too, so use it on one phone at a
            time.
          </p>
          <input placeholder="gd1-…" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
          <div className="row">
            <button
              className="primary"
              disabled={busy || !key.trim()}
              onClick={() =>
                run(async () => {
                  const r = await restoreFromKey(key);
                  setKey('');
                  setP((await loadPairing()) ?? null);
                  setInfo(await backupInfo());
                  onRestored();
                  onToast(`Restored ${r.chats} group${r.chats === 1 ? '' : 's'} and ${r.digests} digest${r.digests === 1 ? '' : 's'} from ${when(r.at)}.`);
                })
              }
            >
              Restore
            </button>
          </div>
        </details>
      </div>
    </>
  );
}
