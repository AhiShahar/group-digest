import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildIcs, downloadFile, googleCalendarUrl, outlookCalendarUrl, safeFilename } from './lib/calendar';
import type { Digest, DigestEvent } from './lib/digest';
import LiveSync from './LiveSync';
import { fetchNotices, lastDigests, loadPairing, pullMessages, pushConfig, savePairing, type SyncNotice } from './lib/liveSync';
import { openProblem, refreshAndroidWatch } from './lib/schedule';
import { addEventNative, bridge, canCapture, captureStatus, isAndroidApp, peekCaptured, takeNativeShare, type CaptureStatus } from './lib/android';
import { finishOpenRouterSignIn, startOpenRouterSignIn } from './lib/openrouter';
import { parseChatText, readExportFile } from './lib/parser';
import { PROVIDERS, providerInfo, type ProviderId } from './lib/providerInfo';
import { rankModels } from './lib/models';
import { findMatchingChat } from './lib/match';
import { ExportSteps, OpenWhatsApp, UpdateNudge } from './ExportHelp';
import { DEFAULT_REMINDERS } from './lib/reminders';
import { disablePush } from './lib/webpush';
import { RemindAllButton, ReminderButton, ReminderSettings, RemindersContext, useReminderPrefs } from './Reminders';

const providers = () => import('./lib/providers');
import {
  DEFAULT_SETTINGS,
  applyRetention,
  deleteChat,
  getChat,
  listChats,
  listDigests,
  loadSettings,
  mergeMessages,
  newId,
  putChat,
  putDigest,
  saveSettings,
  storeCaptured,
  takeSharedFiles,
  type AppSettings,
  type StoredChat,
  type StoredDigest,
} from './lib/store';

type View = { name: 'chats' } | { name: 'chat'; id: string } | { name: 'settings' };

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// iPhone and iPad have no install prompt: show steps in Safari until the app is on the Home Screen.
function shouldShowIosInstall(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('ios-install-dismissed') === '1';
  } catch {
    /* private mode */
  }
  return ios && !standalone && !dismissed;
}

function IosInstallCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="card onboard ios">
      <h2>First, add Group Digest to your Home Screen</h2>
      <ol className="steps">
        <li>
          Tap the <b>Share</b> button <span className="share-icon" aria-hidden="true">⬆︎</span> in Safari's toolbar.
        </li>
        <li>
          Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
        </li>
        <li>
          Open <b>Digest</b> from your Home Screen and set it up there.
        </li>
      </ol>
      <p className="muted small">The Home Screen app keeps its own chats and sign-in, so set it up there rather than in Safari.</p>
      <button
        className="link"
        onClick={() => {
          try {
            localStorage.setItem('ios-install-dismissed', '1');
          } catch {
            /* ignore */
          }
          onDismiss();
        }}
      >
        Continue in Safari instead
      </button>
    </div>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

