# Group Digest

Summarize WhatsApp group chats and turn the plans in them into calendar events, using **your own AI**.

This is the phase 1 test build from the [design proposal](https://claude.ai/artifact/11myekyjMJAA523nXJEMJV). It is an installable web app (PWA) that runs entirely on the user's device:

- **Import** a WhatsApp chat export (`.txt` or `.zip`, Android or iPhone, any common date format). Re-importing a newer export adds only the new messages.
- **Summarize** with the AI the user picks: headline, key points, decisions, to-dos, open questions and possible events.
- **Add events** to Google Calendar, Outlook, or Apple Calendar (`.ics`), one at a time or all at once. Nothing is added without a tap.
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

The build is static files with relative paths, so any HTTPS static host works (HTTPS is required for install and the service worker).

- **GitHub Pages:** push to `main`; `.github/workflows/deploy.yml` tests, builds and deploys. In the repo, set Settings > Pages > Source to "GitHub Actions" once.
- **Netlify / Cloudflare Pages / Vercel:** build command `npm run build`, output directory `dist`. Or drag the `dist` folder onto Netlify Drop.

## Installing (testers)

1. Open the app link.
2. **iPhone / iPad (Safari):** Share > Add to Home Screen. Export chats with WhatsApp > group > Export chat > Without media > Save to Files, then import the zip in the app.
3. **Android (Chrome):** tap Install when prompted, or menu > Install app. Then WhatsApp > group > Export chat > Without media > Group Digest.
4. **Desktop (Chrome, Edge):** install icon in the address bar. Drag an export onto the page.
5. Open **AI and settings**, choose a provider, paste a key (or sign in with OpenRouter), tap **Check connection**.

Each person's data and key stay on their own device, so testers do not see each other's chats.

## Not in this build

Live WhatsApp linking (linked-device bridge), scheduled digests, push notifications from a server and Google Calendar direct insert need a server and are phase 2 in the design. Local notifications fire only when a long digest finishes while the app is in the background.

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
```
