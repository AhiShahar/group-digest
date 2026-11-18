import { describe, expect, it } from 'vitest';
import { chatNameFromFilename, parseChatText } from './parser';

const d = (ts: number) => {
  const x = new Date(ts);
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()} ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}`;
};

describe('parseChatText', () => {
  it('parses Android US format with AM/PM and multi-line messages', () => {
    const raw = [
      '12/31/23, 9:15 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
      '12/31/23, 9:15 PM - Dana: Party at mine Saturday 8pm',
      'bring snacks',
      '1/2/24, 12:05 AM - Sam: <Media omitted>',
      '1/2/24, 12:30 PM - Sam added Lee',
    ].join('\n');
    const chat = parseChatText(raw, 'Friends', 'DMY');
    expect(chat.dateOrder).toBe('MDY');
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0]).toMatchObject({ sender: 'Dana', text: 'Party at mine Saturday 8pm\nbring snacks' });
    expect(d(chat.messages[0].ts)).toBe('2023-12-31 21:15');
    expect(chat.messages[1].media).toBe(true);
    expect(d(chat.messages[1].ts)).toBe('2024-1-2 0:05');
    expect(chat.messages[2].sender).toBeNull();
    expect(d(chat.messages[2].ts)).toBe('2024-1-2 12:30');
  });

  it('parses Android European 24h format', () => {
    const raw = '31/12/2023, 21:15 - Dana: hi\n01/01/2024, 08:00 - Avi: happy new year';
    const chat = parseChatText(raw, 'x', 'MDY');
    expect(chat.dateOrder).toBe('DMY');
    expect(d(chat.messages[1].ts)).toBe('2024-1-1 8:00');
  });

  it('parses iOS bracket format with seconds, narrow spaces and LRM marks', () => {
    const raw = [
      '‎[12/03/2024, 18:02:11] Group: ‎Messages and calls are end-to-end encrypted.',
      '[12/03/2024, 18:02:45] Noa Levi: Meeting moved to 25/03 at 17:00',
      '[13/03/2024, 7:01:02 AM] Noa Levi: ‎image omitted',
    ].join('\n');
    const chat = parseChatText(raw, 'School', 'MDY');
    expect(chat.dateOrder).toBe('DMY');
    expect(chat.messages[0].sender).toBe('Noa Levi');
    expect(d(chat.messages[0].ts)).toBe('2024-3-12 18:02');
    expect(chat.messages[1].media).toBe(true);
    expect(d(chat.messages[1].ts)).toBe('2024-3-13 7:01');
  });

  it('parses dotted German format', () => {
    const chat = parseChatText('24.12.23, 18:30 - Opa: Frohe Weihnachten', 'x');
    expect(chat.messages[0].sender).toBe('Opa');
    expect(d(chat.messages[0].ts)).toBe('2023-12-24 18:30');
  });

  it('does not treat a continuation line with numbers as a header', () => {
    const raw = '1/5/24, 10:00 - A: totals:\n10 - 2 = 8\n12/12 is the date';
    const chat = parseChatText(raw, 'x', 'MDY');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].text).toBe('totals:\n10 - 2 = 8\n12/12 is the date');
  });
});

describe('chatNameFromFilename', () => {
  it('extracts group names', () => {
    expect(chatNameFromFilename('WhatsApp Chat with Book Club.txt')).toBe('Book Club');
    expect(chatNameFromFilename('WhatsApp Chat - Parents 3B.zip')).toBe('Parents 3B');
    expect(chatNameFromFilename('_chat.txt')).toBe('Chat');
  });
});