export default function App() {
  // An invite link (#join=...) opens straight on the live sync settings.
  const [view, setView] = useState<View>(() => (location.hash.includes('join=') ? { name: 'settings' } : { name: 'chats' }));
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosInstall, setIosInstall] = useState(shouldShowIosInstall);

  const refreshChats = useCallback(async () => setChats(await listChats()), []);
  const [importTick, setImportTick] = useState(0);

  const importFiles = useCallback(
    async (files: File[], targetId?: string) => {
      let lastId: string | null = null;
      for (const file of files) {
        try {
          const { text, name } = await readExportFile(file);
          const parsed = parseChatText(text, name);
          if (!parsed.messages.length) throw new Error(`No messages found in ${file.name}. Is it a WhatsApp export?`);
          const all = await listChats();
          // "Import update" inside a group adds to that group; otherwise find the group by name or shared messages.
          const existing = (targetId && all.find((c) => c.id === targetId)) || findMatchingChat(all, parsed.name, parsed.messages);
          if (existing) {
            const merged = mergeMessages(existing.messages, parsed.messages);
            await putChat({ ...existing, messages: merged, importedAt: Date.now() });
            lastId = existing.id;
            const added = merged.length - existing.messages.length;
            setToast(`Updated "${existing.name}": ${added ? `${added} new message${added === 1 ? '' : 's'}` : 'no new messages since last time'}.`);
          } else {
            const id = newId();
            await putChat({ id, name: parsed.name, importedAt: Date.now(), messages: parsed.messages, focus: '', lastDigestEnd: null });
            lastId = id;
            setToast(`Imported "${parsed.name}": ${parsed.messages.length} messages.`);
          }
        } catch (e) {
          setToast(e instanceof Error ? e.message : String(e));
        }
      }
      await refreshChats();
      setImportTick((t) => t + 1);
      if (lastId) setView({ name: 'chat', id: lastId });
    },
    [refreshChats],
  );

  useEffect(() => {
    (async () => {
      let s = await loadSettings();
      try {
        const key = await finishOpenRouterSignIn();
        if (key) {
          s = { ...s, provider: 'openrouter', apiKey: key, model: s.provider === 'openrouter' && s.model ? s.model : 'openrouter/free' };
          await saveSettings(s);
          setToast('Signed in with OpenRouter.');
          setView({ name: 'settings' });
        }
      } catch (e) {
        setToast(e instanceof Error ? e.message : String(e));
      }
      setSettings(s);
      await applyRetention(s.retentionDays);
      await refreshChats();
      setLoaded(true);
      if (new URLSearchParams(location.search).has('shared')) {
        history.replaceState(null, '', location.pathname);
        const files = await takeSharedFiles();
        if (files.length) await importFiles(files);
      }
      const native = takeNativeShare();
      if (native) await importFiles([native]);
    })();
    // The Android app fires this when WhatsApp shares a chat while it is open.
    const onNativeShare = () => {
      const f = takeNativeShare();
      if (f) importFiles([f]);
    };
    window.addEventListener('groupdigest-share', onNativeShare);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('groupdigest-share', onNativeShare);
    };
  }, [importFiles, refreshChats]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Android live capture: pull messages saved from WhatsApp notifications.
  useEffect(() => {
    if (!canCapture || !loaded) return;
    const sync = async () => {
      const items = peekCaptured();
      if (!items.length) return;
      const added = await storeCaptured(items);
      bridge?.ackCaptured?.();
      await refreshChats();
      if (added) setToast(`Saved ${added} new message${added === 1 ? '' : 's'} from WhatsApp.`);
    };
    sync();
    const timer = setInterval(sync, 60_000);
    window.addEventListener('groupdigest-resume', sync);
    return () => {
      clearInterval(timer);
      window.removeEventListener('groupdigest-resume', sync);
    };
  }, [loaded, refreshChats]);

  // Live sync: pull messages your sync server left in the relay.
  useEffect(() => {
    if (!loaded) return;
    let running = false;
    const sync = async () => {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const p = await loadPairing();
        if (p?.groups.length) {
          const added = await pullMessages(p);
          if (added || lastDigests) {
            await refreshChats();
            setToast(
              lastDigests
                ? `${lastDigests} new scheduled digest${lastDigests === 1 ? '' : 's'} arrived. Open a group to read it.`
                : `Synced ${added} new message${added === 1 ? '' : 's'} from WhatsApp.`,
            );
          }
        }
      } catch {
        /* offline or relay down: try again next time */
      }
      running = false;
    };
    sync();
    const timer = setInterval(sync, 60_000);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('groupdigest-resume', sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('groupdigest-resume', sync);
    };
  }, [loaded, refreshChats]);

  // Live sync health: show a banner while the server is offline or WhatsApp unlinked it.
  const [problem, setProblem] = useState<SyncNotice | null>(null);
  useEffect(() => {
    if (!loaded) return;
    let first = true;
    const check = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const p = await loadPairing();
        if (first) refreshAndroidWatch(p);
        first = false;
        setProblem(p ? openProblem(await fetchNotices(p)) : null);
      } catch {
        /* offline */
      }
    };
    check();
    const timer = setInterval(check, 5 * 60_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [loaded]);

  const updateSettings = async (s: AppSettings) => {
    const before = settings;
    setSettings(s);
    await saveSettings(s);
    // Scheduled digests run on the sync server with these AI settings: send it the new ones.
    if (before.provider !== s.provider || before.apiKey !== s.apiKey || before.model !== s.model || before.baseUrl !== s.baseUrl || before.language !== s.language) {
      const p = await loadPairing();
      if (p?.digest?.on) {
        try {
          const { pickModels } = await import('./lib/schedule');
          const next = { ...p, digest: { ...p.digest, models: await pickModels(s) } };
          await savePairing(next);
          await pushConfig(next);
        } catch {
          /* the next change or app start sends it */
        }
      }
    }
  };

  const needsSetup = loaded && providerInfo(settings.provider).needsKey && !settings.apiKey;

  return (
    <RemindersContext.Provider value={settings.reminders ?? DEFAULT_REMINDERS}>
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => setView({ name: 'chats' })}>
          <img src="./favicon.svg" alt="" width={28} height={28} />
          <span>Group Digest</span>
        </button>
        <nav>
          <button className={view.name !== 'settings' ? 'tab on' : 'tab'} onClick={() => setView({ name: 'chats' })}>
            Chats
          </button>
          <button className={view.name === 'settings' ? 'tab on' : 'tab'} onClick={() => setView({ name: 'settings' })}>
            AI and settings
          </button>
        </nav>
      </header>

      <main>
        {needsSetup && !iosInstall && view.name !== 'settings' && (
          <Onboarding
            onGemini={async () => {
              await updateSettings({ ...settings, provider: 'gemini', apiKey: '', model: providerInfo('gemini').defaultModel });
              setView({ name: 'settings' });
            }}
            onOther={() => setView({ name: 'settings' })}
          />
        )}
        {problem && view.name === 'chats' && (
          <div className="banner alert" role="alert">
            <span>
              <b>{problem.title}.</b> {problem.body}
            </span>
            <button
              onClick={() => {
                setView({ name: 'settings' });
                setTimeout(() => document.getElementById('live-sync')?.scrollIntoView({ behavior: 'smooth' }), 100);
              }}
            >
              Live sync
            </button>
          </div>
        )}
        {iosInstall && <IosInstallCard onDismiss={() => setIosInstall(false)} />}
        {installEvt && (
          <div className="banner subtle">
            <span>Install Group Digest on this device for quick access and share-to-app.</span>
            <button
              onClick={async () => {
                await installEvt.prompt();
                setInstallEvt(null);
              }}
            >
              Install
            </button>
          </div>
        )}

        {view.name === 'chats' && canCapture && !needsSetup && <CaptureHint
            onOpen={() => {
              setView({ name: 'settings' });
              setTimeout(() => document.getElementById('capture')?.scrollIntoView({ behavior: 'smooth' }), 50);
            }}
          />}
        {view.name === 'chats' && <ChatList chats={chats} onImport={importFiles} onOpen={(id) => setView({ name: 'chat', id })} />}
        {view.name === 'chat' && (
          <ChatView
            key={`${view.id}-${importTick}`}
            id={view.id}
            onImport={importFiles}
            settings={settings}
            onBack={() => setView({ name: 'chats' })}
            onChanged={refreshChats}
            onToast={setToast}
            onNeedSetup={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'settings' && <Settings settings={settings} chats={chats} onChange={updateSettings} onToast={setToast} onWiped={refreshChats} />}
      </main>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
    </RemindersContext.Provider>
  );
}

