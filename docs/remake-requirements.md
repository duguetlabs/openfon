> Historical proposal: the selected Brand Identity application and [current functional contract](cleanroom-functional-contract.md) supersede this earlier navigation and visual direction.

# OpenFon remake: product requirements

This is the product contract for the remake begun on 2026-09-27. Implementation and acceptance are tracked in [the delivery plan](remake-plan.md). Deployment status remains in [production preflight](launch/production-preflight.md); live audio and carrier acceptance remain in [release readiness](launch/readiness.md).

## The job

OpenFon is a small business's browser receptionist. It answers from approved business information, takes a message when it cannot help, and leaves an understandable record for the owner. A caller needs a useful answer or a reliable callback request. An owner needs to know what happened and what to improve. Neither should need to understand inference infrastructure to complete that job.

The customer journey is **teach → choose a voice → test → share → review**. Developers and agencies can configure the underlying services without making every customer follow that configuration journey.

## What the existing application establishes

| Evidence | Product consequence |
| --- | --- |
| `README.md`, `src/call-session.ts`, `web/src/pages/Widget.tsx` | Browser calling, captions, text fallback, transcripts and post-call results are the core. Keep them functional. |
| `web/src/pages/Studio.tsx`, `src/studio-api.ts` | Multiple assistants, private tests, publishing/pausing, approved knowledge, search and call detail already exist. Simplification must make these easier to find without deleting them. |
| `docs/settings-and-assistants.md` | Business facts and credentials are workspace settings; behavior and voice belong to each assistant. Preserve that distinction. |
| `src/providers.ts`, `docs/voice-configuration.md` | Pipeline reasoning and speech are independent. Changing a text model can leave exactly the same speech renderer and voice. A similar sound does not prove identical reasoning models. |
| `src/realtime-providers.ts` at the remake's base `804e6f4` | Retired/unknown Kataleptic selections could resolve to HD. An explicit choice must not silently become another model. |
| `src/provider-catalog.ts` at `804e6f4` | Catalog labels and modality fields did not establish the effective Azure deployment. Model identity needs separate evidence. |
| `src/account-api.ts` | Account export is a bounded archival snapshot with credentials excluded and provider URLs blanked. It is not an importable deployment configuration. |
| `docs/providers.md`, `docs/launch/readiness.md` | Direct provider, physical audio and PSTN claims have distinct acceptance requirements. Synthetic tests cannot establish them. |

## Customer experience

| ID | Requirement | Acceptance |
| --- | --- | --- |
| UX1 | Three primary destinations: **Conversations**, **Assistants**, **Settings**. | Owner can review a result, change the assistant and configure the workspace from these destinations on desktop and mobile. Existing deep links still resolve. |
| UX2 | Keep test and knowledge actions close to the assistant; keep account and infrastructure options in Settings. | No prerequisite trip through a model catalog or provider form when working credentials already exist. |
| UX3 | Begin with assistant name, role, greeting, language and voice. Reveal model IDs, engine configuration and extra instructions when needed. | Default editor is understandable to an owner; advanced fields remain available and saved values are preserved. |
| UX4 | Distinguish **saved**, **tested**, **published** and **paused**. | Unsaved changes cannot accidentally be presented as tested; publishing and pausing retain existing explicit actions. A connectivity check is not labelled a successful voice test. |
| UX5 | Call review prioritizes what the caller needed, the message and callback information. | Owner can reach transcript/details and distinguish test/live, failed, interrupted and never-connected calls. A booking request is never described as a confirmed appointment. |
| UX6 | Preserve the caller's simple experience. | Start, mute, text fallback, captions, audio recovery and end-call controls work without showing backend setup. |
| UX7 | Use a friendly, distinctive, consistent visual system. | Desktop and mobile rendered review checks legible type, contrast, focus, touch targets, empty/error/loading states, overflow and reduced motion. Impeccable guides design; product tasks stay legible. |
| UX8 | Preserve work during failures. | Draft edits survive section changes; acknowledged saves remain acknowledged after a failed refresh; account/session recovery remains intact. |

## Configurability and backend boundaries

The assistant owns behavior. The workspace owns credentials and component connections. The host owns persistence, secrets and transport bindings. These responsibilities must stay separable.

