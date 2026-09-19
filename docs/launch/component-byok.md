# Guided voice configuration and component keys

For the technology comparison, component settings and voice/language guidance, see
[Choosing a conversation engine, models and voices](../voice-configuration.md).

The assistant editor offers Kataleptic Standard (Whisper → chat → Piper), HD
(Azure Voice Live), native GPT Realtime tiers, and Custom Pipeline. Available
choices follow the workspace realtime provider. The text model used to summarize
realtime calls is separate from the realtime conversation model.

Custom Pipeline performs utterance transcription → text generation → speech
synthesis. In **Settings → Workspace AI providers**, each component has its own
provider, endpoint, model and write-only API key. These settings are shared by
assistants in that workspace. Assistant presets contain model and voice choices,
not keys. Separate keys may belong to the same vendor or to different vendors.

- Text: OpenAI-compatible `/chat/completions` (including Kataleptic, OpenAI,
  OpenRouter and compatible custom endpoints).
- Transcription: multipart `/audio/transcriptions`. Streaming `/listen` models
  use a different protocol and are excluded from suggestions. Diarization can
  increase latency; the existing bounded transcription timeout still applies.
- Speech: Azure regional Speech REST, OpenAI `/audio/speech`, compatible custom
  speech endpoints, or browser speech without a key. Custom speech must accept
  `model`, `input`, `voice`, `response_format: mp3` and return audio bytes.
  Other vendor protocols require an adapter. Kataleptic is not advertised as a
  standalone speech-synthesis provider.
- Realtime: one provider manages conversational audio. Pipeline speech keys do
  not change realtime audio or carrier admission. Custom Pipeline is currently
  for browser calls; telephone routes require realtime.

Dropdowns suggest compatible models and voice families. **Custom ID…** preserves
advanced or previously saved values, but does not prove provider availability.
The Kataleptic catalog is public, cached, bounded, and fetched without workspace
keys; built-in suggestions are labeled when it is unavailable. Browser speech
selects an installed language-matched voice on the caller's device. OpenAI speech
voices are multilingual; Piper voice IDs are language-specific.

An empty key input retains the saved key at the same provider/endpoint. Changing
an endpoint requires a replacement key. Selecting instance/browser speech clears
the workspace speech key; explicit speech providers never borrow text,
transcription, realtime or operator keys. Provider GET responses expose key
presence only. Account exports omit synthesis keys and endpoint URLs.

## Migration and rollout

Apply additive migration **0022_workspace_speech.sql before deploying this Worker**.
Existing workspaces default to `instance`, retaining the old speech selection.
Remote migration and production deployment need their separate approvals.
Take and verify the normal backup before the remote migration.

An older Worker ignores the new speech fields. Before rolling back to an older
Worker, explicitly return affected workspaces to instance speech (or pause their
pipeline calls); otherwise rollback would ignore their selected speech provider.
Keep the additive columns during Worker rollback.

Local tests exercise separate credentials, endpoint changes, output/deadline
bounds, current-schema migration, request cancellation, concurrency, exports,
and actual Chrome/Worker configuration. They do not establish paid provider,
physical microphone/speaker, language-quality or PSTN acceptance. Test the saved
provider configuration with an actual call before enabling it for callers.
