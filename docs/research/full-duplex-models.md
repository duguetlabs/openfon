# Full-Duplex Conversational Speech Models — State of the Art (June 2026)

Research for OpenFon: can a full-duplex speech model replace the Whisper → LLM → Azure TTS pipeline?

*Compiled 2026-06-10. Sources at bottom. Claims marked **[unverified]** could not be confirmed against a primary source.*

---

## 1. Executive Summary

**Verdict: PARTIALLY — but not with an open-weights duplex model, because of OpenFon's multilingual hard requirement.**

- **The NVIDIA model exists and is real: PersonaPlex-7B-v1** (released ~Jan 15, 2026, open weights, built on Kyutai's Moshi). It is genuinely full-duplex (~170–240 ms turn latency, natural barge-in) and supports system-prompt-style text grounding — architecturally a near-perfect fit for OpenFon's "voice engine" abstraction. **However, it is ENGLISH-ONLY (input and output).** This single fact disqualifies it as a pipeline replacement for OpenFon today, since 9 of the 10 target languages are unsupported.
- **The "significantly improved May 2026 update" could not be verified.** PersonaPlex's GitHub repo and HF weights show no changes after March 2, 2026 (README-only commits), and no v1.5/v2 exists. The user is most likely remembering one of: (a) **NVIDIA Nemotron 3 VoiceChat** — a *different*, newer NVIDIA full-duplex 12B model released into Early Access March 14, 2026, with a much stronger LLM backbone (Nemotron Nano V2 9B vs. Moshi's Helium); or (b) OpenAI's **gpt-realtime-2** wave of voice models (May 2026). Nemotron 3 VoiceChat is gated Early Access (not freely downloadable), and its language support is undisclosed — almost certainly English-focused **[unverified]**.
- **Every serious open-weights full-duplex model is English-only or EN+FR/EN+ZH** (PersonaPlex, Moshi, Nemotron 3 VoiceChat, FLM-Audio, Freeze-Omni). The only models covering all 10 OpenFon target languages (EN, DE, FR, ES, NL, SV, DA, IT, FI, RU) are **hosted APIs**: OpenAI gpt-realtime, Google Gemini Live, and Azure Voice Live (in cascaded mode). Qwen3-Omni (Apache-2.0, open) covers 6/10 for speech output but is not true full-duplex.
- **Recommended path:** add a `realtime` voice-engine provider to OpenFon that speaks the OpenAI Realtime WebSocket protocol (OpenAI directly; Azure Voice Live is wire-compatible and reuses your existing Azure relationship + Azure TTS voices). This gets latency from ~2–4 s to ~0.5–0.8 s with barge-in, full multilingual coverage, system-prompt grounding, transcripts in the event stream, and zero GPU hosting. Keep the existing pipeline as the budget/self-host option. Revisit open-weights duplex (PersonaPlex/Nemotron VoiceChat successors, Kyutai's announced multilingual models) in 6–12 months — possibly as an **English-only opt-in engine** sooner if demand exists.

---

## 2. The NVIDIA Model: PersonaPlex-7B-v1

> ⚠️ **ENGLISH-ONLY. This is the headline finding.** The HF model card states English-only for both speech input and output; training data is the Fisher *English* corpus plus English synthetic dialogues. No multilingual variant exists or has been announced.

| Attribute | Detail |
|---|---|
| Exact name | `nvidia/personaplex-7b-v1` (only version; no v1.5/v2 as of 2026-06-10) |
| Released | Weights created on HF 2025-12-31; public release/announcement Jan 14–20, 2026 |
| Architecture | Built on **Kyutai Moshi** (base model: `kyutai/moshiko-pytorch-bf16`): Mimi streaming audio codec (ConvNet + transformer), Temporal + Depth transformers, **Helium 7B** LM backbone. Dual-stream full duplex: user audio stream encoded continuously while the model generates its own audio + text stream simultaneously |
| Size | 7 B params, BF16 (~16 GB weights, single `model.safetensors`) |
| License | Code: MIT. **Weights: NVIDIA Open Model License** (commercially usable, with NVIDIA's terms) + CC-BY-4.0 attribution terms inherited from the Moshi base. Gated download (accept license + HF auth) |
| Languages | **English only** (input and output) |
| Grounding | Dual conditioning, set **once at session start**: (1) **text prompt** — role, background, scenario context, i.e. exactly OpenFon's injected-business-facts pattern; (2) **voice prompt** — short audio clip setting voice + speaking style. NVIDIA demos include banking support agent, medical receptionist, customer service personas |
| Latency | FullDuplexBench: 0.170 s smooth turn-taking, 0.240 s interruption handling, ~0.205 s average. (Blog claims of "70 ms speaker switch, 18× faster than Gemini Live" come from a third-party blog — treat as marketing-adjacent **[unverified]**) |
| Barge-in | Native: interruptions, overlaps, backchannels ("uh-huh"), rapid turn-switching — it's always listening while speaking by construction |
| GPU | Tested on **A100 80 GB / H100**; community-added `--cpu-offload` flag for smaller GPUs; CPU-only works for offline eval only. BF16 7B + Mimi should fit a 24 GB card (L4/A10G/L40S) but NVIDIA only lists A100/H100 — **[unverified on smaller GPUs]** |
| Serving | PyTorch via the `moshi` library: `python -m moshi.server --ssl` → **WebSocket web server on :8998** with a browser client. Docker container contributed. **No NIM / build.nvidia.com hosted endpoint exists** (checked). No vLLM/TensorRT-LLM support |
| Transcripts | Moshi-architecture models emit an "inner monologue" **text stream alongside audio** — so per-utterance agent transcripts are available; user-side transcripts are not a first-class output (you'd run a parallel STT or use the model's text stream heuristically) |
| Benchmarks | 91.0% Conversational Dynamics (FullDuplexBench) — best open-weights duplex score, per Artificial Analysis. Speech *reasoning* is weak (Helium backbone): the persona adheres to prompts but is a 7B-class, 2024-era LLM — expect factual-adherence risk when answering from injected business facts |
| Traction | 321 k HF downloads in ~5 months; active community (Discord, third-party tutorials: DataCamp, the-decoder coverage) |

### The "May 2026 update" — what we found

- `NVIDIA/personaplex` GitHub: last commit **2026-03-02** (README update). No releases published.
- HF `nvidia/personaplex-7b-v1`: `lastModified` **2026-03-02**. No other `personaplex*` or `*duplex*` models under the `nvidia` HF org.
- Multiple targeted searches for "PersonaPlex v2 / v1.5 / May 2026 update" returned nothing.

**Conclusion: no PersonaPlex update in May 2026.** The most plausible source of the memory:

**NVIDIA Nemotron 3 VoiceChat** (released to Early Access **March 14, 2026**) — NVIDIA's *second* full-duplex speech-to-speech model and arguably the "significantly improved" successor:
- 12 B end-to-end full-duplex model: FastConformer audio encoder → **Nemotron Nano V2 9B** LLM backbone → streaming TTS decoder. Much stronger reasoning than PersonaPlex's Helium (this is the improvement axis).
- Scores 77.8% Conversational Dynamics (below PersonaPlex's 91.0%) but far better speech reasoning; Artificial Analysis calls it the open-weights speech-Pareto leader.
- "Open, inspectable weights for enterprise deployment" — but **gated behind an Early Access application** (developer.nvidia.com/nemotron-voicechat-early-access); not on public HF; ships with reference deployment containers, benchmarks, and a guided fine-tuning path.
- **Languages: undisclosed.** Nothing in the model card, EA page, or coverage mentions multilingual support; given the lineage, assume English-first **[unverified]**.
- Sub-second latency claimed on NVIDIA GPUs; exact figures not published.

Either way, **neither NVIDIA duplex model is usable for OpenFon's 10-language requirement today.**

---

## 3. Comparison Table — All Serious Candidates (June 2026)

Target languages = EN, DE, FR, ES, NL, SV, DA, IT, FI, RU. "Duplex" = listens while speaking (true simultaneity), vs. "VAD barge-in" = half-duplex with fast interruption.

| Model | Type / Duplex | License | Target-language coverage | Grounding | GPU / hosting | Cost (1 concurrent call) | Latency | Maturity |
|---|---|---|---|---|---|---|---|---|
| **NVIDIA PersonaPlex-7B-v1** | Open weights, **true duplex** | MIT code / NVIDIA Open Model License weights | **1/10 — ENGLISH ONLY** | ✅ Text persona prompt + voice prompt at session start | A100 80 GB/H100 tested (24 GB likely feasible, unverified); self-host only, WebSocket server included | ~$430–1,800/mo self-hosted (see §5) | ~0.17–0.24 s | Research-grade; active community; no managed API |
| **NVIDIA Nemotron 3 VoiceChat (12B)** | Gated EA weights, **true duplex** | "Open, inspectable weights," terms TBD | **Undisclosed; presume EN [unverified]** | Presumed system-prompt (Nemotron backbone) [unverified] | NVIDIA GPUs; reference containers in EA | n/a (EA) | "Sub-second" | Early Access since 2026-03-14; not GA |
| **Kyutai Moshi(ko/ka)** | Open weights, **true duplex** (the original) | Code MIT/Apache; weights CC-BY-4.0 | **1/10 — EN only** (multilingual "planned" by Kyutai, nothing released) | Weak — limited text conditioning; persona drift | 24 GB PyTorch; 16 GB bf16; ~10 GB quantized (Rust/MLX) | ~$200–1,400/mo self-hosted | ~0.2 s | Pioneer (2024); weak LLM; superseded by PersonaPlex for quality |
| **Kyutai Unmute** | Open source, cascaded STT→LLM→TTS, semantic-VAD barge-in | Open (Apache-style), all components open | **2/10 — EN+FR** (STT `stt-1b-en_fr`, TTS EN/FR) | ✅ Any text LLM you want (vLLM/OpenRouter) → full system prompt | 1 GPU for STT+TTS + LLM host; Rust server, **OpenAI-Realtime-compatible WebSocket** | ~$200–1,400/mo | <1 s | Solid engineering; language coverage kills it for OpenFon |
| **Qwen3-Omni-30B-A3B** (Sep 2025) | Open weights, streaming turn-based (natural turn-taking, **not true duplex**) | **Apache 2.0** | **6/10 speech-out** (EN, DE, FR, ES, IT, RU; ✗ NL/SV/DA/FI — NL is input-only) | ✅ Full system prompt (it's an LLM) | ~80 GB-class VRAM for BF16 MoE (30B-A3B); vLLM support | ~$1,800+/mo self-hosted, or DashScope API | <1 s claimed to first audio | Production-grade weights; best open multilingual option |
| **Qwen3.5-Omni** (Mar 30, 2026) | Light tier open weights; Plus/Flash API-only; "semantic interruption" (smart barge-in, not true duplex) | Light: open (Apache 2.0 presumed **[unverified]**) | Claims **36 speech-out languages**, 113 ASR — specific list not published; 10/10 plausible but **[unverified]** | ✅ Full system prompt + tool use + web search | Light self-hostable; Plus/Flash via DashScope | API pricing varies; Light similar to Qwen3-Omni | Real-time streaming | New (2 months); technical report on arXiv; verify language list before relying on it |
| **OpenAI gpt-realtime / gpt-realtime-2** | Hosted API, VAD barge-in (half-duplex, fast) | Proprietary | **10/10 ✅** — official supported list includes all of DA, NL, FI, SV, DE, FR, ES, IT, RU, EN; mid-sentence language switching | ✅ Session `instructions` (system prompt), tool calling | None — hosted; WebSocket / WebRTC / **SIP** | $32/1M audio-in + $64/1M audio-out tokens ≈ **$0.10–0.30/min** (estimate); mini tier much cheaper | ~0.3–0.8 s typical | **Production GA**; the de-facto standard; gpt-realtime-2 (May 2026) adds GPT-5-class reasoning at same price |
| **Google Gemini Live (gemini-live-2.5-flash-native-audio)** | Hosted API, VAD barge-in; native audio | Proprietary | **10/10 ✅** (97-language understanding; all 10 targets in supported list; restrict via system instructions) | ✅ System instructions | None — hosted; WebSocket | ~25 tokens/s of audio ≈ **~$0.04/min** effective (estimate; sources disagree on totals) | Sub-second; "minimal thinking" default | GA on Vertex per recent coverage, but some docs still carry pre-GA terms + 15-min audio session limit (extendable) — verify before committing |
| **Amazon Nova 2 Sonic** (Dec 2025) | Hosted (Bedrock), speech-to-speech, barge-in | Proprietary | **5/10** — EN, DE, FR, ES, IT (+PT, HI); ✗ NL/SV/DA/FI/RU | ✅ System prompt, async tool use, 1M context | None — hosted; HTTP/2 bidirectional streaming (not WebSocket) | Bedrock per-token; competitive | Sub-second | GA; polyglot voices; good but coverage gap |
| **Azure Voice Live API** | Hosted; **hybrid**: gpt-realtime / phi4-mm-realtime / cascaded Azure STT+LLM+Azure TTS behind one Realtime-style WebSocket | Proprietary | **10/10 ✅ in cascaded mode** (Azure STT/TTS cover all 10; `mai-transcribe-1.5` explicitly lists all 10) | ✅ System prompt; choice of chat model | None — hosted | Azure per-minute/per-token pricing (not gathered — verify) | Sub-second with server VAD | GA-track on Azure AI Foundry; **natural fit: OpenFon already uses Azure TTS — same voices, one WebSocket** |
| **Ultravox (fixie-ai)** | Open weights speech-**in** LLM (no native speech out) + managed realtime platform; not duplex | Open weights (Llama-derived) | 42 input languages (all 10 likely); output = your TTS → 10/10 with Azure TTS | ✅ Full system prompt | A100-40 for ~150 ms TTFT; or managed ultravox.ai | Self-host ~$1,500/mo or managed per-minute | ~150 ms TTFT + TTS | Mature niche; an *upgrade* to the pipeline, not a duplex replacement |
| FLM-Audio / Freeze-Omni (honorable mentions) | Open research duplex models | Open | EN+ZH | Limited | 1 GPU | varies | <1 s | Research-grade; FullDuplexBench 62.0/58.7 — below PersonaPlex |

---

## 4. Multilingual Reality Check (the deciding factor)

**Hard finding: as of June 2026 there is NO open-weights true-full-duplex model that speaks German, Dutch, Swedish, Danish, Finnish, or Russian.** The entire open duplex lineage (Moshi → PersonaPlex → Nemotron VoiceChat → FLM-Audio) is English (or EN+ZH/EN+FR) because the conversational training corpora (Fisher, synthetic English dialogues) are English.

- PersonaPlex: **1/10** languages. ❌
- Nemotron 3 VoiceChat: undisclosed, presume ~1/10. ❌
- Moshi/Unmute: 1–2/10. ❌
- Qwen3-Omni: 6/10 speech-out (misses NL, SV, DA, FI) — and it's not true duplex. ❌ for full coverage
- Qwen3.5-Omni: possibly 10/10 (claims 36 speech-out languages) but the list is unpublished and only the smallest tier is open — **worth a hands-on test**, the one open-weights wildcard.
- Hosted APIs (OpenAI Realtime, Gemini Live, Azure Voice Live cascaded): **10/10**. ✅ Note: for the smaller languages (DA, FI, SV, NL), gpt-realtime quality is "supported above 50% WER threshold" — i.e., officially supported but accent/quality will trail EN/DE/FR/ES; Azure Voice Live's cascaded mode with native Azure neural voices will sound better in those languages.

Kyutai has publicly stated multilingual models are planned; nothing released yet **[announced, not released]**.

---

## 5. Hosting Economics (self-hosted duplex, 1 concurrent call)

Reference prices (June 2026): Modal L40S $0.000542/s ≈ **$1.95/hr**, A100-40GB ≈ $2.10/hr, A100-80GB ≈ $2.50/hr **[approx]**; Baseten H100 $6.50/hr (per-minute billing, scale-to-zero); Replicate bills setup+idle on private models (worst fit); Azure NC-series A100 VM ≈ $2,200+/mo always-on.

| Strategy (PersonaPlex on Modal L40S/A100-80) | Monthly cost | Catch |
|---|---|---|
| Always-on | L40S ~$1,400 / A100-80 ~$1,800 | Prohibitive for a small business |
| Business hours only (220 h/mo) | ~$430–550 | Calls outside hours fall back to pipeline |
| Scale-to-zero, wake per call | Usage only: 1,000 call-min/mo ≈ **$33–45** | **Cold start 30–90 s loading 16 GB of weights — a phone caller will hang up.** Modal memory snapshots can cut this to a few seconds, but that's engineering work and still risky for telephony |
| Scale-to-zero + keep-warm window (e.g., 10-min scaledown) | ~$50–250 depending on call clustering | First call of any quiet period still eats a cold start |

Compare hosted: a small business doing 1,000 call-minutes/mo pays ≈ **$40–150/mo on Gemini Live or gpt-realtime-mini, with zero idle cost and zero ops.** Hosted realtime APIs dominate self-hosted duplex on cost at small-business scale; self-hosting only wins above roughly 10–20 k call-minutes/mo or for data-residency reasons.

---

## 6. Recommended Path for OpenFon

### Now (Q3 2026): add a `realtime` voice-engine provider (hosted), keep the pipeline

The Durable Object already relays a WebSocket audio stream both ways — it can bridge to a Realtime API instead of orchestrating STT→LLM→TTS:

```
Browser/phone ──ws──> Durable Object ──wss──> Realtime API (OpenAI / Azure Voice Live)
   PCM/Opus frames        bridge + state         session.instructions = business facts
```

Integration sketch (OpenAI Realtime protocol; Azure Voice Live is wire-compatible):

1. **Provider interface.** Factor the current pipeline behind `VoiceEngine { start(session), pushAudio(frame), onAudioOut, onTranscript, onToolCall, end() }`. Implement `PipelineEngine` (existing) and `RealtimeEngine`.
2. **Session start.** DO opens `wss://api.openai.com/v1/realtime?model=gpt-realtime-mini` (or Azure endpoint), sends `session.update` with `instructions` = the same injected business-facts system prompt, `voice`, `input_audio_format: pcm16` (24 kHz), `turn_detection: { type: "semantic_vad" }`, and tool definitions if OpenFon adds booking/actions later.
3. **Audio in.** Switch the browser client from per-utterance upload to **continuous streaming** (small PCM16 chunks); DO forwards as `input_audio_buffer.append`. This is the main client-side change.
4. **Audio out + barge-in.** Relay `response.output_audio.delta` frames to the caller. On `input_audio_buffer.speech_started`, send a "flush playback" control message to the client and `response.cancel` upstream — that's barge-in, which the current pipeline can't do at all.
5. **Transcripts.** Per-utterance transcripts (currently a Whisper byproduct) come from the event stream instead: `conversation.item.input_audio_transcription.completed` (caller) and `response.output_audio_transcript.done` (agent). Persist exactly as today.
6. **Fallback.** Engine selection per tenant; on Realtime connection failure, fall back to `PipelineEngine`.

**Expected gains:** ~2–4 s → ~0.5–0.8 s perceived response latency; real barge-in; mid-call language switching. **Losses/risks:** per-minute cost is usage-priced and less predictable; less control over each stage (can't swap the LLM independently); voice quality in DA/FI/SV/NL on gpt-realtime trails Azure neural voices — **mitigation: Azure Voice Live cascaded mode keeps OpenFon's exact Azure TTS voices while still cutting latency and adding server-side VAD/barge-in.** Evaluate both; Azure is the lower-risk first target given the existing dependency.

### Later (re-check ~Q4 2026 / Q1 2027): open-weights duplex

- Watch for: Kyutai multilingual models (announced), a multilingual PersonaPlex successor, Nemotron 3 VoiceChat GA + language disclosure, Qwen3.5-Omni speech-output language list verification.
- If/when a multilingual open duplex model lands, the `VoiceEngine` interface makes it a third provider: PersonaPlex-style models already serve a WebSocket (`moshi.server`), so a Modal/Baseten wrapper with keep-warm is a contained project (~$50–500/mo depending on traffic pattern).
- Optional near-term experiment: ship **PersonaPlex as an English-only opt-in engine** for self-hosters with their own GPU — it's the best-in-class conversational feel (91% FullDuplexBench) and its text-persona prompt maps 1:1 to OpenFon's business-facts injection. Test factual adherence hard first: the 7B Helium backbone is the weak link for grounded Q&A.

---

## 7. Verified vs. Unverified

**Verified (primary sources / multiple independent sources):**
- PersonaPlex-7B-v1 existence, Jan 2026 release, 7B Moshi-based architecture, MIT code + NVIDIA Open Model License weights, **English-only**, A100/H100 target, ~0.17–0.24 s FullDuplexBench latency, text+voice prompt conditioning, `moshi.server` WebSocket serving (HF card, NVIDIA ADLR page, GitHub repo, arXiv 2602.06053).
- No PersonaPlex update after 2026-03-02 (GitHub commit log via API; HF `lastModified`).
- Nemotron 3 VoiceChat: 12B full-duplex, EA since 2026-03-14, FastConformer + Nemotron Nano V2 9B + TTS decoder, benchmark scores (NVIDIA EA page, build.nvidia.com model card, Artificial Analysis).
- gpt-realtime pricing ($32/$64 per 1M audio tokens) and official language list incl. all 10 targets (OpenAI + Microsoft Learn).
- Gemini Live language coverage incl. all 10 targets; 15-min audio session limit (ai.google.dev).
- Qwen3-Omni Apache 2.0, 19 in / 10 out speech languages (HF cards, GitHub).
- Nova 2 Sonic 7 languages (AWS blog/docs).
- Moshi CC-BY-4.0 weights, EN-only, VRAM tiers (Kyutai GitHub/HF).
- Modal per-second GPU pricing (modal.com/pricing).

**Unverified / flagged:**
- Any "May 2026 PersonaPlex update" — **no evidence found; likely conflation with Nemotron 3 VoiceChat (Mar 2026) or gpt-realtime-2 (May 2026).**
- Nemotron 3 VoiceChat language support and final license terms (EA-gated).
- "70 ms speaker switch / 18× Gemini" claim (single third-party blog).
- Qwen3.5-Omni's 36 speech-output language list and Light-tier license (no primary enumeration found).
- PersonaPlex on 24 GB GPUs (only A100/H100 officially listed).
- Exact per-minute costs for Gemini Live / gpt-realtime (token-to-minute conversions vary across sources; the $165/100k-min figure circulating for Gemini does not match its own per-minute rate — treat all per-minute figures as ±2×).
- Azure Voice Live pricing (not gathered).

---

## 8. Sources

**NVIDIA PersonaPlex**
- https://huggingface.co/nvidia/personaplex-7b-v1 (model card; license, English-only, A100/H100, latency)
- https://research.nvidia.com/labs/adlr/personaplex/ (ADLR project page)
- https://research.nvidia.com/labs/adlr/files/personaplex/personaplex_preprint.pdf / https://arxiv.org/pdf/2602.06053 (paper)
- https://github.com/NVIDIA/personaplex (code, MIT, `moshi.server`, commit history)
- https://the-decoder.com/nvidia-open-sources-personaplex-a-voice-ai-that-listens-and-talks-at-the-same-time/
- https://www.datacamp.com/tutorial/nvidia-personaplex-tutorial
- https://comfyui-wiki.com/en/news/2026-01-20-nvidia-personaplex-7b-v1-release
- https://www.kunalganglani.com/blog/nvidia-personaplex-full-duplex-voice-ai (third-party latency claims — caution)

**NVIDIA Nemotron 3 VoiceChat**
- https://developer.nvidia.com/nemotron-voicechat-early-access
- https://build.nvidia.com/nvidia/nemotron-voicechat/modelcard
- https://artificialanalysis.ai/articles/nemotron-3-voicechat-leader-speech-pareto
- https://developer.nvidia.com/blog/building-nvidia-nemotron-3-agents-for-reasoning-multimodal-rag-voice-and-safety/

**Kyutai**
- https://github.com/kyutai-labs/moshi · https://kyutai.org/Moshi.pdf · https://arxiv.org/html/2410.00037v2
- https://huggingface.co/kyutai/moshiko-pytorch-bf16 (CC-BY-4.0 weights)
- https://github.com/kyutai-labs/unmute · https://kyutai.org/unmute · https://unmute.sh/
- https://github.com/kyutai-labs/delayed-streams-modeling (Kyutai STT/TTS)

**Hosted realtime APIs**
- https://openai.com/index/introducing-gpt-realtime/ · https://openai.com/index/advancing-voice-intelligence-with-new-models-in-the-api/ · https://openai.com/api/pricing/
- https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-language-support (Azure Voice Live + gpt-realtime official language lists)
- https://ai.google.dev/gemini-api/docs/live-api/capabilities · https://ai.google.dev/gemini-api/docs/pricing
- https://aws.amazon.com/blogs/aws/introducing-amazon-nova-2-sonic-next-generation-speech-to-speech-model-for-conversational-ai/ · https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-language-support.html

**Qwen**
- https://github.com/QwenLM/Qwen3-Omni · https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct · https://arxiv.org/abs/2509.17765
- https://arxiv.org/pdf/2604.15804 (Qwen3.5-Omni technical report) · https://www.digitalapplied.com/blog/qwen-3-5-omni-omnimodal-256k-113-languages-guide · https://decrypt.co/362742/alibaba-qwen-omni-major-upgrade-review

**Other models & research**
- https://github.com/fixie-ai/ultravox · https://www.ultravox.ai/
- https://arxiv.org/html/2505.15670v1 (SALM-Duplex, NVIDIA/Interspeech 2025)
- https://arxiv.org/html/2509.22243v1 (FLEXI full-duplex benchmark) · https://www.emergentmind.com/topics/full-duplex-speech-llms

**GPU hosting**
- https://modal.com/pricing
- https://techbytes.app/posts/serverless-gpu-pricing-matrix-modal-replicate-lambda-2026/
- https://www.buildmvpfast.com/blog/scale-to-zero-serverless-gpu-modal-runpod-ai-hosting-2026
- https://www.koyeb.com/blog/best-serverless-gpu-platforms-for-ai-apps-and-inference-in-2026