| ID | Requirement | Acceptance |
| --- | --- | --- |
| BE1 | Support realtime conversations and composed transcription → text → synthesis conversations through explicit adapters. | Existing Kataleptic, direct OpenAI, compatible custom endpoints, Azure/browser synthesis and separate summary configuration remain configurable by capability. No text-only provider is advertised as a complete voice service. |
| BE2 | Model selection, speech voice and summary model are distinct concepts. | The UI explains why changing reasoning need not change sound. Realtime choices use their own engine's voice catalog. |
| BE3 | Preserve endpoint-bound secrets and write-only keys. | Changing a provider destination requires a replacement credential or an explicit clear; import/export never moves credentials. Workspace keys are never silently reused for another host. |
| BE4 | Make supported capabilities inspectable. | Adapter metadata names capability families, protocol and endpoint configurability; compatibility documentation records channel support and limits. Model/voice choices are separate from the product navigation. Unknown adapters/models remain visibly unverified. |
| BE5 | Expose useful errors without silent substitution. | An unsupported explicit model fails with an actionable choice; blank/default selections can inherit documented defaults. Saved explicit choices are not silently mapped to HD. |

## Kataleptic identity and fair comparison

The goal is to offer genuinely different Azure-backed conversation models, not several attractive names for the same deployment. Provider metadata, running gateway configuration and Azure resource identity must be treated as separate evidence.

| ID | Requirement | Acceptance |
| --- | --- | --- |
| ID1 | Describe each offered Kataleptic path's gateway model ID, adapter/protocol, Azure service, underlying model and model version/deployment where verified. | A sanitized mapping records source and date; a public alias alone is marked insufficient. Private resource identifiers and credentials are not copied to the browser. |
| ID2 | Identify duplicate underlying models. | Two deployments of the same model/version are not counted as different models. Shared speech renderer or same named voice is disclosed separately from model identity. |
| ID3 | Preserve requested selections end to end. | Call and preview resolver tests cover every supported ID, unknown/retired IDs and blank defaults. Model and voice fallback behavior is explicit. |
| ID4 | Separate configuration evidence from runtime and listening evidence. | Source inspection means configured mapping; a provider startup echo means startup acceptance; audible conversation acceptance requires real audio. One status must not imply the others. |
| ID5 | Compare like with like. | A repeatable evaluation protocol uses the same business facts, language and caller questions per model; it checks known/unknown answers, callback capture, interruption, failures and hangup. Save requested/resolved model, voice, date, provider version and result. Performing the live comparison remains a separate acceptance step. |

No claim that models *sound different*, perform better, or are live-verified follows solely from distinct Azure deployment metadata. Voice timbre can be shared. The requested remedy is accurate routing and transparent choice, followed by listening tests.

## Portability

| ID | Requirement | Acceptance |
| --- | --- | --- |
| PO1 | Export and import a versioned assistant recipe. | A strict JSON schema round-trips name, greeting, role, instructions, language, message-taking, engine and model/voice selections. File size, field types, unknown fields and unsupported versions are rejected before applying. |
| PO2 | Review imported changes before saving. | Import first displays the complete recipe. Applying fills the editor draft; the ordinary authenticated Save action performs persistence and destination-provider validation. No upload triggers a call or publishes an assistant. |
| PO3 | Keep destination ownership and integrations. | IDs, slugs, publication state, business facts, knowledge collection IDs, credentials, endpoint URLs and call history are excluded. Instructions may contain business information; exports are configuration files, not anonymized data. |
| PO4 | Make missing dependencies explicit. | UI and docs state that business facts/approved knowledge must be configured or checked in the destination, and matching models/voices need destination provider access. A failed compatibility save retains the editable draft for correction. |
| PO5 | State the hosting boundary honestly. | Recipes and provider interfaces are portable; the current executable remains hosted on Cloudflare Workers, Durable Objects and D1. Host-independent execution is a separate adapter project, not a claim of this remake. |

## Scope boundaries

This remake includes the customer workflow, visual system, explicit model identity, routing corrections, capability metadata and portable assistant recipes. It preserves working server authorization, bounded audio handling, knowledge admission, call persistence, and existing migration compatibility.

It does not purchase numbers, place paid telephone pilots, deploy production, run remote migrations, promise calendar booking, invent human transfer, or perform a complete database restore. Replacing the Cloudflare runtime requires separate storage/session/transport adapters and validation. Existing telephony adapters remain experimental behind their existing rollout controls.

## Release decision

Every implemented requirement needs an evidence entry in the delivery plan. A clean build is necessary but does not prove usability, model identity, audible voice behavior or deployment readiness. Exact-candidate staging evidence and separately authorized rollout remain release gates. Unfinished live acceptance must remain visible in the existing release readiness process.
