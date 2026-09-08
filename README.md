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
3. Choose a camera.
4. **Add channel** for instructor mic, room mic, laptop audio, etc. Use Mute / Solo / Volume and watch meters.
5. Press **Start class**.
6. Copy the viewer link and share it.
7. Press **End class** when finished.

Audio is mixed in the browser (Web Audio API) into **one** outgoing track — Stream live ingest is a single A/V mix.

## Watch (students)

Open `/watch`. Prefer **Ultra-low latency** (WHEP) while the instructor is live via WHIP. **Stream player** also works when `STREAM_CUSTOMER_CODE` is set (player auto-upgrades to WHEP for WebRTC inputs).

## Deploy

```bash
npm run deploy
```

## Notes

- Ingest path: browser → **WHIP** → Cloudflare Stream live input.
- WHIP inputs use WebRTC end-to-end; HLS recording for WHIP is not available yet (per Cloudflare Stream WebRTC docs).
- Do not share the WHIP URL; the Worker only returns it to hosts with a valid `HOST_TOKEN`.
- Serve over `https` or `localhost` (required for `getUserMedia`).
