# Provider and channel compatibility

Evidence snapshot: **2026-09-12**, baseline `b730480`. This table describes inspected code and previously recorded synthetic tests, not a certification of current third-party services. New presets, direct realtime and Asterisk are being implemented on separate branches; integration must update this table against the release commit and attach test evidence before upgrading their status.

Kataleptic is the default and is operated by the OpenFon founder. It is an optional paid service with a separate account. MIT covers OpenFon’s code, not inference, hosting or telephone service. Selecting a model through Kataleptic still uses Kataleptic; it is not an independent provider route.

## AI capabilities

| Capability / recipe | Engine and channel | Configuration at baseline | Verification / limitation |
| --- | --- | --- | --- |
| Kataleptic text + transcription | Pipeline, browser | `DEFAULT_LLM_*` and `DEFAULT_STT_*`; shipped models `llama-3.3-70b` / `whisper-large-v3-turbo` | Implemented; real credential preflight recorded a catalog 403. No current live voice pass. |
| Custom chat completions endpoint | Text replies and summaries | Business text URL, model and matching key | Implemented and synthetic-tested; does not configure transcription, synthesis or realtime. No universal provider compatibility claim. |
| Custom transcription endpoint | Pipeline microphone input | Instance `DEFAULT_STT_BASE_URL`, model and key | Must implement the app’s `/audio/transcriptions` contract; verify audio formats/authentication with your service. |
| Browser speech synthesis | Pipeline browser output | `DEFAULT_TTS_PROVIDER=browser` | Implemented; voices/device behavior vary. Cannot supply telephone audio. |
| Azure speech synthesis | Pipeline output and current carrier greeting | Azure key, region and voice | Implemented; requires real audio verification with your account. |
| Kataleptic realtime gateway | Realtime browser; experimental Telnyx | Instance `REALTIME_*`, business realtime model | Implemented; synthetic transport evidence only for this release. Default model `llama-3.3-70b`. |
| Direct OpenAI realtime | Independent realtime route | Adapter/configuration work in progress | Not verified in this baseline. Do not substitute its URL into the gateway recipe and claim support. |
| Groq, Ollama, vLLM or other custom services | Capability-specific candidates | Custom endpoint only where the protocol matches | Experimental until the complete intended workflow passes. A text-only server does not supply voice. |

Source: [`src/providers.ts`](../src/providers.ts), [`src/call-session.ts`](../src/call-session.ts), [`wrangler.jsonc`](../wrangler.jsonc), and [dated readiness evidence](launch/readiness.md). The default Azure voice in configuration is `en-US-AvaMultilingualNeural`. No provider pricing or availability is asserted here.

## Incoming workspace settings contract

The presets owner finalized this contract on **2026-09-12** in the provider-presets worktree. It is implemented there and awaiting its final commit/integration; the baseline table above remains the description of this launch checkout. Apply migration `0010_provider_capabilities.sql` together with the matching provider API/UI and realtime adapter changes before following this section. Integration must record the final release commit here.

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

For a completely independent direct OpenAI conversation, configure **both** OpenAI realtime and the OpenAI text preset with their respective credentials. Summaries use text generation, independently of the realtime key. Explicit workspace realtime choices do not inherit instance credentials. Follow the realtime owner’s `docs/realtime-providers.md` recipe after its commit is integrated, including the test that removes Kataleptic credentials and blocks its endpoints.

### Saving and replacing credentials

Keys are write-only through the API; settings responses expose configured flags rather than values. A blank or omitted key preserves the saved key at the same destination. Changing the destination or protocol requires a replacement key or an explicit clear action. Do not assume that selecting a new provider safely reuses the previous provider’s key.

The existing text API uses `baseUrl`, `apiKey`, `clearApiKey`, with a new `model` field. Speech settings use `stt_provider`, `stt_base_url`, `stt_model`, `stt_api_key` and `realtime_provider`, `realtime_base_url`, `realtime_api_key`. Speech key removal accepts a null key or the corresponding `stt_clear_api_key` / `realtime_clear_api_key` flag. The operator-selected `tts_provider` is reported separately. Prefer the settings UI for normal setup.

### Evidence received from owners

Presets reports 439 full unit tests passed, plus a subsequent 48-test legacy security regression run; do not add these overlapping counts into a new total. Its actual local-workerd browser run verified settings save/reload and key retention. A mobile sizing fix is awaiting its rerun/final commit. Realtime reports a synthetic complete independent workflow; consult its final report for exact commit and runtime checks. **No live provider calls or refreshed Kataleptic catalog are established by these results.** Launch has reviewed the contract, not rerun the other owners’ suites.

## Telephone channels

| Channel | Implementation at baseline | Release evidence required |
| --- | --- | --- |
| Browser link | Implemented channel; pipeline and realtime | Real provider audio on intended HTTPS origin, permissions, interruption, hangup and saved results. |
| Telnyx inbound | Disabled opt-in adapter; realtime only | [Operator setup and carrier gate](telephony.md). Synthetic workerd tests are not handset calls. No real carrier pass recorded. |
| Asterisk / SIP gateway | Separate implementation work in progress | Adapter owner’s version/configuration recipe and real gateway/media tests, followed by a consented handset pilot. No baseline support claim. |
| Twilio, arbitrary SIP trunks, SIM/analog | No adapter in this baseline | Separate integration and validation. A telephone number or SIP credential alone cannot connect to the Worker. |
| Outbound calls, number purchasing/porting, calendar confirmation, human transfer | Not offered as launch capabilities | Do not include in onboarding or announcement promises. |

## Add a verified recipe

Record release commit, date, endpoint origin (no credentials), provider/adapter version, model, voice, language, browser/device and channel. Run a known answer, unknown question, callback capture, interruption, provider error and hangup; check transcript and summary persistence. For telephone, include the carrier failure matrix and actual handset/media evidence.

For an **independent provider** claim, remove all Kataleptic credentials and block its endpoints in the test environment. Verify the voice catalog, greeting, transcription, response, summary, errors and saved results. Note any unsupported capability explicitly. Store a sanitized report alongside the [pilot evaluation](launch/pilot-evaluation.md); a mock transport or successful dropdown selection is insufficient.
