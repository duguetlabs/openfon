# Open-source provider and launch strategy

- Date: 2026-09-12
- Status: Proposed

## Context

The founder wants OpenFon to earn reputation and adoption as an open-source voice
assistant. Kataleptic, the founder's inference service, may benefit economically
from a convenient default integration, but users must have a practical independent
choice. Paid advertising is outside the desired launch strategy. These are
recommendations for discussion, not accepted architectural decisions or permission
to deploy, purchase numbers, or distribute announcements.

Verified against the local checkout at `b730480` and read-only source research:

- `gh repo view --json nameWithOwner,visibility,url` reports
  `duguetlabs/openfon` is already PUBLIC. The local `LICENSE` is MIT.
- `README.md`, `docs/telephony.md`, and `wrangler.jsonc` describe browser calling
  as supported and an inbound Telnyx adapter behind `TELNYX_ENABLED=false`.
  Existing documentation records synthetic tests, but no successful real carrier
  pilot. This research did not make any calls or rerun application tests.
- `src/providers.ts:resolveLlm` supports business-specific text LLM settings.
  `src/types.ts:ProviderSettings` has text LLM endpoint/key fields, while speech
  transcription and realtime endpoint/key configuration live on `Env`.
- `src/call-session.ts:startRealtime/openUpstream` uses instance realtime
  configuration, a token query parameter, and model-specific gateway behavior.
  Direct OpenAI's documented server connection uses an Authorization header.
  A changed URL alone is therefore not evidence of direct realtime compatibility.
  [Official Realtime WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime).
- Hosting uses Cloudflare Workers, Durable Objects, and D1. Deploying into a
  user's Cloudflare account is different from a portable deployment on any server.
- The existing walkthrough in `docs/launch/demo/` is a disclosed silent UI demo
  using fictional data and a deterministic provider. It does not demonstrate voice.
- `docs/launch/readiness.md` records unresolved release work. This strategy review
  did not refresh remote PR/CI status or supersede those engineering gates.

## Decision

Propose the following sequence and product commitments.

### Product identity and audience

Lead with **OpenFon — the open-source voice assistant for your business.** Explain
the job in one sentence: answer routine questions, take messages, and review what
callers needed. Use ownership, understandable costs, and demonstrated provider
choice as supporting proof. Keep the founder/Duguet Labs attribution visible in
the README, website, and technical writing.

The first adopters should be developers and small agencies supporting service
businesses, plus technically capable owners. The eventual business user should
have a simple interface; the first installer can be technical. Test one narrow
use case with three to five repair shops or similar service businesses: routine
questions and callback requests when the owner is unavailable. Start with a
browser pilot; test after-hours/no-answer forwarding only after telephone support
is validated. Treat audience and vertical selection as hypotheses.

