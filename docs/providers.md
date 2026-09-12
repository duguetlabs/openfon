# Provider and channel compatibility

Evidence snapshot: **2026-09-12**, consolidated provider implementation at `71c2d14` with integration validation recorded in [release readiness](launch/readiness.md). Provider presets, direct realtime and Asterisk are implemented together. The assembled unit/API and local-workerd tests use synthetic upstreams; they do not certify current third-party service access or live telephone operation.

Kataleptic is the default and is operated by the OpenFon founder. It is an optional paid service with a separate account. MIT covers OpenFon’s code, not inference, hosting or telephone service. Selecting a model through Kataleptic still uses Kataleptic; it is not an independent provider route.

## AI capabilities

| Capability / recipe | Engine and channel | Configuration | Verification / limitation |
| --- | --- | --- | --- |
| Kataleptic text + transcription | Pipeline, browser | `DEFAULT_LLM_*` and `DEFAULT_STT_*`; shipped models `llama-3.3-70b` / `whisper-large-v3-turbo` | Real llama-3.3-70b text preflight and call summary passed; pipeline transcription remains unverified. Earlier catalog 403 did not establish endpoint access. |
| Custom chat completions endpoint | Text replies and summaries | Business text URL, model and matching key | Implemented and synthetic-tested; does not configure transcription, synthesis or realtime. No universal provider compatibility claim. |
| Custom transcription endpoint | Pipeline microphone input | Workspace STT URL/model/key or instance defaults | Must implement the app’s `/audio/transcriptions` contract; verify audio formats/authentication with your service. |
| Browser speech synthesis | Pipeline browser output | `DEFAULT_TTS_PROVIDER=browser` | Implemented; voices/device behavior vary. Cannot supply telephone audio. |
| Azure speech synthesis | Pipeline output and current carrier greeting | Azure key, region and voice | Implemented; requires real audio verification with your account. |
| Kataleptic realtime gateway | Realtime browser; experimental Telnyx | Instance `REALTIME_*`, business realtime model | Real browser audio captured using `gpt-realtime-2` and provider-default voice; known fixture/contact failures retained. Default model remains `llama-3.3-70b`; override it for this recipe. |
| Direct OpenAI realtime | Independent realtime; browser and experimental telephone | Workspace provider, own realtime key, assistant model/voice; separate text key for summaries | Implemented; direct Authorization upgrade, native greeting, interruption, tools and persistence pass synthetic workerd tests without Kataleptic credentials. Live OpenAI access remains unverified. |
| Groq, Ollama, vLLM or other custom services | Capability-specific candidates | Custom endpoint only where the protocol matches | Experimental until the complete intended workflow passes. A text-only server does not supply voice. |

Source: [`src/providers.ts`](../src/providers.ts), [`src/call-session.ts`](../src/call-session.ts), [`wrangler.jsonc`](../wrangler.jsonc), and [dated readiness evidence](launch/readiness.md). The default Azure voice in configuration is `en-US-AvaMultilingualNeural`. No provider pricing or availability is asserted here.

## Workspace settings contract

Apply migration `0010_provider_capabilities.sql` with the matching API/UI and realtime adapter changes. The integration branch includes presets `ce62114`, realtime `18d3638`/`13f037b`, and the Asterisk `0011` migration. Use the [direct realtime setup recipe](realtime-providers.md) for authentication, model/voice selection and validation.

### Text presets

| Choice | Base URL | Suggested model in the preset |
| --- | --- | --- |
| Kataleptic | `https://api.kataleptic.com/v1` | `llama-3.3-70b` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4.1-mini` |
| Hugging Face | `https://router.huggingface.co/v1` | `openai/gpt-oss-120b` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1-mini` |
| Custom | Your compatible chat endpoint | Your account’s model ID |

These are configuration presets, **not successful live-provider tests** or availability guarantees. Check access with the selected account. The workspace text model applies only when the assistant has no text-model override; inspect an existing assistant’s override after changing providers. Selecting a text preset does not change transcription or realtime settings.

