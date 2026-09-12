# OpenFon release readiness

Updated 2026-09-12. **Release candidate in progress; not production-launch approved.**

## Product truth

| Capability | State |
|---|---|
| Public website with original CSS 3D telephone, interactive examples, responsive layout | Implemented; desktop/mobile inspected |
| Workspace signup and setup | Implemented; browser flow passed |
| Multiple assistants; draft, active and paused lifecycle | Implemented; browser persistence test passed |
| Private Test Studio with audio/text and transcripts | Implemented; real provider call still required |
| Knowledge collections, attachments, drafts and approval | Implemented; browser creation/approval/attachment/reload flow passed |
| Calls, filters, summaries and caller-question draft creation | Implemented; typed mock-provider call verifies persisted transcript, summary and detail rendering; question drafts covered by API tests |
| Password change, private export, account deletion | Implemented; API and browser password/export/deletion flows passed |
| Inbound Telnyx number | Implemented behind disabled rollout flag; unit and synthetic workerd tests pass; actual carrier pilot required |
| Outbound calling / number purchasing / porting | Not implemented |
| Calendar booking | Not implemented; only request capture |
| Email verification / forgotten-password recovery | Not implemented |
| Hosted support identity, production domain and legal disclosures | Operator details pending |
| Marketing strategy, social asset and announcement drafts | Prepared; not distributed |

## Consolidated validation — 2026-09-12

Implementation candidate `6e64872` includes presets `ce62114`, realtime `18d3638`/`13f037b`/`ca0d901` plus handshake fix `083dae3` and replacement regressions `5411999`, Telnyx `37b3575`, Asterisk `aac57a2`/`0737b0b`, launch documentation, and both PR #14 correction rounds (`a50bc84`, `f839527`). Default providers are preserved; carrier rollout flags remain false.

- TypeScript and **496/496 unit/API tests** across 24 files passed on the assembled candidate.
- Actual local-workerd smoke tests passed Telnyx native and synthesized greeting modes, Asterisk auth/admission/media/drain/hangup, direct OpenAI GA protocol and the existing gateway. The direct path includes an authenticated static voice catalog, blocks unmatched hosts, and uses no Kataleptic/instance AI/Azure credentials. All upstreams/carrier events are synthetic.
- **Seven Chrome/workerd browser scenarios passed on the assembled candidate**, including private calls, account export, provider settings/mobile layout, onboarding/collection draft guards and URL/search synchronization.
- Quality benchmarks: **220 tests, one skip**. Realtime benchmarks: **206 tests passed**. Standalone report checker: 122 verified figure rows, four allowlisted, zero unresolved. Dependency audit: **zero vulnerabilities**.
- Synthetic `python3 scripts/migration-rehearsal.py . --through 11` passed 0006→0011 preservation, binary/SQL restore, pre-upgrade rollback and re-upgrade.
- A restricted production D1 SQL backup was restored into a **separate Cloudflare rehearsal D1 database** and upgraded through 0011. Six legacy-data fingerprints (businesses, settings, presets, completed calls, turns, public slugs) matched exactly; foreign-key and integrity checks passed. Production migrations were not applied.
- Independent QA approved the initial launch fixes and explicit deployment gate, and closed the direct pre-ack event leak at exact fix `083dae3` with independent failing-then-passing probes and actual-workerd checks. Final assembled review is pending.

[Provider configuration and compatibility](../providers.md), [direct realtime recipe](../realtime-providers.md), [Asterisk recipe](../asterisk.md), and [production/staging evidence](production-preflight.md) separate implementation from live acceptance. No live AI conversation, audible browser acceptance or handset pilot is claimed. Asterisk runtime evidence is being pursued by its owner; synthetic chan_websocket tests alone do not establish a real PBX pass.

## PR and review state

PR #13 `d6ea5d2` has Codex no major issues and green applicable checks. PR #15 `37b3575` has green CI and Codex code/security no-issues results. PR #14 `f839527` fixes the latest verified findings (bounded export construction, URL/search synchronization, collection detail and onboarding draft guards); it was pushed, closed/reopened and separately requested for Codex review. Its latest CI/review result remains pending. Every finding has a reasoned reply.

Mandatory **PR-Agent is unavailable**: the public repository has CI only and no PR-Agent review after retriggering. Independent QA and Codex security review are not an authorized substitute. No PR has been merged. PR #10 remains open; integrated `8666e7e` already qualifies the semantic-VAD research without changing the detector, so do not merge stale wording over that correction.

## Required release gate

1. Resolve every confirmed test/review finding and rerun the relevant matrix against the final commit.
2. Satisfy the repository review requirement. Current instructions require PR-Agent and Codex; the former is unavailable. User decision on substitute review is pending. Do not merge around it.
3. Choose the real hostname and operator/support identity. Set absolute canonical/Open Graph URLs and an origin-correct sitemap. Write accurate hosting/privacy terms using actual operator and processor details; obtain any needed review.
4. Confirm the production Cloudflare account, Worker, D1 binding, migration status and configured provider secrets through scoped tools. Never output values or use credentials from old plaintext files.
5. Backup and separate D1 migration rehearsal through 0011 passed for the recorded snapshot. Refresh the production backup and confirm any intervening schema/data changes immediately before an approved production migration.
6. Verify a real provider test on the intended configuration: mic allow/deny, text fallback, interruption, hangup, transcript/summary persistence, unknown question and message capture. Then verify a consented live browser call on the target HTTPS origin.
7. Verify application/log error reporting and a rollback path to the previous Worker version. Keep additive schema compatibility when rolling back code.
8. Start with a small consented pilot. Do not launch phone-number marketing until the carrier transport passes its separate release gate.

## Deployment procedure

Use this repository's Cloudflare deployment, not an unrelated website host. The target account must be Duguet Labs and credentials must come from `dsecret`/the scoped environment. `npm run deploy` includes **remote migrations** and is not a preview command.

Before production deployment, refresh the recorded Worker version and migration list, export D1 with stdout captured to a restricted file (Wrangler prints a signed download URL), and verify backup restoration on a temporary database. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:telnyx`, both Python benchmark suites, `npm run test:e2e`, and `npm run build`. The browser CI job runs the local-workerd suite, and the deployment job depends on application, browser, and both benchmark checks. Production deployment additionally requires an explicit CI workflow dispatch on `main` with `deploy_production=true`; merging code does not deploy. The workflow was published through the GitHub connector’s existing authorization; no permission expansion is required. Verify these checks on the exact release commit before deployment.

After an approved release, check public root, authentication, existing-account data, draft/paused public-link rejection, private test ownership, exports and account settings. Perform one real test/live call and inspect its record. If acceptance fails, roll back Worker code to the recorded prior version, leave additive schema in place, and investigate before resuming traffic.

## Operator decisions still needed

- Final production hostname and support/operator identity.
- Hosted service versus self-hosting-only launch; data retention and processor choices for the hosted instance.
- Mandatory PR-Agent gate or explicit accepted substitute.
- Whether PSTN is required for the initial public launch. The current website truthfully describes browser-only calling.

- Real-provider preflight: the scoped vault credential returned HTTP 403 from the configured Kataleptic model catalog. No live provider conversation was claimed or completed; valid provider access still needs verification.
- Inbound Telnyx control and media runtime is included behind the disabled rollout flag. The synthetic workerd harness proved ingress, bidirectional PCM, interruption, playback drain, hangup and release without external calls. The public website still describes browser calling until a real carrier pilot passes.
