# Group Digest

Summarize WhatsApp group chats and turn the plans in them into calendar events, using **your own AI**.

This is the phase 1 test build from the [design proposal](https://claude.ai/artifact/11myekyjMJAA523nXJEMJV). It is an installable web app (PWA) that runs entirely on the user's device:

- **Import** a WhatsApp chat export (`.txt` or `.zip`, Android or iPhone, any common date format). Re-importing a newer export adds only the new messages.
- **Summarize** with the AI the user picks: headline, key points, decisions, to-dos, open questions and possible events.
- **Add events** to Google Calendar, Outlook, or Apple Calendar (`.ics`), one at a time or all at once. Nothing is added without a tap.
- **Reminders** for each event, set in AI and settings (how far ahead, and how often to repeat). Calendar files (.ics) carry them as alarms, so they work on iPhone too; the Android app can also post its own notifications (Remind me). Google and Outlook links use the calendar's default reminder. On the website, Remind me uses Web Push through this site's Worker (`worker/push.ts`): only the event title and time are sent, one Durable Object per browser wakes itself when a reminder is due, and the VAPID keys are created automatically on first use. iPhone needs the app on the Home Screen (iOS 16.4+).
- **Ask across groups** (Ask tab): instant search over every stored group (Hebrew prefixes match too), "Ask the AI" with answers and sources (only messages matching the question's words, plus a little context, go to the AI), and an overview of upcoming dates, open to-dos (tick them off) and recent decisions from the last three weeks of digests.
- **Share** the summary back to WhatsApp or anywhere else.
- **Android share-to-app:** after installing, WhatsApp > Export chat > Group Digest imports the chat directly.

There is no backend. Chats, digests and keys are stored in the browser's IndexedDB on that device. The only network calls go to the AI provider the user chose. Phone numbers are masked before sending.

## Bring your own AI

| Provider | How users connect | Notes |
| --- | --- | --- |
| Claude | Anthropic API key from the Claude Console | A Claude.ai Free, Pro or Max subscription cannot be used by third-party apps (Anthropic terms). Default model `claude-opus-5-5`, effort `low`, structured JSON output, server-side refusal fallback. |
| OpenAI | API key | JSON mode via Chat Completions. "Sign in with ChatGPT" is partner-only for now. |
| Gemini | Google AI Studio API key | Free tier available. Consumer Google AI subscriptions cannot be used by third-party apps. |
| OpenRouter | **Sign in with OpenRouter** (OAuth PKCE) | The real "sign in" option: one login gives Claude, GPT, Gemini and more, billed to the user's OpenRouter credits. |
| Local / other | Any OpenAI-compatible URL | Ollama, LM Studio, vLLM. For Ollama on the same computer set `OLLAMA_ORIGINS` to the app's origin. |

## Android APK (no hosting needed)

`android/` is a small native wrapper (one WebView activity, no Gradle) that bundles the app inside the APK. It adds Android touches: WhatsApp's share sheet imports straight into the app, "Add to calendar" opens the phone's calendar with the event filled in, and summaries share through the normal share sheet.

```bash
# one-time on Ubuntu: sudo apt install android-sdk android-sdk-platform-23 dalvik-exchange apksigner zipalign openjdk-21-jdk
npm run build:apk     # writes android/dist/group-digest-<version>.apk
```

The first build creates a test signing key at `android/group-digest-test.keystore`. Keep it: Android only installs updates signed with the same key. Set `KEYSTORE` and `KS_PASS` to use another.

**Automatic capture (Android app only):** with notification access, the app saves messages from the WhatsApp groups the user ticks, as their notifications arrive (`CaptureService`). Private chats and unticked groups are ignored. It cannot see older history, muted groups, or messages read while the chat is open, and WhatsApp's notification previews must be on. Messages wait in a private file until the app stores them in IndexedDB, then merge with exports (duplicates are dropped). On Android 13+ a sideloaded app must first get App info > ⋮ > Allow restricted settings.

**Two APKs:** `npm run build:apk` writes `group-digest-<v>.apk` (full, with automatic capture) and `group-digest-<v>-lite.apk` (no notification access). Google Play Protect automatically blocks sideloaded apps that declare a notification listener when they are installed from a browser, messaging app or file manager, in some countries ([Google's guidance](https://developers.google.com/android/play-protect/warning-dev-guidance)). The lite APK avoids that block. To install the full APK where it is blocked: `adb install group-digest-<v>.apk` from a computer, or turn off Play Store > Play Protect > Scan apps with Play Protect, install, then turn it back on. Both use the same package and key, so either can be installed over the other.

**Installing the APK:** send the file to the phone (WhatsApp, email, Drive), tap it, allow "Install unknown apps" for the app you opened it from when asked, then tap Install. If Play Protect warns about an unknown developer, choose "Install anyway". Android 7 or newer.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (parser, digest, calendar)
npm run build      # production build in dist/
npm run preview    # serve dist/ at http://localhost:4173
```

Sample exports for trying it out are in `samples/`.

## Deploy for testers

Hosted on Cloudflare Workers static assets (free). `wrangler.jsonc` points at `dist/`.

- In Cloudflare: Workers & Pages > Create > Import a repository > pick this repo.
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Path: `/`
- Every push to `main` redeploys. The app lives at `https://group-digest.<your-subdomain>.workers.dev`.

The build uses relative paths, so any other HTTPS static host works too (build `npm run build`, output `dist`).

## Installing (testers)

1. Open the app link.
2. **iPhone / iPad (Safari):** Share > Add to Home Screen. Export chats with WhatsApp > group > Export chat > Without media > Save to Files, then import the zip in the app.
3. **Android (Chrome):** tap Install when prompted, or menu > Install app. Then WhatsApp > group > Export chat > Without media > Group Digest.
4. **Desktop (Chrome, Edge):** install icon in the address bar. Drag an export onto the page.
5. Open **AI and settings**, choose a provider, paste a key (or sign in with OpenRouter), tap **Check connection**.

Each person's data and key stay on their own device, so testers do not see each other's chats.

## Live sync (linked device)

**Scheduled digests (live sync):** in Live sync, pick Every day or Every week and a time. The sync server keeps the chosen groups' messages on its disk (sealed with the person's own key, 3 days for daily, 9 for weekly, deleted when turned off), summarizes each group with new messages at that time using the AI settings sent from the phone (inside the encrypted config), and sends the digests through the relay like messages. A sealed notice goes to the relay's `/notice`, which Web Pushes it to phones that tapped Notify me; the service worker opens it with the room key, so the Worker never sees the text. Code: `public/bridge/digest.mjs` (same prompt as the app, checked by a test), `src/Scheduled.tsx`.

**Health alerts (live sync):** Live sync > Turn on alerts. The relay's room for the server owner sets a Durable Object alarm 40 minutes after each status report; if it fires, the owner's phones get "Sync server is offline" (again daily, at most 3 times) and "back online" when it reports again. The sync server itself sends sealed notices when WhatsApp logs the linked device out, when another copy takes over the link, or when it cannot reach WhatsApp for an hour. The Chats screen shows a banner while a problem is open. The Android app has no Web Push, so `NoticeReceiver` checks the room's notices about every half hour and shows them as notifications.

**Backups:** with live sync set up, the app backs up its data (groups, messages, digests, settings, pairing) about once a day when opened, gzipped and sealed with the pairing key, to the relay room (`/backup`, parts of 120 KB, only the last committed copy kept). Settings > Backup shows the recovery key (`gd1-<room>-<secret>`), which restores everything on a new phone. The sync server backs up its own data directory (WhatsApp links, invite key, friends; not message archives) daily and after links or joins; a fresh VM made with the same setup script restores it on first start (`public/bridge/backup.mjs`).

**Friends:** Live sync > Friends on your server > Create invite gives a one-time link that works for 7 days, with Send on WhatsApp, Copy and a QR code to scan. The friend opens it on their phone, types their name and links WhatsApp (phone-number code by default on phones), then follows a short checklist. Each friend sees exactly what the owner can see, and can hide their link status and last sync from the owner.

Settings > **Live sync from WhatsApp** links WhatsApp once by QR code, like WhatsApp Web, and new messages from the groups you tick flow into the app on any phone, iPhone included. Unofficial: WhatsApp may restrict accounts that use it, so start with your own number.

```
WhatsApp <-> sync server (your VM) --encrypted--> relay (this Worker) --encrypted--> app
```

- **Sync server** (`public/bridge/`, Node + Baileys): links one account, keeps only the link on disk (`/var/lib/group-digest/auth`) so restarts reconnect, forwards messages from chosen groups only, holds message text in memory for seconds. Outgoing connections only, so no domain, tunnel or open port.
- **Relay** (`worker/index.ts`): one SQLite Durable Object per pairing on the Workers free plan. Stores ciphertext only; batches are deleted once the app has them, or after 7 days.
- **Encryption** (`src/lib/syncCrypto.ts`, `public/bridge/crypto.mjs`): the app makes a random room id and 256-bit secret; HMAC-SHA256 derives the relay token and an AES-256-GCM key. The secret is in the setup command and never reaches the relay.
- **Hosting:** the app shows a ready-made setup for Oracle Cloud Always Free (free, incl. public IP), Google Cloud (e2-micro is free-tier but its public IPv4 is billed about $3.65/month), or any Linux machine: `curl -fsSL https://<app>/bridge/setup.sh | sudo bash -s -- <relay> <room> <secret>`. The service refreshes its code from the Worker on every restart.
- **Friends on your server:** the owner creates one-time invite links in the app (`#join=<inbox>.<server key>.<code>.<name>`). A friend opens it, scans a QR code, and gets their own session on the owner's server: their own WhatsApp link, relay room and key, so neither side can read the other's messages. Join requests are sealed to the server's ECDH P-256 key and dropped in an inbox room on the relay that only the server can read; apps also drop a "settings changed" nudge there, so the server polls one inbox instead of every user. The owner can remove a friend (their WhatsApp is logged out and their data deleted); a friend can leave. Capacity is worked out from the VM's memory (about 110 MB per person; `GD_MAX_USERS` overrides), so resizing the Oracle VM (Ampere is free up to 4 OCPU / 24 GB) raises it after a restart.
- **Updates:** the server checks the Worker every 6 hours and restarts itself when a new version is published (the systemd unit refreshes the code on start).
- Server logs: `sudo journalctl -u group-digest-sync -f` (no message text is logged).

## Not in this build

Scheduled digests, push notifications from a server and Google Calendar direct insert are phase 2 in the design. Local notifications fire only when a long digest finishes while the app is in the background.

## Layout

```
src/lib/parser.ts        WhatsApp export parser (.txt and .zip)
src/lib/digest.ts        schema, prompt, chunking, merging, event checks
src/lib/providers.ts     Claude (Anthropic SDK), OpenAI-compatible, Gemini adapters
src/lib/providerInfo.ts  provider list shown in settings
src/lib/openrouter.ts    OpenRouter OAuth PKCE sign-in
src/lib/calendar.ts      .ics, Google and Outlook links
src/lib/store.ts         IndexedDB storage, retention, share-target pickup
src/sw.ts                service worker: offline cache, Android share target
src/App.tsx              UI
src/LiveSync.tsx         live sync settings (setup, QR, groups)
src/lib/liveSync.ts      relay client, pull + decrypt + store
worker/index.ts          Worker: static app + encrypted relay
public/bridge/           sync server (bridge.mjs, parse.mjs, crypto.mjs, setup.sh)
```
