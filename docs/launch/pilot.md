# Small, supervised browser pilot

Prepared operating guide; no recruitment has been sent and no support commitment or participant count is promised. Initial audience hypothesis: developers/agencies supporting service businesses, plus technically capable owners. Start with routine questions and callback requests for three to five willing businesses; evaluate that focus before expanding it.

## Before a participant starts

Agree who installs and operates the instance, which provider account pays usage, a small spending cap, the trial dates, and who reviews results. Confirm a maintainer contact and availability directly; none is committed by this document. Use fictional data first. For customer-facing use, the operator must settle their actual identity, privacy/retention information and provider disclosures before sharing the link. Do not collect real caller data for a demo.

Complete the [quickstart](../quickstart.md) and [release gates](readiness.md) applicable to the pilot. Verify real browser audio before inviting customers. Retain the existing phone/help channel; OpenFon is not an emergency service, confirmed booking system or guaranteed substitute for staff.

## Run the trial

1. Record the commit, engine/model, provider, browser, configuration and spending cap in the [evaluation](pilot-evaluation.md).
2. Add a small approved knowledge set: opening hours, services, what is unknown, and how to leave a message. Have the owner check every fact.
3. Run the private scenario matrix with the installer. Fix incorrect answers and retest before publishing.
4. With explicit participant agreement, share a browser link with a limited group. State that the assistant uses AI, may make mistakes and can capture requests for human follow-up.
5. Review transcripts and captured requests with the owner. Agree who follows up; the software does not establish a response-time promise. Count outcomes, failures and support minutes rather than only calls started.
6. Reconcile usage with the [cost worksheet](costs.md). At the agreed end, pause the assistant, export results if needed, and apply the agreed retention/deletion policy. Decide whether to continue from the evidence.

Stop sharing the link if it gives materially wrong information, exceeds the agreed budget, exposes data, or fails to preserve requests. Pause the assistant and confirm its public link no longer accepts new calls. Existing provider/carrier sessions may need operator intervention; do not assume pausing terminates all active sessions.

## Telephone pilot is a separate gate

Use an operator-owned test number only after the adapter’s setup and failure matrix pass. Existing-number forwarding comes later, with the operator confirming eligibility, charges and fallback. Number purchase, porting and phone-agent marketing need their own concrete authorization and real carrier evidence. Browser success does not satisfy that gate.

## Support scope

OpenFon is maintained as an open-source project. Public issues can report reproducible bugs and documentation problems. There is currently **no guaranteed response time, uptime SLA, managed hosting or included account/telecom administration**. Any assisted pilot needs an explicitly agreed maintainer, support window and scope; this draft creates no such commitment.

Provide commit/version, engine, channel, sanitized reproduction steps and expected/actual behavior. Do not post API keys, provider URLs containing tokens, customer transcripts or account exports. Account eligibility, billing and numbers remain with the selected providers and the operator. Confirm a private reporting contact before sending sensitive details; do not invent a support email.

## Inputs still needed for a hosted launch

- Actual operator/legal and support contact, final hostname, selected processors and retention policy.
- Maintainer availability, pilot duration, participant agreement and spend cap.
- The [audible staging capture](demo/audible/README.md) used the approved fictional Northwheel scenario and working provider. Its known failures require correction before clean voice acceptance. The two-conversation allowance is exhausted; no new live run is authorized.
- Final release/review evidence and channel-specific runtime results.

These inputs block dependent publication or recording, not independent documentation work. Announcements remain [drafts](copy.md).
