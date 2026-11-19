// Export steps for the device in hand, and the "update this group" nudge.

import { bridge, isAndroidApp } from './lib/android';

export type Platform = 'android-app' | 'android' | 'ios' | 'desktop';

export function platform(): Platform {
  if (isAndroidApp) return 'android-app';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

const installed = () => matchMedia('(display-mode: standalone)').matches;

/** Opens WhatsApp itself (phones only). */
export function OpenWhatsApp() {
  const p = platform();
  if (p === 'desktop') return null;
  if (p === 'android-app') {
    return <button onClick={() => bridge!.openExternal('whatsapp://send')}>Open WhatsApp</button>;
  }
  return (
    <a className="btn" href="whatsapp://send">
      Open WhatsApp
    </a>
  );
}

export function ExportSteps({ group }: { group?: string }) {
  const p = platform();
  const name = group ? <b>{group}</b> : 'the group';
  const start = [
    <li key="open">In WhatsApp, open {name} and tap its name at the top.</li>,
    <li key="export">
      Scroll down, tap <b>Export chat</b>, then <b>Without media</b>.
    </li>,
  ];
  if (p === 'android-app' || (p === 'android' && installed())) {
    return (
      <ol className="steps">
        {start}
        <li>
          In the share sheet, tap <b>Group Digest</b>. It opens here with the new messages added.
        </li>
      </ol>
    );
  }
  if (p === 'android') {
    return (
      <ol className="steps">
        {start}
        <li>
          Tap <b>Group Digest</b> in the share sheet. It appears there once you install this app (Chrome menu ⋮ &gt; <b>Install app</b>).
          Without installing, save the file and tap <b>Import chat export</b> here.
        </li>
      </ol>
    );
  }
  if (p === 'ios') {
    return (
      <ol className="steps">
        {start}
        <li>
          Tap <b>Save to Files</b>, then <b>Save</b>.
        </li>
        <li>
          Back here, tap <b>Import</b> and pick the newest file under <b>Recents</b>.
        </li>
      </ol>
    );
  }
  return (
    <ol className="steps">
      <li>On your phone, in WhatsApp, open {name} and tap its name at the top.</li>
      {start[1]}
      <li>Send the file to yourself (email, Drive or WhatsApp to yourself), or export from your phone.</li>
      <li>Drag the .zip or .txt onto this page, or click Import.</li>
    </ol>
  );
}

const DAY = 864e5;

export function daysOld(lastTs: number | undefined, now = Date.now()): number | null {
  return lastTs ? Math.floor((now - lastTs) / DAY) : null;
}

/** Shown in a group when its newest message is a few days old. */
export function UpdateNudge({ group, lastTs, onPick }: { group: string; lastTs: number | undefined; onPick: () => void }) {
  const days = daysOld(lastTs);
  if (days === null || days < 2) return null;
  return (
    <div className="card nudge">
      <strong>
        Newest message here is {days} day{days === 1 ? '' : 's'} old
      </strong>
      <span className="muted small">Export the group again to add what was said since. Only new messages are added.</span>
      <ExportSteps group={group} />
      <div className="row">
        <OpenWhatsApp />
        <button onClick={onPick}>
          Import update
        </button>
      </div>
    </div>
  );
}
