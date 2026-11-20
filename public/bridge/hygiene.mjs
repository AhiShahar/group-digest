// Keeping the linked device quiet, to lower the chance that WhatsApp flags it:
// the server only reads. It never sends messages, receipts for reading,
// presence ("online", "typing") or changes to chats, groups or the profile,
// and it keeps its own requests to WhatsApp few and spread out.

/** Socket methods that would act as the user. The server never needs them. */
const WRITES =
  /^(sendMessage|relayMessage|sendPresenceUpdate|presenceSubscribe|readMessages|chatModify|star|updateBlockStatus|update(Profile|Privacy|Default|Media|Last|Online|Call|Messages|Groups|Status|ReadReceipts)\w*|removeProfilePicture|group(Create|Leave|Update|Participants|Setting|Invite|Revoke|Accept|Toggle|Join|Request|MemberAdd)\w*|rejectCall|offerCall|newsletter(Follow|Unfollow|Create|Update|Delete|Mute|Unmute|React|ReactMessage)\w*|add(Chat|Message)?Label|remove(Chat|Message)Label|addOrEdit\w*|removeContact|removeQuickReply|removeCoverPhoto|update(Cover|Disable|Member|Bussines|Business)\w*|product(Create|Delete|Update)|createCallLink|newsletter(ChangeOwner|Demote|RemovePicture)|community(Create|Leave|Update|Link|Unlink|Participants|Invite|Revoke|Accept|Toggle|Setting|MemberAdd|JoinApproval|Request)\w*)$/;

/**
 * Make a Baileys socket read-only for anything outside Baileys itself: every
 * method that would send or change something as the user throws instead.
 * Baileys' own protocol work (keep-alive, delivery acks, decryption retries)
 * uses internal functions and is not affected. Returns the blocked names.
 */
export function makeReadOnly(sock, onBlocked = () => {}) {
  const blocked = [];
  for (const name of Object.keys(sock)) {
    if (typeof sock[name] !== 'function' || !WRITES.test(name)) continue;
    blocked.push(name);
    sock[name] = async () => {
      onBlocked(name);
      throw new Error(`read-only: ${name} is disabled on the sync server`);
    };
  }
  return blocked;
}

/** At most `max` events per `windowMs`. */
export class Limiter {
  constructor(max, windowMs) {
    Object.assign(this, { max, windowMs, times: [] });
  }
  prune(now) {
    while (this.times.length && this.times[0] <= now - this.windowMs) this.times.shift();
  }
  allow(now = Date.now()) {
    this.prune(now);
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
  count(now = Date.now()) {
    this.prune(now);
    return this.times.length;
  }
}

/**
 * How long to wait before reconnecting: exponential with ±20% jitter, at most
 * 5 minutes, and at least 30 minutes once a connection has dropped 6 times in
 * an hour (something is wrong, and hammering WhatsApp makes it look worse).
 */
export function reconnectDelay(retry, closesLastHour, rand = Math.random) {
  if (closesLastHour >= 6) return 30 * 60e3 * (0.9 + rand() * 0.2);
  const base = Math.min(5 * 60e3, 2000 * 2 ** retry);
  return Math.round(base * (0.8 + rand() * 0.4));
}

/** A random delay in [min, max] ms, to spread out work across people and restarts. */
export const jitter = (min, max, rand = Math.random) => Math.round(min + rand() * (max - min));
