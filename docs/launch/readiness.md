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

## Validation evidence

- Application unit/API suite after dependency upgrades: 424/424 passed across 20 files.
- Local synthetic migration rehearsal: upgrade 0006 → 0009 preserved public slugs, completed history, transcripts, settings and compatibility data. Binary backup/restore, SQL dump/restore, pre-upgrade restore and re-upgrade passed integrity and foreign-key checks. The 0008 migration regression group also passed 10 tests. This does not replace a staging D1 rehearsal using the production backup.
- TypeScript: passed after Workers types 5 / React Router 7 / Vitest 5 upgrades.
- Quality benchmarks: 220 tests, one existing skip.
- Realtime benchmarks: 206 tests; standalone report checker passed.
- Dependency audit: zero vulnerabilities (including development dependencies at upgrade).
- Browser tests: 6/6 passed against actual local workerd, covering public desktop/mobile, signup, private draft setup, save/publish/pause/reload, knowledge approval/attachment, every menu, password/export/deletion, and authenticated typed private calls with transcript/summary persistence against a local mock provider. This does not verify live-provider audio. Interrupted setup recovery and D1 cascade deletion counts were corrected.
- PR #13 head d6ea5d2: migration field validation and direct test-call reconciliation fixed following review; exact-head Codex reports no major issues and all existing CI checks pass. PR-Agent remains unavailable and its merge gate unresolved.

Read-only production inspection is recorded in [production-preflight.md](production-preflight.md): remote migrations 0007/0008 remain pending, configured secret names do not establish validity, and browser-user-agent probes returned 200 for the public site and 401 for the signed-out account endpoint. Python-user-agent probes returned 403. No remote changes, authenticated production session, or real-provider conversation are claimed.

## Latest review findings still open

Integration refresh on 2026-09-12: PR #14 fixes are pushed at `a50bc84` and consolidated as `51bfe28`. Knowledge drafts now confirm navigation/replacement, the headline live-call total excludes unconnected reservations, assistant creation preserves boolean `take_messages: false`, and browser attempts isolate their signup limiter buckets. TypeScript and 285 launch-branch unit/API tests passed. The six Chrome/workerd browser scenarios passed twice against one database (12/12, ten signups), including knowledge draft protection. This is synthetic-provider evidence. Required reviews were retriggered by close/reopen and a separate Codex request; latest-commit review/CI results remain pending.

Repository workflow inventory still exposes CI only and no PR-Agent review is present. PR #13 at `d6ea5d2` has Codex no-major-issues and green applicable checks, but lacks the mandatory PR-Agent result. PR #15 remains owned by the Telnyx workstream, which is validating its greeting readiness fix; no carrier pilot or staging webhook origin is validated by integration. PR #10 remains open; integrated commit `8666e7e` already qualifies its semantic-VAD evidence without changing detector behavior. Do not blindly merge the older comments over that correction.

The synthetic migration rehearsal is now reproducible with `python3 scripts/migration-rehearsal.py . --through 9`. This session passed preservation, binary backup/restore, SQL restore, pre-upgrade rollback and re-upgrade checks through 0009. It uses temporary fictional data and does not establish a production D1 backup or staging restore. Migrations 0010 (provider presets) and 0011 (Asterisk) are reserved; rerun the explicit target after consolidation.

## Required release gate

1. Resolve every confirmed test/review finding and rerun the relevant matrix against the final commit.
2. Satisfy the repository review requirement. Current instructions require PR-Agent and Codex; the former is unavailable. User decision on substitute review is pending. Do not merge around it.
3. Choose the real hostname and operator/support identity. Set absolute canonical/Open Graph URLs and an origin-correct sitemap. Write accurate hosting/privacy terms using actual operator and processor details; obtain any needed review.
4. Confirm the production Cloudflare account, Worker, D1 binding, migration status and configured provider secrets through scoped tools. Never output values or use credentials from old plaintext files.
5. Export a production database backup to a restricted location before migration. Run migrations on staging first, verifying an existing-account upgrade and preserved public slugs.
6. Verify a real provider test on the intended configuration: mic allow/deny, text fallback, interruption, hangup, transcript/summary persistence, unknown question and message capture. Then verify a consented live browser call on the target HTTPS origin.
7. Verify application/log error reporting and a rollback path to the previous Worker version. Keep additive schema compatibility when rolling back code.
8. Start with a small consented pilot. Do not launch phone-number marketing until the carrier transport passes its separate release gate.

## Deployment procedure (prepared, not executed)

Use this repository's Cloudflare deployment, not an unrelated website host. The target account must be Duguet Labs and credentials must come from `dsecret`/the scoped environment. `npm run deploy` includes **remote migrations** and is not a preview command.

Before deployment, record current Worker version and migration list, export D1, and verify backup restoration on a temporary database. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:telnyx`, both Python benchmark suites, `npm run test:e2e`, and `npm run build`. The browser CI job runs the local-workerd suite, and the deployment job depends on application, browser, and both benchmark checks. Production deployment additionally requires an explicit CI workflow dispatch on `main` with `deploy_production=true`; merging code does not deploy. The workflow was published through the GitHub connector’s existing authorization; no permission expansion is required. Verify these checks on the exact release commit before deployment.

After an approved release, check public root, authentication, existing-account data, draft/paused public-link rejection, private test ownership, exports and account settings. Perform one real test/live call and inspect its record. If acceptance fails, roll back Worker code to the recorded prior version, leave additive schema in place, and investigate before resuming traffic.

## Operator decisions still needed

- Final production hostname and support/operator identity.
- Hosted service versus self-hosting-only launch; data retention and processor choices for the hosted instance.
- Mandatory PR-Agent gate or explicit accepted substitute.
- Whether PSTN is required for the initial public launch. The current website truthfully describes browser-only calling.

- Real-provider preflight: the scoped vault credential returned HTTP 403 from the configured Kataleptic model catalog. No live provider conversation was claimed or completed; valid provider access still needs verification.
- Inbound Telnyx control and media runtime is included behind the disabled rollout flag. The synthetic workerd harness proved ingress, bidirectional PCM, interruption, playback drain, hangup and release without external calls. The public website still describes browser calling until a real carrier pilot passes.
