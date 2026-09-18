# ☎ OpenFon

**Open-source voice assistant for small businesses.** OpenFon answers from your business information, takes messages, and records transcripts and summaries in your Cloudflare account.

Built by **Duguet Labs**, initially for developers and agencies helping service businesses answer routine questions and capture callback requests. That audience is a pilot hypothesis, not a claim of existing customers.

The code is **free software under MIT**. Running it can cost money: Cloudflare hosting, AI and speech usage, and telephone numbers and calls if enabled. Kataleptic, the default inference service, is run by the OpenFon founder and requires a separate paid account. It is an optional service; independent provider support must be checked by capability in the [compatibility guide](docs/providers.md). Cloudflare Workers and D1 remain platform dependencies, and configured providers process conversation data.

## How it works

Callers open your agent's link (`/call/your-business`) and talk to it straight from the browser — no app, no phone number required. Each utterance flows through:

```
caller's mic ──► Cloudflare Worker (Durable Object per call)
                   │  1. speech-to-text   (compatible transcription API)
                   │  2. LLM reply        (compatible chat API)
                   │  3. text-to-speech   (Azure Speech, or free browser voices)
                   ◄── spoken reply + live captions
```

Transcripts, summaries, and messages land in your dashboard (D1/SQLite). When a call ends, the LLM writes a 1–2 sentence summary, classifies the intent (question / booking / message), and extracts any callback details the caller left.

## Launch status

The current launch branch adds a public website and a complete browser-call studio: assistants, private tests, knowledge approval, call review, and account controls. Browser calling is the implemented channel; an isolated staging HTTPS deployment has been verified. A [recorded corrective browser call](docs/launch/demo/corrected/README.md) with live Kataleptic replies and a synthetic caller passed the canonical-hours and missing-phone checks. Interruption follow-up remains inconclusive; physical-microphone and SIP/PSTN acceptance remain unverified. These are scoped results on the recorded staging version, not full voice acceptance of the current release candidate; HTTP staging probes alone do not establish audible-call success. This is public development, not a production-readiness claim. Inbound Telnyx integration is implemented behind a disabled rollout flag and still needs a real carrier pilot. Email password recovery is not available yet. Do not describe booking requests as confirmed calendar appointments.

## Features

- 🗣 **Browser voice calls** — WebSocket + voice-activity detection, live captions, text fallback for callers without a mic
- ⚡ **Two voice engines** — the default *Pipeline* (STT → LLM → TTS, works with compatible speech and language-model providers) or opt-in *Realtime* (continuous audio streaming through the configured realtime adapter: streamed replies and interruption support; latency depends on the provider and model); switchable per business in Settings
- 🧠 **Bring your own AI** — defaults to Kataleptic; custom text endpoints are configurable per business. Text, transcription, synthesis and realtime have different requirements. See [provider capabilities and verification](docs/providers.md) before choosing an alternative
- 📋 **Grounded answers** — the agent is instructed to answer from your business facts (hours, services, prices, FAQ); unknown questions become messages
- 📞 **Call log** — transcripts, summaries, intent badges, messages with caller name & phone
- 🌍 **Multi-language** — English, German, Spanish, French out of the box
- 🪶 **Tiny footprint** — one Cloudflare Worker + D1; usage-based infrastructure; AI and speech provider charges are separate

## Self-hosting

Follow the [quickstart](docs/quickstart.md) to deploy into **your own Cloudflare account**, configure a provider, and complete a private browser call before publishing a link. You need Node 22.13+, a Cloudflare account and valid provider access. Setup time and usage costs depend on your configuration; a working deployment alone does not verify voice.

For local development and contributions, see [CONTRIBUTING.md](CONTRIBUTING.md). For a supervised trial, use the [pilot guide](docs/launch/pilot.md), [evaluation template](docs/launch/pilot-evaluation.md) and [cost worksheet](docs/launch/costs.md).

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
| `STT_TIMEOUT_MS` | Total transcription deadline including compatibility retry (1000–120000 ms) | `60000` |
| `DEFAULT_TTS_PROVIDER` | `azure` or `browser` | `azure` |
| `AZURE_SPEECH_KEY` | *(secret)* Azure Speech key (only for `azure` TTS) | — |
| `AZURE_SPEECH_REGION` | Azure Speech region | `westeurope` |
| `DEFAULT_TTS_VOICE` | Azure neural voice | `en-US-AvaMultilingualNeural` |
| `REALTIME_BASE_URL` | WebSocket endpoint for the configured realtime adapter | `wss://api.kataleptic.com/v1/realtime` |
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

Browser calls remain the default supported channel. The opt-in inbound Telnyx adapter uses `TelnyxCall` for carrier lifecycle and `CallSession` for the realtime conversation. It is disabled until configured and carrier-tested. See [`docs/telephony.md`](docs/telephony.md) for operator setup and the pilot gate. Outbound dialing is not implemented. See the [channel compatibility table](docs/providers.md#telephone-channels) for other adapters and their evidence status.

## Development

```sh
npm run db:migrate:local
npm run build
npm run dev:worker -- --port 8815 --inspector-port 9255
# Open http://localhost:8815 (built UI and API together)
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e  # isolated local database and test-only credentials; no remote deployment
npm run test:telnyx # real local Worker runtime with simulated carrier/AI services
```

Create a `.dev.vars` file (gitignored) with the secrets above for local development.

## Architecture

- **`src/`** — Cloudflare Worker: [Hono](https://hono.dev) API, session auth (PBKDF2 + cookies), and `CallSession`, a Durable Object that owns one WebSocket per live call and runs the STT → LLM → TTS loop
- **`web/`** — React + Vite + Tailwind v4 dashboard and the public call widget
- **`migrations/`** — D1 (SQLite) schema: users, businesses, agent settings, calls, transcript turns

## License

[MIT](LICENSE) © Duguet Labs

## Launch operations

The release gate, remaining operator configuration, marketing strategy, and prepared announcement copy live in [`docs/launch/`](docs/launch/). Private account APIs support password changes, credential-free JSON exports, and deletion with password confirmation. A large export requires an administrator’s database export; account deletion refuses pending or active calls.

`npm run test:e2e` starts its own local Worker on port 8790 and uses a fresh temporary database for each run. It never runs remote migrations. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an already-installed compatible Chromium for local checks. Install the matching browser with `npx playwright install chromium` before running locally; CI installs its matching browser automatically and runs this suite.

For GitHub Actions deployment, set the repository variable `OPENFON_PUBLIC_URL`; the deploy job passes it into the build. For a local public-deployment build, set `OPENFON_PUBLIC_URL` to the intended HTTPS origin when building (for example, `OPENFON_PUBLIC_URL=https://your-domain.example npm run build`). The build emits the canonical URL, absolute social-image URL, and sitemap for that origin. Without it, local previews omit canonical/sitemap metadata rather than pointing at an invented domain.
