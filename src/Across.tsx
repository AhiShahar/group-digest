// "Across groups" screen: search all groups, ask the AI, and see open to-dos,
// upcoming dates and recent decisions gathered from every group's digests.
import { useEffect, useMemo, useState } from 'react';
import { askContext, askPrompt, overview, search, type Answer } from './lib/ask';
import { DecisionCards } from './Decisions';
import { providerInfo } from './lib/providerInfo';
import { chatTitle } from './lib/title';
import { toggleDone as toggle, useDoneTodos } from './lib/doneTodos';
import { allDigests, type AppSettings, type StoredChat, type StoredDigest } from './lib/store';

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const day = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const stamp = (ts: number) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Mark({ text, q }: { text: string; q: string }) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </>
  );
}

export default function Across({
  chats,
  settings,
  onOpen,
  onNeedSetup,
}: {
  chats: StoredChat[];
  settings: AppSettings;
  onOpen: (id: string) => void;
  onNeedSetup: () => void;
}) {
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [answer, setAnswer] = useState<(Answer & { q: string; count: number }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [digests, setDigests] = useState<StoredDigest[]>([]);
  const done = useDoneTodos();
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    allDigests().then(setDigests);
  }, [chats]);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const hits = useMemo(() => (q.trim() ? search(chats, q, 200) : []), [chats, q]);
  const ov = useMemo(() => overview(chats, digests, localDay()), [chats, digests]);
  const openTodos = ov.todos.filter((t) => !done.includes(t.key));
  const doneTodos = ov.todos.filter((t) => done.includes(t.key));
  const byName = new Map(chats.flatMap((c) => [[c.name, c.id] as const, [chatTitle(c), c.id] as const]));

  const ask = async () => {
    const question = typed.trim();
    if (!question) return;
    if (providerInfo(settings.provider).needsKey && !settings.apiKey) return onNeedSetup();
    setError(null);
    setAnswer(null);
    setBusy('Reading your groups…');
    try {
      const ctx = askContext(chats, question);
      if (!ctx.count) throw new Error('No messages to look in yet. Import a chat or turn on live sync.');
      setBusy(`Asking the AI about ${ctx.count} messages in ${ctx.groups} group${ctx.groups === 1 ? '' : 's'}…`);
      const { ask: askAi } = await import('./lib/providers');
      const a = await askAi(settings, askPrompt(question, ctx.text, settings.language));
      setAnswer({ ...a, q: question, count: ctx.count });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <h1>Across your groups</h1>
      <div className="card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <label>
            Search, or ask a question
            <input
              type="search"
              placeholder="e.g. when is the school trip? / who owes money?"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              enterKeyHint="send"
            />
          </label>
          <div className="row">
            <button className="primary" type="submit" disabled={!!busy || !typed.trim()}>
              {busy ? 'Asking…' : 'Ask the AI'}
            </button>
            {q.trim() && <span className="small muted">{hits.length >= 200 ? '200+' : hits.length} matching messages</span>}
          </div>
        </form>
        {busy && <p className="small muted">{busy}</p>}
        {error && <p className="small warn">{error}</p>}
        {answer && (
          <div className="answer">
            <p style={{ whiteSpace: 'pre-line' }}>{answer.answer}</p>
            {answer.sources.length > 0 && (
              <ul className="small">
                {answer.sources.slice(0, 5).map((s, i) => (
                  <li key={i}>
                    {byName.has(s.group) ? (
                      <button className="link inline" onClick={() => onOpen(byName.get(s.group)!)}>
                        {s.group}
                      </button>
                    ) : (
                      <b>{s.group}</b>
                    )}{' '}
                    <span className="muted">· {s.date}</span>: “<span dir="auto">{s.quote}</span>”
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted">
              Based on {answer.count} messages. The AI only sees messages that match your question's words, plus a little around them.
            </p>
          </div>
        )}
      </div>

      {q.trim() && hits.length > 0 && (
        <>
          <h2>Messages</h2>
          <ul className="hits">
            {hits.slice(0, 40).map((h, i) => (
              <li key={i}>
                <button onClick={() => onOpen(h.chatId)}>
                  <span className="small muted">
                    {h.chat} · {stamp(h.m.ts)} · {h.m.sender ?? 'system'}
                  </span>
                  <span className="hit-text" dir="auto">
                    <Mark text={h.m.text.length > 280 ? h.m.text.slice(0, 280) + '…' : h.m.text} q={q} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {hits.length > 40 && <p className="small muted">Showing the best 40. Add a word to narrow it down.</p>}
        </>
      )}

      {!q.trim() && (
        <>
          <h2>Coming up</h2>
          {ov.dates.length ? (
            <ul className="card plain">
              {ov.dates.slice(0, 20).map((d) => (
                <li key={d.key} className="when-row">
                  <button className="link inline" onClick={() => onOpen(d.chatId)}>
                    <b>{day(d.e.date)}</b>
                    {d.e.start_time ? ` ${d.e.start_time}` : ''} · {d.e.title}
                  </button>
                  <span className="small muted sub" dir="auto">{[d.e.location, d.chat].filter(Boolean).join(' · ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">Dates from your digests show up here. Summarize a group, or turn on scheduled digests in Live sync.</p>
          )}

          <h2>To do</h2>
          {openTodos.length || doneTodos.length ? (
            <ul className="card plain">
              {openTodos.map((t) => (
                <li key={t.key}>
                  <label className="check">
                    <input type="checkbox" checked={false} onChange={() => toggle(t.key)} />
                    <span>
                      {t.task}
                      {t.owner && <span className="pill">{t.owner}</span>}
                      {t.due && <span className="pill">by {day(t.due)}</span>}
                      <span className="small muted"> · {t.chat}</span>
                    </span>
                  </label>
                </li>
              ))}
              {doneTodos.length > 0 && (
                <li>
                  <button className="link inline small" onClick={() => setShowDone(!showDone)}>
                    {showDone ? 'Hide' : 'Show'} {doneTodos.length} done
                  </button>
                </li>
              )}
              {showDone &&
                doneTodos.map((t) => (
                  <li key={t.key} className="muted">
                    <label className="check">
                      <input type="checkbox" checked onChange={() => toggle(t.key)} />
                      <s>{t.task}</s>
                    </label>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="small muted">To-dos from the last three weeks of digests show up here.</p>
          )}

          {ov.decisions.length > 0 && (
            <>
              <h2>Recent decisions</h2>
              <DecisionCards rows={ov.decisions.map((x) => ({ d: x.d, group: x.chat, onOpenGroup: () => onOpen(x.chatId) }))} />
            </>
          )}
        </>
      )}
    </section>
  );
}
