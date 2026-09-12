# Launch workstream

- Status: Complete — bounded assets ready for integration; dependent live evidence pending
- Owner: openfon-launch
- Branch: codex/launch-kit
- Starting commit: a9b33c5c46ccb441e4c07f50b81469354d3cf700 (code baseline b730480)
- Updated: 2026-09-12
- Rules: root AGENTS.md, .agent/orchestration-rules.md, launch handoff

## Confirmed facts and scope
Read root handoff/current-task/manifest/rules and proposed strategy. Worktree has only an existing untracked node_modules dependency link. README overstates universal provider compatibility and portability; website lacks founder/provider disclosure. Existing recording is explicitly silent and synthetic. Real provider/carrier evidence is pending per readiness.md; no new runtime evidence yet.

Own README, public landing copy, CONTRIBUTING.md and launch/onboarding docs; avoid settings/schema, runtime adapters, shared root coordination and research. Preserve existing website architecture. Use 8815/9255 only for local runtime if needed.

## Work completed / remaining dependencies
Finished quickstart, evidence-scoped compatibility, pilot/support guidance, evaluation and costs formulas, audible script, contribution guide and announcement drafts. Tightened README/landing claims without replacing website architecture. No runtime/schema edits.

Integration must refresh compatibility/configuration against consolidated provider/Asterisk commits, add exact adapter recipe links, and run final release gates. Audible recording remains blocked by authorized working provider and explicit approval of fictional scenario; operator/domain/support/legal inputs remain missing. No invented recordings, bills or testimonials.

## Files changed
- README.md: identity, paid-provider affiliation, bounded compatibility, quickstart links and explicit local ports.
- web/src/pages/Landing.tsx: clearer browser identity, usage costs, Kataleptic FAQ, corrected self-host anchor; architecture unchanged.
- CONTRIBUTING.md; docs/quickstart.md; docs/providers.md.
- docs/launch/pilot.md; pilot-evaluation.md; costs.md; copy.md.
- docs/launch/demo/audible-script.md; demo/README.md.
- .agent/workstreams/launch.md.

## Coordination evidence
Integration confirms no real provider/telephone pilot or staging HTTPS validation; typed local-provider browser flow passes. Presets owns schema/UI and will send final contract; no edits to launch files. Realtime owner is authoring docs/realtime-providers.md: direct path synthetic workflow passes, no OpenAI credential/live test available. Compatibility table deliberately targets baseline until integrated evidence exists. Integration must add the final adapter recipe links/status when consolidating.

## Validation
- npm run typecheck: passed (Worker and web).
- npm run build: passed; public hostname unset so canonical/sitemap intentionally omitted.
- Relative-link check: 35 links across 10 changed documents; no missing targets.
- git diff --check: passed.
- Static Playwright rendering first could not launch missing expected Chromium 1243. Retry uses installed Chromium 149 (1228); initial exact-text locator timed out because summary includes a plus icon. Corrected locator checks summary text; desktop 1440×1000 and mobile 390×844 passed rendering, disclosure expansion and no horizontal overflow. Screenshots visually inspected at /tmp/openfon-launch-desktop.png and /tmp/openfon-launch-mobile.png. Static built UI with mocked signed-out API only, not Worker/voice evidence.
- No live provider calls, carrier calls, staging deployment, audio recording, marketing distribution or spending.

## Next action
Integration cherry-picks launch commit, refreshes baseline compatibility with final owners’ evidence and drives release review. Launch assets are complete; do not publish drafts or claim live audio acceptance.

## Provider contract follow-up
Read presets’ final persisted/API contract and realtime owner’s recipe on 2026-09-12. Added an explicitly incoming section to docs/providers.md with exact text preset URLs/models, independent STT/realtime configuration, model precedence, key retention/removal and owner-reported evidence. Added quickstart routing to it. Final provider commit ce62114 and realtime implementation 13f037b (helper 18d3638) received; updated docs with final owner-reported unit/browser/runtime results. Baseline claims remain intact pending consolidation and no live-provider success is inferred. Launch did not rerun the other owners’ tests. Integration should resolve the incoming/baseline distinction when consolidating final commits.

Follow-up validation: relative links in docs/providers.md and docs/quickstart.md resolve; git diff --check passed. Documentation only, no repeat application suite needed.
