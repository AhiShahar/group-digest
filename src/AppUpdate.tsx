// "Update ready" banner and Settings > App (version + Check for updates).
import { useState } from 'react';
import { isAndroidApp } from './lib/android';
import { APP_VERSION, applyUpdate, checkForUpdate, useUpdateAvailable } from './lib/freshness';

export function UpdateBanner() {
  const next = useUpdateAvailable();
  const [busy, setBusy] = useState(false);
  if (next === null) return null;
  return (
    <div className="banner subtle" role="status">
      <span>
        <b>A new version of Nutshell is ready{next && next !== APP_VERSION ? ` (${next})` : ''}.</b> Update to get the latest fixes.
      </span>
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          applyUpdate();
        }}
      >
        {busy ? 'Updating…' : 'Update now'}
      </button>
    </div>
  );
}

export function AppInfo() {
  const next = useUpdateAvailable();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <>
      <h2>App</h2>
      <div className="card">
        <p className="small">
          Nutshell version <b>{APP_VERSION}</b>
        </p>
        {isAndroidApp ? (
          <p className="small muted">Updates for the Android app come as a new APK file.</p>
        ) : next !== null ? (
          <div className="row">
            <span className="small" style={{ flex: '1 1 200px' }}>
              A new version{next && next !== APP_VERSION ? ` (${next})` : ''} is ready.
            </span>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                applyUpdate();
              }}
            >
              {busy ? 'Updating…' : 'Update now'}
            </button>
          </div>
        ) : (
          <div className="row">
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setNote(null);
                try {
                  if ((await checkForUpdate()) === null) setNote('You have the latest version.');
                } catch (e) {
                  setNote(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
            {note && <span className="small muted">{note}</span>}
          </div>
        )}
      </div>
    </>
  );
}