Use a fonio comparison in explanatory copy, with specific feature differences.
Fonio advertises telephone and calendar workflows that OpenFon has not validated
or implemented. [Fonio product page](https://www.fonio.ai/en/).

### Telephony

| Path | Proposed role | Reason and qualification |
| --- | --- | --- |
| Browser audio | First demo and first setup test | No telephone number or carrier account needed; AI usage still costs money. |
| Telnyx Voice API + bidirectional media | First supported telephone recipe after pilot | Existing adapter and an official WebSocket media interface fit the current app. Selection is based on project fit, not an unverified claim of lowest price. |
| Twilio Media Streams | Next managed-carrier candidate if users request it or Telnyx fails the target-country pilot | A credible bidirectional WebSocket alternative; still requires an adapter and real validation. |
| SIP/PBX through an open gateway | Planned route for existing carriers and phone systems | OpenFon needs a media/control adapter; an arbitrary SIP trunk cannot connect to the Worker as-is. |
| SIM/analog hardware | Later experimental integration | Hardware qualification and support would widen the initial project substantially. |

[Telnyx media streaming](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming)
and [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) document
bidirectional audio. Neither vendor's wire format is the application's neutral
contract. Keep carrier lifecycle, media conversion, interruption/flush, and hangup
behavior behind adapters, separate from assistant knowledge and conversation logic.

For the open SIP route, first evaluate an Asterisk adapter because
[chan_websocket](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/)
can exchange audio and control messages with applications. Asterisk integration
is a proposal, not existing OpenFon functionality. LiveKit is another viable
open-source media layer; its self-hosted SIP setup includes LiveKit, SIP, and Redis,
so adopting it is a larger operational change to this small Worker app.
[LiveKit self-hosted SIP](https://docs.livekit.io/transport/self-hosting/sip-server/).

Keep SIP/RTP termination in the gateway: the current Worker is not a general
inbound socket server. [Workers protocols](https://developers.cloudflare.com/workers/reference/protocols/).

For initial self-hosting, users should hold their own carrier account and numbers.
Provide a guided recipe and connection test. Avoid introducing number resale and
central carrier billing as launch requirements. Pilot with a test number; existing
numbers can subsequently use carrier-supported forwarding before considering
porting. Verify availability, account eligibility, forwarding charges, local
number requirements, latency, and failure behavior in the target country. A
standard SIP interface does not itself guarantee number portability or free calls.

### AI providers and Kataleptic

Offer visible setup choices: **Kataleptic — guided setup**, **another supported
provider**, and **custom configuration**. State beside Kataleptic that it is run by
the OpenFon founder and requires a separate paid account. Explain its convenience
with measured facts when available; avoid unsupported cheapest/fastest claims.

Separate four capabilities in configuration and documentation: text generation,
speech recognition, speech synthesis, and realtime voice. A provider can support
one without supporting the others. Preserve both pipeline and realtime engines,
but show telephone compatibility explicitly; today's carrier implementation is
realtime-only and browser speech synthesis cannot serve a telephone caller.

Implement and verify direct OpenAI Realtime as the first independent realtime
recipe, based on proximity to the current event protocol. This is an integration
priority, not a quality/price ranking. Test its actual authentication, session
events, voices, interruptions, tools, hangup, and persisted results. Do not treat
selecting an OpenAI model through Kataleptic as an independent provider route.

The independence acceptance check is a complete setup and call with all Kataleptic
credentials removed and its endpoints blocked, including voice catalogs, greeting,
transcription, summaries, and errors. No silent routing back to Kataleptic. Users
choosing an alternative should not need a Kataleptic account or lose unrelated
application features. Distinguish provider capability differences honestly.

Publish a tested compatibility table with provider, engine, browser/telephone
support, versions/models, and last verification date. Label other compatible
endpoints experimental until tested. If hosting multiple customer workspaces,
add workspace-specific realtime/STT/TTS credentials; instance-wide settings alone
do not implement bring-your-own-provider for each hosted customer.

Keep MIT for this reputation/adoption objective. Publish contribution guidance
welcoming independent providers. The proposed economic relationship is free
software plus optional paid inference convenience. Users still pay hosting,
telephone-number/usage charges, and their selected AI/speech providers. Publish
measured example bills with assumptions instead of a universal per-minute figure.

### Access and release sequence

1. **Public development / alpha:** the source is public already. Once a fresh
   installation and real browser voice call pass, tag an explicitly scoped alpha
   with browser support and experimental telephony status. Start founder updates
   and recruit pilot participants. Product claims must match the released commit,
   not an unmerged branch.
2. **Small pilot:** observe three to five installations, test the Telnyx path in
   the intended country, and verify an independent voice provider. Preserve a
   dated report of success/failure, audible latency, costs, and support time.
3. **Main announcement:** publish a release, real audible demonstration,
   self-hosting guide, provider table, and technical explanation. For a phone-agent
   announcement, require a real handset call and the telephone failure matrix.
   A browser-only release can happen earlier if presented as such.
4. **Follow-through:** reply to questions, triage issues, help initial installers,
   and publish fixes and measured lessons over the following weeks.

Use three access levels: a short no-signup browser demo using fictional business
knowledge; a documented deployment into the user's own Cloudflare account; and a
small explicitly supported pilot. The demo needs a chosen operating budget,
duration/concurrency limits, and a kill switch. A recorded audible demonstration
is the fallback if no demo hosting budget is chosen. Unlimited free hosted
production service is not a requirement of this open-source release.

The existing silent walkthrough can explain the UI. Add a real 60–90 second voice
demonstration showing a routine answer, an interruption, an unknown question, a
callback request, and the saved result. Keep claims such as calendar booking and
human transfer out until they work.

Use LinkedIn early for the founder's explanation and pilot recruitment. Use
Show HN once readers can try the release easily. HN explicitly encourages an
accessible working project, preferably without signup barriers, and does not
accept a landing page alone as Show HN. It also prohibits soliciting upvotes.
[Show HN guidelines](https://news.ycombinator.com/showhn.html).

Example title for a browser alpha:
**Show HN: OpenFon – an open-source browser voice assistant for small businesses**.
After validated telephone support, use **open-source AI receptionist** and state
exact supported carriers in the description. Link the source, demo, tested setup,
limitations, and founder's commercial relationship in the first explanation.

Publish relevant tutorials in self-hosting and voice/telephony communities where
their rules permit them. Useful technical articles include interruption handling,
cost measurement, and lessons from maintaining two independent voice providers.
Channel timing is an experiment, not a promised acquisition result. No paid ads
are recommended. Avoid making a single high-traffic post the whole launch plan.

Suggested first-month targets, explicitly hypotheses: five outside installations,
three recurring users, one independently reproduced provider switch, one external
contribution, and one publishable case study with consent. Also measure setup time,
completed calls, task outcome, failures, and maintainer support hours. Treat GitHub
stars and Kataleptic conversion as secondary to credible usage evidence.

## Rationale

A maintained default reduces setup burden. A tested independent route establishes
that provider choice is practical. Finishing the existing carrier path gives
earlier evidence than replacing the media architecture before the first pilot.
Developers/agencies can handle account and deployment steps while providing access
to real business needs. Visible founder authorship, working demonstrations,
reproducible measurements, and sustained maintenance support the reputation goal.

## Alternatives considered

- Launch as a broadly complete fonio replacement: expectations exceed current
  telephone and calendar capability.
- Require self-hosted SIP from the first screen: raises installation burden before
  people experience the assistant. Retain as an advanced path.
- Build many carrier and AI adapters before launch: expands maintenance without
  evidence of demand. Start with one carrier and two independently verified voice
  configurations; prioritize subsequent adapters from pilot needs.
- Require Kataleptic for all traffic: conflicts with the founder's stated aim.
- Remove any Kataleptic default: sacrifices useful convenience; transparent
  ownership and accessible alternatives address the actual concern.
- Replace the current runtime with LiveKit/Pipecat immediately: consider only if
  pilot evidence or an explicit portability objective justifies the migration.
- Build a SIM appliance first: adds a hardware project to the software launch.
- Launch only through a single social post: offers little opportunity to learn
  from installations or demonstrate ongoing stewardship.

## Consequences

Positive: focused release scope, clear commercial disclosure, tangible provider
choice, and a launch grounded in demonstrable behavior.

Negative: two tested voice configurations cost maintenance time; guided carrier
accounts still involve external onboarding; existing-number integration remains
limited until the SIP path is delivered.

Operational: Cloudflare is a remaining platform dependency. Use “deploy in your
Cloudflare account” now, rather than “runs anywhere” or blanket “no vendor lock-in.”
A future portable runtime/storage adapter is separate work. Open-source code does
not make telephone service, inference, or all configured infrastructure open source.

## Affected components

- Provider configuration, credentials, catalogs, and realtime session adapter.
- Carrier adapters and a future SIP gateway interface.
- README, website, release notes, setup guides, cost examples, demo, and contribution
  guide.
- Pilot recruitment, maintainer support policy, and release acceptance evidence.

## Related material

- `docs/launch/strategy.md`: earlier launch strategy.
- `docs/launch/readiness.md`: engineering gates; not changed by this proposal.
- `docs/launch/telephony-plan.md` and `docs/telephony.md`: current carrier work.
- `docs/launch/demo/README.md`: limitations of the existing demonstration.
- `docs/research/sim-ai-voice-gateway-2026-09-08.md`: existing hardware research;
  preserved unchanged, procurement claims not revalidated here.

## Follow-up work

Discuss the proposed audience and support commitment with the founder. When
implementation is requested, independently verify repository/review state, finish
the existing engineering gates, implement the independent provider recipe, and
arrange an authorized carrier pilot. Scope subsequent SIP or portable-hosting work
from observed adopter demand. Do not treat this Proposed record as a direction to
resume another workstream, spend money, merge, deploy, or post announcements.
