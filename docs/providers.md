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
