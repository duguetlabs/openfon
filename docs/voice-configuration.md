# Choosing a conversation engine, models and voices

OpenFon has two conversation architectures: **Realtime** and **Custom Pipeline**.
These are not a count of Kataleptic endpoints or models. Several Kataleptic voice
engines share the same `/v1/realtime` WebSocket endpoint; the model ID selects the
technology behind it. Text and transcription endpoints provide individual
components rather than a complete voice conversation.

The assistant editor presents named realtime tiers and a Custom Pipeline option.
Choices follow the workspace provider, so Kataleptic tiers appear when the
workspace uses Kataleptic. Selecting a GPT model through Kataleptic still uses
Kataleptic; direct OpenAI is a separate provider choice.

## Conversation choices

This table describes the integration and the provider's advertised technologies,
checked against Kataleptic's public catalog and documentation on **2026-09-19**.
Model availability, hosting commitments and voice quality must be verified for
your account. It does not rank models by measured latency or call quality.

| Assistant choice | Technology behind the conversation | What you choose in OpenFon | Components managed by the voice provider |
| --- | --- | --- | --- |
| **Standard** — `kataleptic-realtime` | Whisper speech recognition → chat model → Piper speech | Language, instructions, an automatic or explicit Piper voice; use “Standard with a chosen chat model” to select another chat model ID | Streaming recognition, synthesis and turn handling are combined by Kataleptic |
| **HD** — `kataleptic-realtime-hd` | Azure Voice Live through Kataleptic | Language, instructions and Azure neural voice | Recognition, conversation model and speech are managed by the HD backend; the workspace summary model does not replace its conversation model |
| **Native** — `gpt-realtime-2` | Native speech-to-speech model through Azure AI Foundry and Kataleptic | Model tier, language, instructions and a supported native voice | Conversation reasoning and speech generation belong to the integrated model |
| **Native** — `gpt-realtime-2.1` | Another native speech-to-speech generation through the same gateway | Model tier, language, instructions and a supported native voice | Same integration boundaries as Native 2; a newer ID is not a guarantee of better behavior for your calls |
| **Native Mini** — `gpt-realtime-2.1-mini` | Native Mini speech-to-speech tier through the same gateway | Model tier, language, instructions and a supported native voice | Same integration boundaries; compare cost and behavior using your own calls |
| **Custom Pipeline** | Separate utterance transcription → text generation → speech synthesis | Independent providers, endpoints, models and keys in Settings; assistant language, text-model override and speech voice | Each selected service handles one component; OpenFon coordinates the conversation |
| **Direct OpenAI / custom realtime** | Direct OpenAI GA realtime protocol, or a compatible custom service | Workspace realtime endpoint/key; assistant model and voice | One realtime provider supplies conversational audio. An arbitrary voice WebSocket API is not automatically compatible |

Kataleptic describes Standard as self-hosted in the EU, HD as Azure Voice Live in
Sweden Central, and its native tiers as globally routed rather than EU-pinned.
Those are provider descriptions, not an OpenFon data-residency guarantee. Native
transcripts may approximate the spoken audio; recognition-based transcripts can
also be wrong. A transcript alone is not an exact record of what a caller heard.

## The components and their settings

| Component | Its job | Configuration | When it is used |
| --- | --- | --- | --- |
| **Transcription / STT** | Convert the caller's recorded speech into text | Workspace transcription provider, base URL, model and separate key | Custom Pipeline microphone input; realtime uses its own recognition path |
| **Language model / LLM** | Produce replies from instructions, caller text and knowledge | Workspace text provider, base URL, model and key; optional assistant model override | Pipeline conversational replies |
| **Speech synthesis / TTS** | Convert a reply into audible speech | Workspace speech provider, endpoint, model where applicable and separate key; assistant voice | Pipeline output; browser speech is a keyless alternative |
| **Realtime conversation model** | Conduct a streaming voice conversation | Workspace realtime provider, WebSocket endpoint and key; assistant realtime model and voice | Realtime calls, including the named Kataleptic tiers |
| **Summary model** | Produce the saved post-call summary | Settings → Call summaries: workspace text provider or separate provider, model and key | Shared across assistants and engines; independent of voice profiles after leaving compatibility mode |
| **Language, personality and instructions** | Set the opening language, role and business behavior | Assistant editor, plus attached knowledge | Both architectures; these settings cannot turn an unsupported model or voice into a supported one |

### Call summaries are workspace settings

Use **Settings → Call summaries** to choose the post-call model. It is separate
from voice settings and works after both Pipeline and Realtime calls:

- **Workspace text provider:** use the saved text endpoint/key, with a dedicated
  summary model or the workspace text-model default. Assistant model overrides
  do not apply. Changing the Pipeline reply model does not change a dedicated
  summary model.
- **Separate provider:** choose Kataleptic, OpenAI, OpenRouter or a custom
  OpenAI-compatible endpoint and supply its own key and model. Even a matching
  instance endpoint requires a separate key in this mode. To remove that key,
  switch to Workspace text provider and save.