The presets owner checked official [OpenRouter setup](https://openrouter.ai/docs/quickstart), [Hugging Face chat completion](https://huggingface.co/docs/inference-providers/en/tasks/chat-completion) and [OpenAI GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) documentation on 2026-09-12. OpenRouter uses namespaced model IDs; Hugging Face uses repository IDs with an optional provider suffix and requires an Inference Providers-capable token. The Kataleptic catalog could not be refreshed; its existing defaults were preserved.

### Speech and realtime choices

- **Pipeline transcription:** instance default, direct OpenAI (`https://api.openai.com/v1`, `whisper-1`) with its own key, or a custom `/audio/transcriptions` endpoint with its own URL/key/model.
- **Pipeline synthesis:** remains operator-selected browser or Azure. OpenRouter/Hugging Face text presets do not establish speech support. Browser synthesis cannot provide telephone audio.
- **Realtime:** instance default, explicit Kataleptic, direct OpenAI, or custom. Direct OpenAI pins `wss://api.openai.com/v1/realtime` and requires its own key. Custom requires its own public secure WebSocket URL/key and uses an experimental OpenAI GA protocol adapter; arbitrary realtime APIs are not interchangeable.
- **Assistant realtime model and voice:** remain assistant settings. Switching to OpenAI clears known gateway presets, while arbitrary custom overrides are preserved. Check those overrides manually. The direct adapter uses `gpt-realtime` when the realtime model is blank and native provider audio for its greeting; Azure and pipeline STT are not needed for that direct call.

For a completely independent direct OpenAI conversation, configure **both** OpenAI realtime and the OpenAI text preset with their respective credentials. Summaries use text generation, independently of the realtime key. Explicit workspace realtime choices do not inherit instance credentials. Follow the [realtime recipe](realtime-providers.md), including the test that removes Kataleptic credentials and blocks its endpoints.

### Saving and replacing credentials

Keys are write-only through the API; settings responses expose configured flags rather than values. A blank or omitted key preserves the saved key at the same destination. Changing the destination or protocol requires a replacement key or an explicit clear action. Do not assume that selecting a new provider safely reuses the previous provider’s key.

The existing text API uses `baseUrl`, `apiKey`, `clearApiKey`, with a new `model` field. Speech settings use `stt_provider`, `stt_base_url`, `stt_model`, `stt_api_key` and `realtime_provider`, `realtime_base_url`, `realtime_api_key`. Speech key removal accepts a null key or the corresponding `stt_clear_api_key` / `realtime_clear_api_key` flag. The operator-selected `tts_provider` is reported separately. Prefer the settings UI for normal setup.

### Consolidated evidence

Integration passed TypeScript and **585/585 unit/API tests** across 26 files. Actual local-workerd smoke tests passed Telnyx native and synthesized greeting paths, Asterisk protocol/media handling, direct OpenAI GA protocol and the existing gateway. The direct synthetic call uses no instance AI or Azure credentials and blocks unmatched outbound hosts. Final browser/benchmark results are recorded in [readiness](launch/readiness.md).

A separate [actual Kataleptic browser recording](launch/demo/audible/README.md) contains a completed 58-second call with ten turns and persisted summary/message. The caller was synthetic; replies were real. Conflicting Saturday fixture data and literal null contact display prevented clean acceptance. Phone normalization was subsequently fixed and independently QA-checked without another live call; the original recording remains unchanged. A separately authorized [corrective call](launch/demo/corrected/README.md) on `526be52` passed the canonical-hours and missing-phone checks with persisted summary/message. Its interruption follow-up remains inconclusive due capture timing; no full barge-in acceptance is claimed. Direct OpenAI and PSTN remain unverified. Real Asterisk 22.11.0 Local-channel/audio verification passed against the integrated adapter with mocked AI; see the [dated runtime report](asterisk-runtime-validation-2026-09-12.md). SIP trunk/PSTN and live-provider acceptance still need the [gateway recipe and pilot](asterisk.md).


## Telephone channels

| Channel | Implementation | Release evidence required |
| --- | --- | --- |
| Browser link | Implemented channel; pipeline and realtime | Real provider audio on intended HTTPS origin, permissions, interruption, hangup and saved results. |
| Telnyx inbound | Disabled opt-in adapter; realtime only | [Operator setup and carrier gate](telephony.md). Synthetic workerd tests are not handset calls. No real carrier pass recorded. |
| Asterisk / SIP gateway | Disabled opt-in authenticated chan_websocket adapter; realtime only | [Asterisk setup](asterisk.md). Synthetic workerd and real Asterisk 22.11.0 Local-channel/audio tests pass; live-provider and consented handset pilot remain required. |
| Twilio, arbitrary SIP trunks, SIM/analog | No adapter implemented | Separate integration and validation. A telephone number or SIP credential alone cannot connect to the Worker. |
| Outbound calls, number purchasing/porting, calendar confirmation, human transfer | Not offered as launch capabilities | Do not include in onboarding or announcement promises. |

## Add a verified recipe

Record release commit, date, endpoint origin (no credentials), provider/adapter version, model, voice, language, browser/device and channel. Run a known answer, unknown question, callback capture, interruption, provider error and hangup; check transcript and summary persistence. For telephone, include the carrier failure matrix and actual handset/media evidence.

For an **independent provider** claim, remove all Kataleptic credentials and block its endpoints in the test environment. Verify the voice catalog, greeting, transcription, response, summary, errors and saved results. Note any unsupported capability explicitly. Store a sanitized report alongside the [pilot evaluation](launch/pilot-evaluation.md); a mock transport or successful dropdown selection is insufficient.
