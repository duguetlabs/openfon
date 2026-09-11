# OpenFon launch strategy

Prepared 2026-09-11. This is an executable launch plan; distribution remains unsent until the release gate passes. No invented testimonials, savings figures, or customer counts.

## Position and first audience

**Open-source voice assistance for small businesses that want to own the conversation.** Start with technically supported owner-operated service businesses and the developers/agencies who maintain their websites. Browser-first is a narrower, honest initial offer: a call link on the site, FAQs, messages, and a review loop. Existing-number replacement is a later milestone.

The first pilot hypothesis is repair shops and independent studios with repetitive questions, a maintained website, and an owner able to review a transcript. Validate it with five consenting pilot businesses before investing in vertical pages or acquisition spend. Exclude emergency handling and use cases requiring confirmed scheduling: neither is supported.

## Competitive evidence and implication

On 2026-09-11, [fonio’s own pricing page](https://www.fonio.ai/en/pricing/) presents a hosted phone assistant with numbers, calendars, and higher-tier telephony features. [Vapi’s own pricing page](https://vapi.ai/pricing) presents developer-oriented voice infrastructure and usage pricing. These are broader offers than OpenFon’s current browser channel. The inference for OpenFon: compete on inspectability, a compact self-hosted stack, provider choice, and the test/review/knowledge workflow. Do not claim feature parity, lowest total cost, or a quantified savings advantage.

## Message architecture

- Lead: “A little more human. Even when you’re busy.”
- Explanation: “An open-source voice assistant for your business. Built on your knowledge. Run on your terms.”
- Proof: MIT source, self-hosting instructions, real studio screenshots, a recorded end-to-end demonstration when verified.
- Primary action: create an assistant on the instance.
- Secondary action: inspect the source and self-host.
- Qualification beside the action: browser calls today; hosting and AI usage costs apply.

Use short, concrete language: answers, messages, test, review, publish. Say “booking request”, never “appointment confirmed”. Say “your configured providers process audio/text”, never “data never leaves your server”. AI disclosure must remain visible to callers.

## Launch sequence and ownership

| Phase | Owner | Work and exit evidence |
|---|---|---|
| Release candidate | Engineering | Green build/tests, browser flow evidence, security findings resolved, required PR reviews, backup/rollback drill and target instance verified. |
| Pilot preparation | Founder | Select five consenting business owners; capture their real FAQs and explicit test expectations. Confirm support route, operator identity, data policy, and hosting offer. |
| Pilot week | Founder + engineering | Observe first assistant setup, first private test, correction, and first consented live browser conversation for each pilot. Record failures and support time. |
| Public release | Founder | Publish source release, launch post, real demo and website together only after pilot failures are resolved. Announce in communities where relevant and allowed. |
| Follow-through | Founder | Answer every substantive question, triage reproducible issues, ship fixes, and publish a measured update after seven days. |

## Channel plan

Start with GitHub and a founder-owned technical announcement. A practical self-hosting walkthrough is the central content asset. Reuse its verified screenshots for LinkedIn and a short product post. Prepare a Show HN submission only when readers can try or inspect the working release. Approach self-hosting/voice developer communities according to their posting rules; do not mass-post the same pitch. Search landing pages should answer real questions (“self-host a browser voice assistant”) and contain working instructions, not thin keyword variants.

No paid acquisition in the pilot. A spend decision comes after observed activation and cost-per-conversation data, with a separate budget approval.

## Conversion and measurement

No third-party tracking is added by this release. Measure the first pilot through consented observation and existing operational records. Do not copy transcripts, names, phone numbers or API keys into marketing analytics.

Define activation as: workspace created → assistant configured → completed private test → knowledge correction if needed → assistant published → first completed live call. Report raw numerator/denominator alongside percentages. Separate failed or abandoned calls from completed calls and exclude test calls from live totals.

Pilot decision thresholds are hypotheses, not results: at least 4 of 5 pilots complete setup without code changes; every pilot completes a test; no cross-account data exposure; all 5 understand browser-only limits; no unresolved issue that loses messages. If setup fails, fix onboarding before increasing traffic.

After an analytics provider and data policy are selected, implement event names `signup_completed`, `assistant_created`, `test_completed`, `assistant_published`, `first_live_call_completed` with pseudonymous identifiers and no transcript content. This event collection is not yet implemented or claimed.

## Launch assets

- Public page: web/src/pages/Landing.tsx and web/src/landing.css.
- Social image source and export: web/public/social-card.svg and social-card.png.
- Announcement drafts and demo script: docs/launch/copy.md.
- Product truth and release gate: docs/launch/readiness.md.
- Search: title/description/Open Graph metadata and robots.txt. The build generates absolute canonical/social URLs and sitemap when OPENFON_PUBLIC_URL is supplied for the chosen production hostname.