- **Keep existing behavior (compatibility):** the initial setting preserves
  existing assistant-specific text-model routing for summaries. Select either
  option above to decouple it. Existing voice profiles and presets are not
  rewritten; there is no new per-assistant summary override.

The summary configuration is read when the call is finalized, including after
session recovery. Changing it can affect a call already in progress. Pipeline's
**Language model** remains in the voice editor for conversational replies;
Realtime has no summary-model field in its voice settings. The search input
above a long model dropdown only filters that dropdown's suggestions.

### Custom Pipeline and independent BYOK

In **Settings → Workspace AI providers**, configure each component independently:

1. **Text generation:** choose a compatible chat provider, model and key.
2. **Speech recognition:** choose an utterance transcription provider, model and key.
3. **Speech synthesis:** choose Azure Speech, OpenAI speech, a compatible custom
   speech endpoint, or browser speech. Azure requires the regional endpoint of
   your own Speech resource. OpenAI/custom speech also needs a model ID.
4. Save, then choose **Custom Pipeline** and a voice in the assistant editor.

You may mix vendors, or explicitly enter the same vendor's key in more than one
component when that key authorizes those services. OpenFon does not automatically
copy a text key into transcription or synthesis. Settings are shared by the
workspace; assistant presets contain behavior, model and voice choices, not keys.
An explicit provider requires its own key. **Instance default** intentionally uses
the operator's configured service instead.

Saved keys are write-only: an empty key input keeps the saved key at the same
provider and endpoint. Changing the destination requires a replacement key. To
remove a saved synthesis key, select **Instance default** or **Browser speech**
and save. No key is needed for speech generated by the caller's browser.

| Pipeline component | Protocol expected by OpenFon | Important boundary |
| --- | --- | --- |
| Text | OpenAI-compatible `POST /chat/completions` | A text provider does not automatically supply recognition or speech |
| Transcription | Multipart `POST /audio/transcriptions`, returning text | Streaming `/listen` models require a different adapter and are excluded from these suggestions |
| OpenAI/custom speech | `POST /audio/speech` with `model`, `input`, `voice` and MP3 output | Other speech APIs need their own adapter; Kataleptic is not offered as a standalone TTS endpoint here |
| Azure Speech | Regional Speech REST endpoint with its subscription key and an Azure voice | Use the region of the resource that issued the key |
| Browser speech | The browser's installed voices | Availability and quality vary by caller device; no telephone audio is supplied |

Pipeline calls currently use the browser channel. Telephone adapters require
realtime and their own rollout/acceptance checks. Pipeline BYOK does not swap out
the internal STT or TTS of HD/native realtime models.

## Voice, language and timing

**Voice IDs belong to a voice family.** Standard uses language-specific Piper IDs
such as `de_DE-thorsten-medium`. HD accepts Azure neural names such as
`de-DE-SeraphinaMultilingualNeural`. Native tiers use names such as `marin` or
`cedar`. Standalone speech models have their own supported voice lists; do not
assume a voice supported by one speech model works with another. Leaving a voice
blank uses OpenFon's automatic/default selection for that provider. Browser speech
chooses an installed voice matching the reply language.

Dropdowns are suggestions, not proof that your account can access a model.
**Custom ID…** lets you enter other supported IDs and preserves saved IDs absent
from the catalog. Kataleptic discovery uses public model and voice catalogs;
when discovery fails, the UI retains the provider settings and labels built-in
suggestions. New voices and models can be tried without replacing existing IDs.

**Diarization identifies speakers; it is not speaking speed.** It may take longer
than plain transcription. OpenFon currently consumes the returned text without
exposing speaker labels. Pipeline transcription has a model-independent
60-second total deadline, configurable by the operator with `STT_TIMEOUT_MS`
from 1 to 120 seconds. A larger budget allows more processing time; it does not
make recognition faster. Pipeline server speech has a bounded 30-second request
budget. Hanging up cancels pending pipeline transcription/speech requests.

Realtime turn detection, interruption and audio delivery are handled by OpenFon
and the selected adapter. The assistant form does not expose every low-level
parameter advertised by a provider, such as VAD thresholds, codec selection or
token limits. These are different from the user's language, model and voice
choices. See [audio and transcription limits](providers.md#audio-generation-and-transcription-limits).

For a first comparison, keep the language, instructions and knowledge constant,
then change one engine or component at a time. Check greeting pronunciation,
response completion, interruptions, goodbye playback and the saved transcript.
The text connection check verifies saved text access only; it does not test voice.

## References and deployment

- [Kataleptic realtime documentation](https://kataleptic.com/docs/realtime/)
- [Public model catalog](https://api.kataleptic.com/v1/models)
- [Realtime voice catalog](https://api.kataleptic.com/v1/realtime/voices)
- [Provider/channel compatibility](providers.md) and [direct realtime setup](realtime-providers.md)
- [Component BYOK migration and rollback](launch/component-byok.md): migration
  **0022** must precede the Worker that reads workspace speech settings;
  **0023** is required for independent call-summary settings.
