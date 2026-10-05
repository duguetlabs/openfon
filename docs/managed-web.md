# Managed OpenFon

The managed application has five destinations:

- **Home:** this week's calls, minutes and average call length; open booking requests; urgent or overdue work; recent messages; assistant availability and public links. Metrics open the corresponding filtered list. The business timezone determines the start of the week.
- **Messages & to-dos:** booking requests, messages, callbacks and tasks, with contact details when provided, status, urgency, due date and source call. Private tests are excluded by default and can be selected explicitly.
- **Call logs:** every stored call, including calls without actions, with assistant, channel, duration, outcome, summary, transcript and related actions. Filters include assistant, date, status, channel and private/customer calls.
- **Settings:** My business, Assistants, Phone number, and Account & privacy.
- **Billing:** published plan prices, subscription availability and actual usage for the active billing period. Unconfigured payments or telephone services remain visibly unavailable.

Saving an assistant, testing it and publishing its public link are separate actions. New assistants initially inherit the business language. Changing the business language later does not silently replace existing assistant choices. Business facts and shared behavioral instructions are separate; assistant instructions may override ordinary business defaults but never enforced safety or booking restrictions.

## Bookings and action processing

An appointment request is a **booking request**, not a confirmed booking. OpenFon has no calendar-confirmation workflow in this release and does not display extracted intent as a completed appointment.

A call can produce several actions, including several of the same kind. Structured extraction references actual caller turns. The first complete, validated extraction snapshot is immutable: retries, reordered output and stale parallel completions cannot append paraphrases or reopen handled work. Invalid partial output does not seal the snapshot. A deliberate empty result does; legacy terminal projection triggers cannot override any completed structured snapshot. Failed structured extraction does not produce fallback booking/message actions. Historical message and booking intent are preserved as compatibility actions, including handled state; later extraction does not duplicate those singletons. This release does not offer an automatic replacement/re-extraction workflow.

## Customer and operator boundaries

`OPENFON_MANAGED_WEB=true` is an operator-controlled deployment setting. The server denies customer provider, model, preset and summary-routing configuration; assistant writes accept business-facing choices only. Customer responses use explicit field projections and generic failure descriptions. Operator routing diagnostics stay outside the customer interface. Voice names are friendly labels and previews use the selected conversation voice, with their provider usage recorded separately from call minutes.

The managed runtime uses direct Azure, including conversation, delegated tool reasoning, post-call summaries, extraction and voice previews. There is no managed fallback to Kataleptic. See the runtime operator documentation for required service configuration. Customer voice changes do not change summary routing.

Existing assistant routing columns and credentials are retained in the database. Enabling the managed deployment changes runtime routing explicitly; it does not run a blanket model-rewrite migration. A previously selected incompatible voice requires an explicit new selection rather than a silent replacement. New managed assistants store Marin explicitly. The released browser runtime already interpreted two blank saved voice fields as Marin; read/runtime compatibility preserves that effective voice and shows Marin, without rewriting either stored field. Explicit nonempty incompatible selections require the owner to choose a compatible voice. New submitted blank voice edits are rejected.

The installed iOS 1.0.0 build 4 decoder requires `engine` and `realtime_voice` strings. Managed responses retain empty compatibility values and return the selected voice in `voice`. Native source inspection confirms its business-detail save does not send technical routing fields. This is source compatibility evidence, not a new installed-app or physical-audio acceptance claim.

## Account data and recordings

Accounts retain password, export and deletion controls. Export uses a single bounded SQL snapshot and positive field projections, including action items and customer billing/usage records. Routing, credentials and raw payment/provider observations are excluded. Deletion must reconcile subscriptions and number ownership before removing local mappings; an unresolved external operation remains retryable. Account deletion reserves every owned workspace atomically against a current verified password and session, and refuses running or reserved calls. Cancellation retains the paid term; annual usage continues monthly until that term ends. New calls are stopped atomically at the term boundary even if scheduled cancellation reconciliation is delayed.

Historical test recordings remain available only where they actually exist. Customer recording downloads contain captured audio and retention/completeness facts, with operator configuration and raw protocol events excluded. Some historical browser-generated responses have text but no recorded assistant audio. Expired recordings cannot be recovered. New LiveKit calls do not gain an audio-recording implementation from this redesign; transcripts and summaries are separate from audio recordings.

## Additive migration

- **0026:** business contact email, initial language and shared instructions; owned action items and immutable extraction snapshots; historical request/message projection.
- **0027:** commercial account, usage, payment, telephone and lifecycle state. It does not enroll existing accounts in a paid plan or charge historical calls.

Use the guarded `npm run deploy` production entrypoint and explicit managed production config. Shared `wrangler.jsonc` remains the legacy/local harness configuration. The production entrypoint verifies routing and existing migration/credential-name prerequisites, and does not apply migrations. Apply only the reviewed pending migrations for each environment. Staging historically omits 0024, which rewrites saved model choices; do not include it merely because it is absent from a migration list. Take a restricted D1 backup, verify restoration and foreign keys, then validate the exact candidate on staging before production. Durable Object state needs its own operational recovery consideration.

## Validation boundaries

Local Worker/browser checks exercise real authentication, account isolation, managed API restrictions, data persistence and navigation. Browser audio fixtures exercise playback and cleanup with generated audio. They do not establish Azure voice quality, physical microphone behavior, payment-card settlement or carrier connectivity. Current release status and unresolved external acceptance belong in [readiness](launch/readiness.md) and [production preflight](launch/production-preflight.md).
