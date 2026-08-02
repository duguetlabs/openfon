# ☎ OpenFon

**Open-source AI phone agent for small businesses.** OpenFon answers your calls 24/7, answers questions from facts *you* provide, takes messages, and logs every conversation with a transcript and summary — on infrastructure you own.

Think of it as an open, self-hostable alternative to services like fonio.ai: no per-seat pricing, no vendor lock-in, your call data stays in your own database.

## How it works

Callers open your agent's link (`/call/your-business`) and talk to it straight from the browser — no app, no phone number required. Each utterance flows through:

```
caller's mic ──► Cloudflare Worker (Durable Object per call)
                   │  1. speech-to-text   (any OpenAI-compatible API)
                   │  2. LLM reply        (any OpenAI-compatible API)
                   │  3. text-to-speech   (Azure Speech, or free browser voices)
                   ◄── spoken reply + live captions
```

Transcripts, summaries, and messages land in your dashboard (D1/SQLite). When a call ends, the LLM writes a 1–2 sentence summary, classifies the intent (question / booking / message), and extracts any callback details the caller left.

## Features

- 🗣 **Browser voice calls** — WebSocket + voice-activity detection, live captions, text fallback for callers without a mic
- ⚡ **Two voice engines** — the default *Pipeline* (STT → LLM → TTS, works with any provider) or opt-in *Realtime* (continuous audio streaming to an OpenAI Realtime-compatible endpoint: sub-second replies and callers can interrupt the agent mid-sentence); switchable per business in Settings
- 🧠 **Bring your own AI** — defaults to [Kataleptic](https://api.kataleptic.com), works with OpenAI, Groq, Ollama, vLLM, or anything OpenAI-compatible; configurable per business from the dashboard
- 📋 **Grounded answers** — the agent only answers from your business facts (hours, services, prices, FAQ); unknown questions become messages
- 📞 **Call log** — transcripts, summaries, intent badges, messages with caller name & phone
- 🌍 **Multi-language** — English, German, Spanish, French out of the box
- 🪶 **Tiny footprint** — one Cloudflare Worker + D1; comfortably inside Cloudflare's free tier

## Self-hosting (10 minutes)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node 20+.

```sh
git clone https://github.com/duguetlabs/openfon
cd openfon && npm install
npx wrangler login

# 1. create your database
npx wrangler d1 create openfon       # copy the database_id into wrangler.jsonc
npm run db:migrate

# 2. secrets (LLM + speech-to-text; one key if you use one provider for both)
npx wrangler secret put DEFAULT_LLM_API_KEY
npx wrangler secret put DEFAULT_STT_API_KEY

# 3. text-to-speech (optional — skip it and OpenFon uses free browser voices)
npx wrangler secret put AZURE_SPEECH_KEY

# 4. ship it
npm run deploy
```

Open the printed `*.workers.dev` URL, create your account, and walk through onboarding. That's it.

> **Deploying with an API token** instead of `npx wrangler login` — from CI, or with
> `CLOUDFLARE_API_TOKEN` in your environment — needs two things, and missing either
> one fails before anything ships:
>
> 1. A **Custom Token** carrying `Workers Scripts: Edit` **and** `D1: Edit`.
>    `npm run deploy` applies pending D1 migrations before uploading the worker, and
>    Cloudflare's "Edit Cloudflare Workers" template does not grant D1.
> 2. **`CLOUDFLARE_ACCOUNT_ID`** in the environment (find it under Workers & Pages in
>    the dashboard sidebar). Without a cached login, wrangler tries to discover your
>    account by listing `/accounts`, which the two permissions above do not allow —
>    and which cannot choose between accounts non-interactively anyway. Supplying the
>    id skips that lookup entirely; widening the token with `Account Settings: Read`
>    also works but grants more and still breaks if the token can see more than one
>    account.
>
> `npx wrangler login` needs neither: it authorizes interactively and caches the
> account, which is why the steps above just work on your own machine.

### Configuration

Defaults live in `wrangler.jsonc` under `vars`; secrets via `wrangler secret put`.

| Variable | What it is | Default |
| --- | --- | --- |
| `DEFAULT_LLM_BASE_URL` | OpenAI-compatible chat API | `https://api.kataleptic.com/v1` |
| `DEFAULT_LLM_MODEL` | Chat model | `llama-3.3-70b` |
| `DEFAULT_LLM_API_KEY` | *(secret)* key for the LLM API | — |
| `DEFAULT_STT_BASE_URL` | OpenAI-compatible `/audio/transcriptions` API | `https://api.kataleptic.com/v1` |
| `DEFAULT_STT_MODEL` | Transcription model | `whisper-large-v3-turbo` |
| `DEFAULT_STT_API_KEY` | *(secret)* key for the STT API | — |
| `DEFAULT_TTS_PROVIDER` | `azure` or `browser` | `azure` |
| `AZURE_SPEECH_KEY` | *(secret)* Azure Speech key (only for `azure` TTS) | — |
| `AZURE_SPEECH_REGION` | Azure Speech region | `westeurope` |
| `DEFAULT_TTS_VOICE` | Azure neural voice | `en-US-JennyNeural` |
| `REALTIME_BASE_URL` | OpenAI Realtime-compatible WebSocket endpoint (realtime engine) | `wss://api.kataleptic.com/v1/realtime` |
| `REALTIME_MODEL` | Model/tier for the realtime engine | `llama-3.3-70b` |
| `REALTIME_API_KEY` | *(secret)* key for the realtime endpoint; falls back to `DEFAULT_LLM_API_KEY` | — |
| `ALLOW_INSECURE_LLM_URL` | `"true"` lets a business point its LLM at a plain-http or loopback URL; single-tenant instances only | — |

Each business can additionally override the LLM (base URL, model, API key) from **Settings → AI provider** in the dashboard. A custom base URL is only ever called with the key stored beside it — `DEFAULT_LLM_API_KEY` is never sent to an endpoint a business chose. Custom endpoints must be `https` and must not be a loopback, private, or link-local address (a literal-IP check; Workers cannot resolve DNS).

Running a model on the same machine as the Worker breaks both of those rules, so it needs an explicit opt-in:

```sh
# .dev.vars — e.g. Ollama on http://localhost:11434/v1
ALLOW_INSECURE_LLM_URL="true"
```

Set this only where every account belongs to you. On an instance with tenants it lets any of them aim the agent at your local network — with their own API key, never yours, but still from your Worker's egress.

### Real phone numbers (PSTN)

Browser calls are the built-in channel. Hooking up a real phone number means bridging your telephony provider's media stream into the same `CallSession` Durable Object — see [`docs/telephony.md`](docs/telephony.md) for the current state and integration notes for Twilio and Azure Communication Services.

## Development

```sh
npm run db:migrate:local
npm run dev:worker   # API on :8787
npm run dev          # Vite dev server on :5173 (proxies /api and /ws)
npm run typecheck
```

Create a `.dev.vars` file (gitignored) with the secrets above for local development.

## Architecture

- **`src/`** — Cloudflare Worker: [Hono](https://hono.dev) API, session auth (PBKDF2 + cookies), and `CallSession`, a Durable Object that owns one WebSocket per live call and runs the STT → LLM → TTS loop
- **`web/`** — React + Vite + Tailwind v4 dashboard and the public call widget
- **`migrations/`** — D1 (SQLite) schema: users, businesses, agent settings, calls, transcript turns

## License

[MIT](LICENSE) © Duguet Labs