// ---------------- First run ----------------

function Onboarding({ onGemini, onOther }: { onGemini: () => void; onOther: () => void }) {
  return (
    <div className="card onboard">
      <h2>Step 1: connect a free AI</h2>
      <p className="muted small">Your chats go straight from this device to the AI you pick. Nothing is stored on our side.</p>
      <button className="primary big" onClick={() => startOpenRouterSignIn()}>
        Sign in with OpenRouter (free)
      </button>
      <p className="muted small">Sign in or make a free account in one step. No card, no key to copy. Free models allow about 50 requests a day, and one summary is usually one request.</p>
      <div className="row">
        <button onClick={onGemini}>Use a free Gemini key</button>
        <button className="link" onClick={onOther}>
          I have a Claude or OpenAI key
        </button>
      </div>
    </div>
  );
}

function CaptureHint({ onOpen }: { onOpen: () => void }) {
  const [st, setSt] = useState<CaptureStatus | null>(captureStatus());
  useEffect(() => {
    const f = () => setSt(captureStatus());
    window.addEventListener('groupdigest-resume', f);
    return () => window.removeEventListener('groupdigest-resume', f);
  }, []);
  if (!st || (st.enabled && st.selected.length)) return null;
  return (
    <div className="banner subtle">
      <span>{st.enabled ? 'Pick which groups to save automatically.' : 'Save new WhatsApp group messages automatically, without exporting.'}</span>
      <button onClick={onOpen}>{st.enabled ? 'Pick groups' : 'Set up'}</button>
    </div>
  );
}

// ---------------- Chat list ----------------

