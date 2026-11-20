// When each WhatsApp group last had a message, so the app can list the groups
// that are actually in use. Learned from every message the linked device
// receives (chosen groups or not) and from the chat list WhatsApp sends right
// after linking. Only group ids and times are kept, never content.

const isGroup = (id) => typeof id === 'string' && id.endsWith('@g.us');
/** Baileys timestamps are seconds, as a number or a Long. */
const ms = (t) => (t == null ? 0 : (typeof t === 'object' ? Number(t.toString()) : Number(t)) * 1000 || 0);

export class Activity {
  constructor(data = {}) {
    this.last = {};
    for (const [id, t] of Object.entries(data || {})) if (isGroup(id) && Number(t) > 0) this.last[id] = Number(t);
    this.dirty = false;
  }
  note(id, t, now = Date.now()) {
    if (!isGroup(id) || !(t > 0)) return;
    t = Math.min(t, now);
    if ((this.last[id] || 0) >= t) return;
    this.last[id] = t;
    this.dirty = true;
  }
  /** From a Baileys message. */
  noteMessage(msg, now) {
    this.note(msg?.key?.remoteJid, ms(msg?.messageTimestamp), now);
  }
  /** From a Baileys chat (history sync, chats.upsert, chats.update). */
  noteChat(chat, now) {
    this.note(chat?.id, Math.max(ms(chat?.conversationTimestamp), ms(chat?.lastMessageRecvTimestamp)), now);
  }
  /** Forget groups the device is no longer in. */
  keepOnly(ids) {
    const keep = new Set(ids);
    for (const id of Object.keys(this.last))
      if (!keep.has(id)) {
        delete this.last[id];
        this.dirty = true;
      }
  }
}
