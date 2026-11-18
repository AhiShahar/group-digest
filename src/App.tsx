import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildIcs, downloadFile, googleCalendarUrl, outlookCalendarUrl, safeFilename } from './lib/calendar';
import type { Digest, DigestEvent } from './lib/digest';
import { finishOpenRouterSignIn, startOpenRouterSignIn } from './lib/openrouter';
import { parseChatText, readExportFile } from './lib/parser';
import { PROVIDERS, providerInfo, type ProviderId } from './lib/providerInfo';

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
  takeSharedFiles,
  type AppSettings,
  type StoredChat,
  type StoredDigest,
} from './lib/store';

type View = { name: 'chats' } | { name: 'chat'; id: string } | { name: 'settings' };

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

export default function App() {
  const [view, setView] = useState<View>({ name: 'chats' });
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);

  const refreshChats = useCallback(async () => setChats(await listChats()), []);

  const importFiles = useCallback(
    async (files: File[]) => {
      let lastId: string | null = null;
      for (const file of files) {
        try {
          const { text, name } = await readExportFile(file);
          const parsed = parseChatText(text, name);
          if (!parsed.messages.length) throw new Error(`No messages found in ${file.name}. Is it a WhatsApp export?`);
          const existing = (await listChats()).find((c) => c.name === parsed.name);
          if (existing) {
            const merged = mergeMessages(existing.messages, parsed.messages);
            await putChat({ ...existing, messages: merged, importedAt: Date.now() });
            lastId = existing.id;
            setToast(`Updated "${parsed.name}": ${merged.length - existing.messages.length} new messages.`);
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
          s = { ...s, provider: 'openrouter', apiKey: key, model: s.provider === 'openrouter' ? s.model : 'openrouter/auto' };
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
    })();
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [importFiles, refreshChats]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const updateSettings = async (s: AppSettings) => {
    setSettings(s);
    await saveSettings(s);
  };

  const needsSetup = loaded && providerInfo(settings.provider).needsKey && !settings.apiKey;

  return (
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
        {needsSetup && view.name !== 'settings' && (
          <div className="banner">
            <span>Connect your AI first. You bring your own key, so summaries are billed to you and your chats never touch our servers.</span>
            <button className="primary" onClick={() => setView({ name: 'settings' })}>
              Set up AI
            </button>
          </div>
        )}
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

        {view.name === 'chats' && <ChatList chats={chats} onImport={importFiles} onOpen={(id) => setView({ name: 'chat', id })} />}
        {view.name === 'chat' && (
          <ChatView
            id={view.id}
            settings={settings}
            onBack={() => setView({ name: 'chats' })}
            onChanged={refreshChats}
            onToast={setToast}
            onNeedSetup={() => setView({ name: 'settings' })}
          />
        )}
        {view.name === 'settings' && <Settings settings={settings} onChange={updateSettings} onToast={setToast} onWiped={refreshChats} />}
      </main>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
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
        <p className="muted">Import a WhatsApp chat export (.txt or .zip). It stays on this device.</p>
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
        <details className="howto">
          <summary>How to export a group from WhatsApp</summary>
          <ol>
            <li>Open the group in WhatsApp and tap its name at the top.</li>
            <li>
              Scroll down and tap <b>Export chat</b>, then <b>Without media</b>.
            </li>
            <li>
              <b>Android:</b> pick <b>Group Digest</b> in the share sheet (after installing the app), or save the file and import it here.
            </li>
            <li>
              <b>iPhone:</b> choose <b>Save to Files</b>, then tap <b>Import chat export</b> here and pick the .zip.
            </li>
            <li>Next time, export again: only new messages are added.</li>
          </ol>
        </details>
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
}) {
  const { id, settings, onBack, onChanged, onToast, onNeedSetup } = props;
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
      );
      const rec: StoredDigest = {
        id: newId(),
        chatId: chat.id,
        createdAt: Date.now(),
        from: selected[0].ts,
        to: selected[selected.length - 1].ts,
        messageCount: selected.length,
        model: `${settings.provider}/${settings.model}`,
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

      <div className="card">
        <label>
          What to summarize
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            {chat.lastDigestEnd && <option value="since">New since last digest</option>}
            <option value="1">Last day of the export</option>
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
            Using {providerInfo(settings.provider).label.split(' (')[0]} · {settings.model}
          </span>
        </div>
        {!selected.length && chat.messages.length > 0 && <p className="muted small">No new messages in this range. Import a newer export.</p>}
        {error && <p className="error">{error}</p>}
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

function DigestCard({ rec, chatName, open, onToast }: { rec: StoredDigest; chatName: string; open: boolean; onToast: (s: string) => void }) {
  const d = rec.digest;
  const share = async () => {
    const text = digestAsText(chatName, d);
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        onToast('Summary copied.');
      }
    } catch {
      /* user cancelled */
    }
  };
  const allIcs = async () => {
    downloadFile(`${safeFilename(chatName)}-events.ics`, await buildIcs(d.events, chatName), 'text/calendar');
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
              <EventRow key={i} e={e} chatName={chatName} />
            ))}
          </ul>
          {d.events.length > 1 && (
            <button onClick={allIcs}>Add all {d.events.length} to calendar (.ics)</button>
          )}
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

function EventRow({ e, chatName }: { e: DigestEvent; chatName: string }) {
  const when = new Date(`${e.date}T${e.start_time ?? '00:00'}:00`).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(e.start_time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
  const ics = async () => downloadFile(`${safeFilename(e.title)}.ics`, await buildIcs([e], chatName), 'text/calendar');
  return (
    <li className={`event ${e.confidence}`}>
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
      </div>
    </li>
  );
}

// ---------------- Settings ----------------

function Settings({
  settings,
  onChange,
  onToast,
  onWiped,
}: {
  settings: AppSettings;
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
      onToast(`Connected. ${list.length} models available.`);
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
              Get a key
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
          <input list="models" value={settings.model} onChange={(e) => onChange({ ...settings, model: e.target.value.trim() })} />
          <datalist id="models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
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
        <div className="row">
          <button onClick={askNotify}>{settings.notify && 'Notification' in window && Notification.permission === 'granted' ? 'Notifications on' : 'Turn on notifications'}</button>
          <span className="muted small">Notifies you when a long digest finishes in the background.</span>
        </div>
      </div>

      <h2>Privacy</h2>
      <div className="card">
        <p className="small">
          Chats, digests and keys live only in this browser on this device. The only network calls are to the AI provider you chose, with the
          messages you asked it to summarize (phone numbers are masked first). Other group members have not agreed to AI processing, so consider
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