function ChatList({ chats, onImport, onOpen }: { chats: StoredChat[]; onImport: (f: File[]) => void; onOpen: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <section>
      <div
        className={drag ? 'drop on' : 'drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onImport([...e.dataTransfer.files]);
        }}
      >
        <h2>Add a group</h2>
        <p className="muted">
          Import a WhatsApp chat export (.txt or .zip, several at once is fine). Exporting the same group again adds only the new messages. It stays on
          this device.
        </p>
        <button className="primary" onClick={() => input.current?.click()}>
          Import chat export
        </button>
        <input
          ref={input}
          type="file"
          accept=".txt,.zip,text/plain,application/zip"
          multiple
          hidden
          onChange={(e) => {
            onImport([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        {chats.length === 0 ? (
          <>
            <h3>How to export a group</h3>
            <ExportSteps />
            <div className="row">
              <OpenWhatsApp />
            </div>
          </>
        ) : (
          <details className="howto">
            <summary>How to export a group from WhatsApp</summary>
            <ExportSteps />
          </details>
        )}
      </div>

      {chats.length > 0 && <h2 className="list-title">Your groups</h2>}
      <ul className="chats">
        {chats.map((c) => {
          const first = c.messages[0]?.ts;
          const last = c.messages[c.messages.length - 1]?.ts;
          return (
            <li key={c.id}>
              <button onClick={() => onOpen(c.id)}>
                <span className="avatar">{c.name.slice(0, 1).toUpperCase()}</span>
                <span className="grow">
                  <span className="name">{c.name}</span>
                  <span className="muted small">
                    {c.messages.length ? `${c.messages.length} messages · ${fmtDay(first!)} to ${fmtDay(last!)}` : 'Messages cleared, digests kept'}
                  </span>
                </span>
                <span className="chev">›</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------- Chat view ----------------

type Range = 'since' | '1' | '7' | '30' | 'all';

function ChatView(props: {
  id: string;
  settings: AppSettings;
  onBack: () => void;
  onChanged: () => void;
  onToast: (s: string) => void;
  onNeedSetup: () => void;
  onImport: (files: File[], targetId?: string) => void;
}) {
  const { id, settings, onBack, onChanged, onToast, onNeedSetup, onImport } = props;
  const pick = useRef<HTMLInputElement>(null);
  const [chat, setChat] = useState<StoredChat | null>(null);
  const [digests, setDigests] = useState<StoredDigest[]>([]);
  const [range, setRange] = useState<Range>('7');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const c = await getChat(id);
      setChat(c ?? null);
      setDigests(await listDigests(id));
      if (c?.lastDigestEnd) setRange('since');
    })();
  }, [id]);

  const selected = useMemo(() => {
    if (!chat) return [];
    const msgs = chat.messages;
    if (!msgs.length) return [];
    const lastTs = msgs[msgs.length - 1].ts;
    if (range === 'all') return msgs;
    if (range === 'since') return msgs.filter((m) => m.ts > (chat.lastDigestEnd ?? 0));
    // Count back from the newest message, since exports can be a few days old.
    const from = lastTs - Number(range) * 864e5;
    return msgs.filter((m) => m.ts >= from);
  }, [chat, range]);

  if (!chat) return <p className="muted">Loading…</p>;

  const run = async () => {
    if (providerInfo(settings.provider).needsKey && !settings.apiKey) return onNeedSetup();
    setError(null);
    setBusy('Summarizing…');
    try {
      const { summarize } = await providers();
      let usedModel = settings.model;
      const digest = await summarize(
        settings,
        {
          chatName: chat.name,
          messages: selected,
          focus: chat.focus,
          language: settings.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        setBusy,
        (m) => (usedModel = m),
      );
      const rec: StoredDigest = {
        id: newId(),
        chatId: chat.id,
        createdAt: Date.now(),
        from: selected[0].ts,
        to: selected[selected.length - 1].ts,
        messageCount: selected.length,
        model: `${settings.provider}/${usedModel}`,
        digest,
      };
      await putDigest(rec);
      const updated = { ...chat, lastDigestEnd: Math.max(chat.lastDigestEnd ?? 0, rec.to) };
      await putChat(updated);
      setChat(updated);
      setDigests([rec, ...digests]);
      notifyDone(settings, chat.name, digest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${chat.name}" and its digests from this device?`)) return;
    await deleteChat(chat.id);
    onChanged();
    onBack();
  };

  return (
    <section>
      <button className="link" onClick={onBack}>
        ‹ All groups
      </button>
      <h1>{chat.name}</h1>
      <p className="muted small">
        {chat.messages.length} messages stored
        {chat.lastDigestEnd ? ` · last digest covered up to ${fmtDate(chat.lastDigestEnd)}` : ''}
      </p>

      {!captureStatus()?.selected.includes(chat.name) && (
        <UpdateNudge group={chat.name} lastTs={chat.messages[chat.messages.length - 1]?.ts} onPick={() => pick.current?.click()} />
      )}
      <input
        ref={pick}
        type="file"
        accept=".txt,.zip,text/plain,application/zip"
        hidden
        onChange={(e) => {
          onImport([...(e.target.files ?? [])], chat.id);
          e.target.value = '';
        }}
      />

      <div className="card">
        <label>
          What to summarize
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {chat.lastDigestEnd && <option value="since">New since last digest</option>}
            <option value="1">Last day</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="all">Everything</option>
          </select>
        </label>
        <label>
          Focus (optional)
          <input
            placeholder="e.g. school logistics, payments, who is bringing what"
            value={chat.focus}
            onChange={(e) => setChat({ ...chat, focus: e.target.value })}
            onBlur={() => putChat(chat)}
          />
        </label>
        <div className="row">
          <button className="primary" disabled={!!busy || !selected.length} onClick={run}>
            {busy ?? `Summarize ${selected.length} messages`}
          </button>
          <span className="muted small">
            {settings.model ? `Using ${settings.model}` : 'Using the newest model (automatic)'}
          </span>
        </div>
        {!selected.length && chat.messages.length > 0 && <p className="muted small">No new messages in this range. Import a newer export.</p>}
        {error && <ErrorBox message={error} />}
      </div>

      {digests.map((d, i) => (
        <DigestCard key={d.id} rec={d} chatName={chat.name} open={i === 0} onToast={onToast} />
      ))}

      <button className="danger link" onClick={remove}>
        Delete this group from the device
      </button>
    </section>
  );
}

async function notifyDone(settings: AppSettings, chatName: string, d: Digest) {
  if (!settings.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  const body = d.events.length ? `${d.headline}\n${d.events.length} possible event(s) to add.` : d.headline;
  reg?.showNotification(`${chatName}: digest ready`, { body, icon: './pwa-192x192.png', tag: chatName });
}

function digestAsText(chatName: string, d: Digest): string {
  const sec = (title: string, items: string[]) => (items.length ? `\n*${title}*\n${items.map((x) => `• ${x}`).join('\n')}\n` : '');
  return (
    `*${chatName}*: ${d.headline}\n` +
    sec('Key points', d.key_points) +
    sec('Decisions', d.decisions) +
    sec(
      'To do',
      d.action_items.map((a) => `${a.task}${a.owner ? ` (${a.owner})` : ''}${a.due ? `, by ${a.due}` : ''}`),
    ) +
    sec('Open questions', d.open_questions) +
    sec(
      'Dates',
      d.events.map((e) => `${e.title}: ${e.date}${e.start_time ? ` ${e.start_time}` : ''}${e.location ? `, ${e.location}` : ''}`),
    )
  ).trim();
}

function friendlyError(msg: string): { title: string; hint: string } {
  if (/rejected the key|401|403|API key not valid|invalid.*key/i.test(msg))
    return { title: "The AI didn't accept your key", hint: 'Check the key in AI and settings, or sign in again.' };
  if (/\b429\b|free daily limit|rate limit|quota/i.test(msg))
    return { title: 'The free limit is used up for now', hint: 'Try again in a minute, or tomorrow.' };
  if (/\b402\b|no credit/i.test(msg)) return { title: 'No credit left on the AI account', hint: 'Add credit with the provider, or switch to a free option.' };
  if (/no longer available|not found|deprecated|retired|404|No models found/i.test(msg))
    return { title: "That AI model isn't available", hint: 'Open AI and settings and tap Check connection, or try another AI there.' };
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg))
    return { title: "Couldn't reach the AI", hint: 'Check your internet connection and try again.' };
  if (/No messages/i.test(msg)) return { title: 'Nothing to summarize', hint: 'Pick a longer time range or import a newer export.' };
  return { title: 'The summary didn\'t work', hint: 'Try again. If it keeps failing, try another AI in AI and settings.' };
}

function ErrorBox({ message }: { message: string }) {
  const f = friendlyError(message);
  return (
    <div className="error-box" role="alert">
      <strong>{f.title}</strong>
      <span>{f.hint}</span>
      <details>
        <summary>Details</summary>
        <p>{message}</p>
      </details>
    </div>
  );
}

function DigestCard({ rec, chatName, open, onToast }: { rec: StoredDigest; chatName: string; open: boolean; onToast: (s: string) => void }) {
  const d = rec.digest;
  const prefs = useReminderPrefs();
  const share = async () => {
    const text = digestAsText(chatName, d);
    try {
      if (bridge) bridge.shareText(text);
      else if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        onToast('Summary copied.');
      }
    } catch {
      /* user cancelled */
    }
  };
  const allIcs = async () => {
    const name = `${safeFilename(chatName)}-events.ics`;
    const ics = await buildIcs(d.events, chatName, prefs);
    if (bridge) bridge.shareFile(name, 'text/calendar', ics);
    else downloadFile(name, ics, 'text/calendar');
  };
  return (
    <details className="card digest" open={open}>
      <summary>
        <span className="grow">
          <span className="muted small">
            {fmtDay(rec.from)} to {fmtDay(rec.to)} · {rec.messageCount} messages
          </span>
          <span className="headline">{d.headline}</span>
        </span>
      </summary>
      <List title="Key points" items={d.key_points} />
      <List title="Decisions" items={d.decisions} />
      {d.action_items.length > 0 && (
        <>
          <h3>To do</h3>
          <ul>
            {d.action_items.map((a, i) => (
              <li key={i}>
                {a.task}
                {a.owner && <span className="pill">{a.owner}</span>}
                {a.due && <span className="pill">by {a.due}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <List title="Open questions" items={d.open_questions} />
      {d.events.length > 0 && (
        <>
          <h3>Possible events ({d.events.length})</h3>
          <ul className="events">
            {d.events.map((e, i) => (
              <EventRow key={i} e={e} chatName={chatName} onToast={onToast} />
            ))}
          </ul>
          <div className="row">
            {d.events.length > 1 && <button onClick={allIcs}>Add all {d.events.length} to calendar (.ics)</button>}
            <RemindAllButton events={d.events} chatName={chatName} onToast={onToast} />
          </div>
        </>
      )}
      <div className="row foot">
        <button onClick={share}>Share summary</button>
        <span className="muted small">
          {rec.model} · {fmtDate(rec.createdAt)}
        </span>
      </div>
    </details>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </>
  );
}

function EventRow({ e, chatName, onToast }: { e: DigestEvent; chatName: string; onToast: (s: string) => void }) {
  const prefs = useReminderPrefs();
  const when = new Date(`${e.date}T${e.start_time ?? '00:00'}:00`).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(e.start_time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  const ics = async () => downloadFile(`${safeFilename(e.title)}.ics`, await buildIcs([e], chatName, prefs), 'text/calendar');
  if (isAndroidApp) {
    return (
      <li className={`event ${e.confidence}`}>
        <EventInfo e={e} when={when} />
        <div className="event-actions">
          <button onClick={() => addEventNative(e, chatName)}>Add to calendar</button>
          <ReminderButton e={e} chatName={chatName} onToast={onToast} />
        </div>
      </li>
    );
  }
  return (
    <li className={`event ${e.confidence}`}>
      <EventInfo e={e} when={when} />
      <div className="event-actions">
        <a className="btn" href={googleCalendarUrl(e, chatName)} target="_blank" rel="noreferrer">
          Google
        </a>
        <button onClick={ics} title="Apple Calendar, Outlook and others">
          Apple / .ics
        </button>
        <a className="btn" href={outlookCalendarUrl(e, chatName)} target="_blank" rel="noreferrer">
          Outlook
        </a>
        <ReminderButton e={e} chatName={chatName} onToast={onToast} />
      </div>
    </li>
  );
}

function EventInfo({ e, when }: { e: DigestEvent; when: string }) {
  return (
      <div className="event-main">
        <span className="name">{e.title}</span>
        <span className="small">
          {when}
          {e.end_time ? ` to ${e.end_time}` : ''}
          {e.location ? ` · ${e.location}` : ''}
        </span>
        {e.notes && <span className="small muted">{e.notes}</span>}
        <span className="small muted quote">“{e.source_quote}”</span>
        {e.confidence !== 'high' && <span className="small warn">{e.confidence} confidence, check the date</span>}
      </div>
  );
}

// ---------------- Settings ----------------

function LiveCapture({ chats }: { chats: StoredChat[] }) {
  const [st, setSt] = useState<CaptureStatus | null>(captureStatus());
  useEffect(() => {
    const f = () => setSt(captureStatus());
    window.addEventListener('groupdigest-resume', f);
    const t = setInterval(f, 5000);
    return () => {
      window.removeEventListener('groupdigest-resume', f);
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  const groups = [...new Set([...st.seen, ...st.selected, ...chats.map((c) => c.name)])].sort((a, b) => a.localeCompare(b));
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...new Set([...st.selected, name])] : st.selected.filter((g) => g !== name);
    bridge?.setCaptureGroups?.(JSON.stringify(next));
    setSt({ ...st, selected: next });
  };
  const restricted = (bridge?.androidVersion?.() ?? 0) >= 33;
  return (
    <>
      <h2 id="capture">Save messages automatically</h2>
      <div className="card">
        <p className="small">
          With your permission, Group Digest reads WhatsApp notifications and saves messages from the groups you tick below. They stay on this
          phone and show up in summaries next to your exports. Private chats and unticked groups are never saved.
        </p>
        <p className="small muted">
          It only sees messages that arrive as notifications from now on: not older history, not muted groups, and not messages you read while
          the chat is open. WhatsApp's notification previews must be on.
        </p>
        {st.enabled ? (
          <p className="small ok">Notification access is on.</p>
        ) : (
          <>
            <div className="row">
              <button className="primary" onClick={() => bridge?.openCaptureSettings?.()}>
                Allow notification access
              </button>
            </div>
            <p className="small muted">Find Group Digest in the list and turn it on, then come back.</p>
            {restricted && (
              <p className="small muted">
                If Android says the setting is restricted: open{' '}
                <button className="link inline" onClick={() => bridge?.openAppInfo?.()}>
                  App info
                </button>
                , tap ⋮ at the top right, choose Allow restricted settings, then try again.
              </p>
            )}
          </>
        )}
        <h3>Groups to save</h3>
        {groups.length === 0 ? (
          <p className="small muted">Groups appear here after their first WhatsApp notification arrives. You can also import an export first.</p>
        ) : (
          <ul className="groups">
            {groups.map((g) => (
              <li key={g}>
                <label className="check">
                  <input type="checkbox" checked={st.selected.includes(g)} onChange={(e) => toggle(g, e.target.checked)} />
                  {g}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Settings({
  settings,
  chats,
  onChange,
  onToast,
  onWiped,
}: {
  settings: AppSettings;
  chats: StoredChat[];
  onChange: (s: AppSettings) => void;
  onToast: (s: string) => void;
  onWiped: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const info = providerInfo(settings.provider);

  const setProvider = (p: ProviderId) => {
    setModels([]);
    onChange({ ...settings, provider: p, apiKey: '', model: providerInfo(p).defaultModel });
  };

  const check = async () => {
    setChecking(true);
    try {
      const { listModels } = await providers();
      const list = await listModels(settings);
      setModels(list);
      const auto = rankModels(settings.provider, list)[0];
      onToast(settings.model ? `Connected. ${list.length} models available.` : `Connected. Automatic choice: ${auto ?? 'none found'}.`);
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const askNotify = async () => {
    if (!('Notification' in window)) return onToast('This browser does not support notifications. On iPhone, install the app first.');
    const p = await Notification.requestPermission();
    onChange({ ...settings, notify: p === 'granted' });
  };

  const wipe = async () => {
    if (!window.confirm('Delete all groups, digests and your AI key from this device?')) return;
    indexedDB.deleteDatabase('group-digest');
    disablePush().catch(() => {});
    onToast('All data deleted.');
    setTimeout(() => location.reload(), 600);
    onWiped();
  };

  return (
    <section>
      <h1>Your AI</h1>
      <p className="muted">
        Pick the AI that writes your summaries. Your key is stored only on this device and is sent only to that provider.
      </p>
      <div className="card">
        <fieldset className="providers">
          {PROVIDERS.map((p) => (
            <label key={p.id} className={settings.provider === p.id ? 'prov on' : 'prov'}>
              <input type="radio" name="prov" checked={settings.provider === p.id} onChange={() => setProvider(p.id)} />
              {p.label}
            </label>
          ))}
        </fieldset>
        <p className="muted small">
          {info.keyHelp}{' '}
          {info.keyUrl && settings.provider !== 'openrouter' && (
            <a href={info.keyUrl} target="_blank" rel="noreferrer">
              {settings.provider === 'gemini' ? 'Get a free key' : 'Get a key'}
            </a>
          )}
        </p>

        {settings.provider === 'openrouter' && (
          <div className="row">
            <button className="primary" onClick={() => startOpenRouterSignIn()}>
              {settings.apiKey ? 'Signed in · sign in again' : 'Sign in with OpenRouter'}
            </button>
            {settings.apiKey && (
              <button className="link" onClick={() => onChange({ ...settings, apiKey: '' })}>
                Sign out
              </button>
            )}
          </div>
        )}

        {settings.provider === 'compatible' && (
          <label>
            Server URL
            <input value={settings.baseUrl} onChange={(e) => onChange({ ...settings, baseUrl: e.target.value })} placeholder="http://localhost:11434/v1" />
          </label>
        )}

        {settings.provider !== 'openrouter' && (
          <label>
            API key{settings.provider === 'compatible' ? ' (if your server needs one)' : ''}
            <span className="row tight">
              <input
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                value={settings.apiKey}
                onChange={(e) => onChange({ ...settings, apiKey: e.target.value.trim() })}
                placeholder={settings.provider === 'anthropic' ? 'sk-ant-…' : settings.provider === 'gemini' ? 'AIza…' : 'sk-…'}
              />
              <button onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button>
            </span>
          </label>
        )}

        <label>
          Model
          <input
            list="models"
            placeholder="Automatic (newest fast model)"
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value.trim() })}
          />
          <datalist id="models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <p className="muted small">
          Leave empty and the app picks the newest fast model, and switches by itself if the provider retires one.
          {settings.model && (
            <>
              {' '}
              <button className="link inline" onClick={() => onChange({ ...settings, model: '' })}>
                Use automatic
              </button>
            </>
          )}
        </p>
        <div className="row">
          <button onClick={check} disabled={checking || (info.needsKey && !settings.apiKey)}>
            {checking ? 'Checking…' : 'Check connection and load models'}
          </button>
        </div>
      </div>

      <h2>Summaries</h2>
      <div className="card">
        <label>
          Summary language
          <input value={settings.language} onChange={(e) => onChange({ ...settings, language: e.target.value })} placeholder="English" />
        </label>
        <label>
          Keep raw messages for
          <select value={settings.retentionDays} onChange={(e) => onChange({ ...settings, retentionDays: Number(e.target.value) })}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={0}>Forever</option>
          </select>
        </label>
        {!isAndroidApp && <div className="row">
          <button onClick={askNotify}>{settings.notify && 'Notification' in window && Notification.permission === 'granted' ? 'Notifications on' : 'Turn on notifications'}</button>
          <span className="muted small">Notifies you when a long digest finishes in the background.</span>
        </div>}
      </div>

      <ReminderSettings
        prefs={settings.reminders ?? DEFAULT_REMINDERS}
        onChange={(r) => onChange({ ...settings, reminders: { ...r, repeat: r.repeat < r.lead ? r.repeat : 0 } })}
        onToast={onToast}
      />

      <LiveSync settings={settings} onToast={onToast} onSynced={onWiped} />

      {canCapture && <LiveCapture chats={chats} />}
      {isAndroidApp && !canCapture && (
        <p className="muted small">
          This is the lite version. To save WhatsApp messages automatically instead of exporting, install the full version of Group Digest.
        </p>
      )}

      <h2>Privacy</h2>
      <div className="card">
        <p className="small">
          Chats, digests and keys live only on this device. The only network calls are to the AI provider you chose, with the
          messages you asked it to summarize (phone numbers are masked first). If you turn on live sync, your own sync server passes messages
          from the groups you chose through this app's relay, end-to-end encrypted, and they are deleted from the relay once this device has them.
          With scheduled digests on, your sync server keeps those groups' messages (encrypted, up to nine days) and sends them to your AI
          at the time you picked, using the AI key from this device.
          If you turn on reminders on the website, only event titles and times go to this app's reminder service. Other group members have not agreed to AI processing, so consider
          telling your group.
        </p>
        <button className="danger" onClick={wipe}>
          Delete all data on this device
        </button>
      </div>
      <p className="muted small center">Group Digest test build · not affiliated with WhatsApp or Meta</p>
    </section>
  );
}
