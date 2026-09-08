# Training Center

Browser studio for teaching live over **Cloudflare Stream**. Instructors mix several microphones in the browser, go live with **WHIP** (WebRTC), and students watch with the **Stream player** or **WHEP**.

> Deploy package / Worker name remains `cloud-stream-tc` (unchanged for existing deploys).

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars
# edit .dev.vars — see below
npm run dev
```

Open:

- Home: `http://localhost:5173/`
- Host studio: `http://localhost:5173/host`
- Viewer: `http://localhost:5173/watch`

## Cloudflare setup (dashboard)

1. Create an API token with **Stream:Edit** ([API tokens](https://dash.cloudflare.com/profile/api-tokens)).
2. Copy your **Account ID**.
3. In **Stream → Live inputs**, create a live input (or create one from the host studio after unlock).
4. Open the live input → **Broadcast** tab → confirm a **WebRTC / WHIP** publish URL exists.
5. Copy the live input **UID**.
6. From any Stream embed URL, copy the customer code: `customer-<CODE>.cloudflarestream.com`.

## Secrets / env

| Name | Where | Purpose |
|------|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` / secret | Account id |
| `STREAM_API_TOKEN` | `.dev.vars` / secret | Stream API bearer token |
| `HOST_TOKEN` | `.dev.vars` / secret | Password for `/host` |
| `STREAM_LIVE_INPUT_UID` | `wrangler.jsonc` `vars` or `.dev.vars` | Live input to publish/play |
| `STREAM_CUSTOMER_CODE` | `wrangler.jsonc` `vars` or `.dev.vars` | Stream player subdomain code |

Local: put values in `.dev.vars` (loaded automatically).

Deploy secrets:

```bash
npx wrangler secret put STREAM_API_TOKEN
npx wrangler secret put HOST_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

Set `STREAM_LIVE_INPUT_UID` and `STREAM_CUSTOMER_CODE` in `wrangler.jsonc` `vars` (they are not highly sensitive) or as secrets if you prefer.

## Go live (instructor)

1. Open `/host`, enter `HOST_TOKEN`.
2. Allow camera/mic permissions.
3. Choose the **main camera** (fills the stage).
4. Optionally enable **picture-in-picture**:
   - Upload a **slideshow** (PDF and/or images) and step through slides, or
   - Attach a **second camera** or **screen/tab share** as the PiP source.
   - Pick PiP corner and size. The studio preview shows the composed picture.
5. **Add channel** for instructor mic, room mic, laptop audio, etc. Use Mute / Solo / Volume and watch meters.
6. Press **Start class** — the composed video (main + PiP) is what WHIP publishes.
7. Copy the viewer link and share it.
8. Press **End class** when finished.

Audio is mixed in the browser (Web Audio API) into **one** outgoing track — Stream live ingest is a single A/V mix. Video is composed on a canvas (main camera + optional PiP) before publish.

### Live sources board

Under the preview, **Live sources** lists every visual feed (main camera, slideshow, second camera, screen share) and every audio channel with an on/off switch. Switching the main camera off promotes the active PiP feed to the full stage (or composes a "Camera off" card), so slides-only or audio-only teaching works without stopping the class.

### Student talk-back (push-to-talk)

Cloudflare Stream live inputs are one-way, so student audio comes back over a separate WebSocket relay (`/api/room/ws`, handled by the `ClassRoom` Durable Object). Students hold **Talk** on `/watch`; the instructor hears them on their own speakers/headphones and can tick **Also send student voices into the live mix** so every viewer hears the question. The **Student talk-back** switch disables the students' Talk button entirely. Headphones are recommended for the instructor so the room mic does not re-capture student audio.

## Watch (students)

Open `/watch`. **Ultra-low latency** (WHEP) is the default while the instructor is live via WHIP. **Stream player** also works when `STREAM_CUSTOMER_CODE` is set (player auto-upgrades to WHEP for WebRTC inputs).

- **Mute** silences the class audio on your device only (shortcut `M`).
- **Hold to talk** (or hold `Space`) sends your microphone to the instructor; release to mute. Switch to **Press to toggle** if holding is awkward. Your name (optional) is shown to the instructor while you talk.

## Deploy

```bash
npm run deploy
```

The first deploy after this feature applies the `ClassRoom` Durable Object migration (`new_sqlite_classes`, available on the free plan). No new secrets are required — the relay reuses `HOST_TOKEN` to authenticate host tabs.

## Notes

- Ingest path: browser → **WHIP** → Cloudflare Stream live input.
- WHIP inputs use WebRTC end-to-end; HLS recording for WHIP is not available yet (per Cloudflare Stream WebRTC docs).
- Do not share the WHIP URL; the Worker only returns it to hosts with a valid `HOST_TOKEN`.
- Serve over `https` or `localhost` (required for `getUserMedia`).
- Talk-back audio is 16 kHz mono PCM over WebSocket (~256 kbps per student, only while their Talk button is held). It is not part of the Stream recording/playback unless the instructor sends it into the live mix.
