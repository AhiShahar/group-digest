// Parser for WhatsApp "Export chat" files (Android and iOS, many locales).
//
// Android:  12/31/23, 9:15 PM - Dana: message
//           31/12/2023, 21:15 - Dana: message
//           31.12.23, 21:15 - Dana: message
// iOS:      [12/31/23, 9:15:30 PM] Dana: message
//           [31.12.23, 21:15:30] Dana: message
// Lines that do not start with a timestamp continue the previous message.

export interface ChatMessage {
  /** Local wall-clock time of the message, as epoch ms in the device's time zone. */
  ts: number;
  sender: string | null; // null = system message ("Dana added you")
  text: string;
  media: boolean;
}

export interface ParsedChat {
  name: string;
  messages: ChatMessage[];
  dateOrder: 'DMY' | 'MDY' | 'YMD';
}

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;
const SPACES = /[   ]/g;

// date, time, optional am/pm, then " - " (Android) or "] " (iOS)
const LINE_RE =
  /^\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([aApP]\.?\s?[mM]\.?)?\]?\s*(?:-\s|–\s)?(.*)$/;

const MEDIA_RE =
  /^(?:<attached: .*>|<Media omitted>|.*\b(?:image|video|audio|sticker|GIF|document) omitted|‎?<.* omitted>)$/i;

interface RawLine {
  a: number;
  b: number;
  c: number;
  h: number;
  m: number;
  s: number;
  ampm: string | null;
  rest: string;
}

function clean(line: string): string {
  return line.replace(INVISIBLE, '').replace(SPACES, ' ').replace(/\r$/, '');
}

function matchLine(line: string): RawLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  // Guard against a message body that merely starts with numbers: the line must
  // look like a header (iOS bracket, or Android " - ").
  const isIos = line.startsWith('[');
  const isAndroid = /^\d.*?\d{2}(?:\s*[aApP]\.?\s?[mM]\.?)?\s[-–]\s/.test(line);
  if (!isIos && !isAndroid) return null;
  return {
    a: Number(m[1]),
    b: Number(m[2]),
    c: Number(m[3]),
    h: Number(m[4]),
    m: Number(m[5]),
    s: m[6] ? Number(m[6]) : 0,
    ampm: m[7] ? m[7].replace(/[.\s]/g, '').toLowerCase() : null,
    rest: m[8] ?? '',
  };
}

function detectOrder(lines: RawLine[], fallback: 'DMY' | 'MDY'): 'DMY' | 'MDY' | 'YMD' {
  if (lines.some((l) => l.a > 31)) return 'YMD';
  if (lines.some((l) => l.a > 12)) return 'DMY';
  if (lines.some((l) => l.b > 12)) return 'MDY';
  return fallback;
}

function toTs(l: RawLine, order: 'DMY' | 'MDY' | 'YMD'): number {
  let day: number, month: number, year: number;
  if (order === 'YMD') [year, month, day] = [l.a, l.b, l.c];
  else if (order === 'DMY') [day, month, year] = [l.a, l.b, l.c];
  else [month, day, year] = [l.a, l.b, l.c];
  if (year < 100) year += 2000;
  let hour = l.h;
  if (l.ampm) {
    const pm = l.ampm.startsWith('p');
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return new Date(year, month - 1, day, hour, l.m, l.s).getTime();
}

/** Guess date order from the browser locale, used only when the file is ambiguous. */
export function localeDateOrder(): 'DMY' | 'MDY' {
  try {
    const parts = new Intl.DateTimeFormat(undefined).formatToParts(new Date(2001, 10, 22));
    const first = parts.find((p) => p.type === 'day' || p.type === 'month');
    return first?.type === 'month' ? 'MDY' : 'DMY';
  } catch {
    return 'DMY';
  }
}

function splitSender(rest: string): { sender: string | null; text: string } {
  // "Name: text". Names can contain ":" rarely; take the first ": ".
  const idx = rest.indexOf(': ');
  if (idx > 0 && idx < 80) {
    return { sender: rest.slice(0, idx).trim(), text: rest.slice(idx + 2) };
  }
  if (rest.endsWith(':') && rest.length < 80) {
    return { sender: rest.slice(0, -1).trim(), text: '' };
  }
  return { sender: null, text: rest };
}

export function parseChatText(
  raw: string,
  name = 'Chat',
  fallbackOrder: 'DMY' | 'MDY' = localeDateOrder(),
): ParsedChat {
  const lines = raw.split('\n').map(clean);
  const headers: (RawLine | null)[] = lines.map(matchLine);
  const order = detectOrder(headers.filter((h): h is RawLine => h !== null), fallbackOrder);

  const messages: ChatMessage[] = [];
  lines.forEach((line, i) => {
    const h = headers[i];
    if (h) {
      const { sender, text } = splitSender(h.rest);
      messages.push({ ts: toTs(h, order), sender, text, media: false });
    } else if (messages.length > 0) {
      const last = messages[messages.length - 1];
      last.text += '\n' + line;
    }
  });

  for (const msg of messages) {
    msg.text = msg.text.replace(/\n+$/, '');
    if (MEDIA_RE.test(msg.text.trim())) msg.media = true;
  }

  // Drop the end-to-end encryption notice that starts every export.
  // On iOS it is attributed to the group name, so match on text only.
  const filtered = messages.filter(
    (m, i) => !(i < 3 && /^Messages and calls are end-to-end encrypted/i.test(m.text.trim())),
  );
  return { name, messages: filtered, dateOrder: order };
}

/** "WhatsApp Chat with Book Club.txt" / "WhatsApp Chat - Book Club.zip" -> "Book Club" */
export function chatNameFromFilename(filename: string): string {
  const base = filename.replace(/\.(txt|zip)$/i, '').replace(/\s*\(\d+\)$/, '');
  const m = /WhatsApp Chat (?:with|-)\s*(.+)$/i.exec(base);
  if (m) return m[1].trim();
  if (base === '_chat') return 'Chat';
  return base.trim() || 'Chat';
}

/** Read a .txt or .zip export into text plus a display name. */
export async function readExportFile(file: File): Promise<{ text: string; name: string }> {
  const name = chatNameFromFilename(file.name);
  const isZip =
    /\.zip$/i.test(file.name) ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed';
  if (!isZip) return { text: await file.text(), name };
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const txt = Object.values(zip.files).find(
    (f) => !f.dir && /\.txt$/i.test(f.name) && !f.name.startsWith('__MACOSX'),
  );
  if (!txt) throw new Error('No chat .txt file found inside the zip.');
  const innerName = chatNameFromFilename(txt.name.split('/').pop() ?? '');
  return { text: await txt.async('string'), name: name === 'Chat' ? innerName : name };
}
