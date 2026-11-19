// Turns WhatsApp (Baileys) messages into the small records the app stores.
import { getContentType, isJidGroup, normalizeMessageContent } from 'baileys';

export const MEDIA_LABELS = {
  imageMessage: '📷 Photo',
  videoMessage: '🎥 Video',
  audioMessage: '🎤 Voice message',
  documentMessage: '📄 Document',
  documentWithCaptionMessage: '📄 Document',
  stickerMessage: 'Sticker',
  locationMessage: '📍 Location',
  liveLocationMessage: '📍 Live location',
  contactMessage: '👤 Contact',
  contactsArrayMessage: '👤 Contacts',
};

export function textOf(message) {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  const type = getContentType(m);
  if (!type) return null;
  const c = m[type];
  switch (type) {
    case 'conversation':
      return { text: m.conversation, media: false };
    case 'extendedTextMessage':
      return { text: c.text, media: false };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { text: `📊 Poll: ${c.name}\n${(c.options || []).map((o) => `• ${o.optionName}`).join('\n')}`, media: false };
    case 'eventMessage':
      return { text: `📅 Event: ${c.name}${c.description ? `\n${c.description}` : ''}`, media: false };
    default:
      if (MEDIA_LABELS[type]) {
        const cap = c?.caption || c?.message?.documentMessage?.caption || '';
        return { text: cap ? `${MEDIA_LABELS[type]}: ${cap}` : MEDIA_LABELS[type], media: true };
      }
      return null; // reactions, edits, protocol messages, key distribution...
  }
}

const tsOf = (t) => (typeof t === 'object' && t !== null ? Number(t.toString()) : Number(t)) * 1000;

export function toRecord(msg, groupNames, myName) {
  const group = msg.key?.remoteJid;
  if (!group || !isJidGroup(group) || !msg.message) return null;
  const body = textOf(msg.message);
  if (!body || !body.text?.trim()) return null;
  const sender = msg.key.fromMe
    ? myName || 'You'
    : msg.pushName || (msg.key.participantAlt || msg.key.participant || '').split('@')[0].split(':')[0] || null;
  return {
    id: msg.key.id,
    group,
    chat: groupNames.get(group) || group,
    ts: tsOf(msg.messageTimestamp) || Date.now(),
    sender,
    text: body.text,
    media: body.media,
  };
}

