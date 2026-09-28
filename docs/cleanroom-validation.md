> Historical implementation evidence. The observations below predate the integration commit and restored account, setup-management and example workflows. Current-commit PR/CI checks must establish final integration status; these records do not establish deployment or live-provider acceptance.

# Clean-room rebuild validation

Date: 2026-09-27. Status: validated in the isolated local environment; independent functional/design review has no outstanding blocker. User acceptance and production rollout are separate.

This is the acceptance record for the new interface in `web/src/cleanroom`, reached directly from `web/src/main.tsx`. It supersedes the prior rejected remake as the current frontend candidate. Historical root `PRODUCT.md`, `DESIGN.md`, and `.impeccable` artifacts are explicitly marked superseded; their content was preserved. Current product authority is `web/src/cleanroom/PRODUCT.md`; the approved visual reference is `docs/brand/identity/index.html` and its `identity.css`, `DESIGN.md`, `guidelines.md`, and `voice.md`. Implementation guidance is `web/src/cleanroom/DESIGN.md` and `docs/cleanroom-design.md`. Backend behavior is specified in `docs/cleanroom-functional-contract.md`.

## Current Brand Identity redesign validation

The interface now follows the user-approved Brand Identity page: continuous blue masthead and hero, inverse approved logo, Lilita One display type, Nunito Sans body type, butter message slips and principles strip, open curved connectors, and paper reading surfaces. The workshop illustration and three-stage story remain below the hero. The same visual language covers authentication, introduction, reception desk, voice settings, knowledge, rehearsal, conversations, connections, and public calls.

- `npm run typecheck` passed for the redesign.
- `OPENFON_E2E_PORT=8792 OPENFON_E2E_INSPECTOR_PORT=9234 npx playwright test e2e/cleanroom.spec.ts e2e/openfon-story.spec.ts --reporter=line` passed **12/12 in 1.7 minutes** on the final layout and operational components.
- The real Worker conversation regression now opens/closes editor cues and crosses mobile/desktop breakpoints while connected. The existing call IDs, enabled End action, and unsent typed input survive keyed sibling relocation; the original conversation then ends and retains its transcript.
- The operational component reviewer reported `test/cleanroom-runtime.test.ts` **19/19 passed**. The earlier 2,004-test baseline remains historical evidence; the full suite was deliberately not rerun for this presentation change.
- Twenty-four settled captures cover twelve states at 1440 × 1000 and 390 × 844. All used `index-BFVZzXRq.js`; all had zero page errors, zero horizontal overflow, and no measured visible button/form control below 44px height. Both font faces reported loaded; display headings computed to Lilita One, weight 400.
- A separate 375 × 812 check confirmed document width 375px, a 44px workspace menu button, and working Messages & conversations navigation through that menu. At 1280 × 800, with the introduction visible and Who answers expanded, the enabled rehearsal action occupies y557.6–611.2px and remains visible without scrolling.
- Independent rendered review covered the welcome, auth, setup, desk, expanded voice/knowledge settings, active rehearsal, messages, conversation detail, callback visual fixture, fully loaded connections, and public call on desktop and mobile. No outstanding visual or functional blocker remained.

The canonical logo master `docs/brand/lilita-f-variants/4-straighter-stem-tight-spacing.svg`, reference primary logo, and served public primary logo are byte-identical (SHA-256 `35c1b3b60d7300fc6bae186463593a2bfa86536bd67202dd24b15490e14ec6a5`). The inverse reference/public assets match (SHA-256 `a020b9743475b8a08474822424c090eb95d472d310dc4d097837f7efef457fd4`) and share the primary geometry. Rendered image sources are `/brand/openfon-logo-inverse.svg` in the blue welcome masthead and `/brand/openfon-logo.svg` on paper. A final hash comparison of sixteen pinned reference, logo, favicon, and social assets found no changes from the pre-redesign baseline.

Screenshots and measured reports remain outside the repository in `/tmp/openfon-brand-redesign-qa/`: `{welcome,auth,setup,desk,voice-settings,knowledge,rehearsal,messages,conversation,callback-visual-fixture,connections,public-call}-{1440,390}.png`, `menu-375.png`, `app-report.json`, and `narrow-report.json`. The independent laptop check is `/tmp/openfon-brand-final-desk-expanded-1280.png`. The callback screenshot uses an explicit route-mocked visual fixture; it is not evidence of a persisted real callback request. The conversation itself uses the real local Worker with deterministic synthetic provider replies.

`npm run build` passed with 45 modules on the final candidate: `index-BvcKzpbY.js` and `index-CtX518uL.css`. The only change after the twelve-test run and twenty-four captures was metadata alignment plus the guest `document.title` branch. A final served-page smoke confirmed title and Open Graph title “OpenFon — A warm welcome. A clear next step.”, approved description, theme color `#2457c5`, and those final assets; `welcome-final-1440.png` and `final-metadata.json` record this build. `git diff --check` passed. Local review remains available on `http://localhost:8791`; health returned 200. No production deployment, remote migration, provider/carrier spending, PR, or commit was performed. Live-provider, physical audio, PSTN, and production acceptance remain separate in the launch documentation.

## Historical engagement-story validation

The guest welcome now explains owner work → business-informed conversation → actionable callback request. Signed-in owners get a compact, dismissible introduction; browser rehearsal and messages remain directly available. The story is explicitly illustrative, advances only on user input, and performs no authentication, provider or call writes. Media provenance and the authorized US$0.16 generation charge are recorded in `docs/openfon-media-provenance.md`; no video was generated.

- `npm run typecheck` passed for the final semantic implementation.
- `npm run build` passed, 44 modules. `index-BIfeC2-o.js`, `index-COLXJwD9.css` after the final CSS correction.
- `OPENFON_E2E_PORT=8792 OPENFON_E2E_INSPECTOR_PORT=9234 npx playwright test e2e/cleanroom.spec.ts e2e/openfon-story.spec.ts --reporter=line` passed all **12 tests in 15.7 seconds**.
- The final change from nested to a single main landmark was then checked by all **3 story tests, passing in 10.8 seconds**, including explicit single-main assertions for guest and signed-in views.
- Final contrast/disclosure CSS: targeted mobile story test passed **1/1 in 9.2 seconds**; all three stages have no horizontal overflow with reduced motion. Settled desktop/mobile screenshots were refreshed on the final assets. Computed styles confirm both essential example disclosures at 12px and corrected muted text at #5f708a (5.03:1 on white). Preview health returned 200 and served `index-BIfeC2-o.js`.
- The prior 2,004 unit/integration tests remain baseline evidence. They were deliberately not rerun for the image, markup and CSS changes; no headless runtime or backend behavior changed in this follow-up.

The story tests verify loaded image/alt text, exact source hours repeated in the answer, explicit example disclosure and callback outcome, keyboard Enter/Space and focus continuity, no story API writes, authentication entry, reduced-motion behavior at every stage, mobile overflow, persistent dismissal, direct call access within a 1280 × 800 viewport, menu access to the explainer, and preservation of an unsaved brief when navigation is declined. The first run exposed a real missing availability badge, which was restored; it also used the hidden mobile duplicate navigation CTA, corrected to the visible main CTA. Final results above cover both corrections.

Independent rendered review found and verified corrections to mobile image overlays and text spacing. The mechanic’s face, hands and ongoing work are visible; the caller question and answer remain accessible HTML. The local review identified no remaining functional or visual-story blocker.

### Engagement screenshots

Final screenshots are outside the repository under `/tmp/openfon-engagement-qa/`: `welcome-desktop.png`, `welcome-mobile.png`, `welcome-message.png`, `desk-desktop.png`, and `mobile-step-1.png` through `mobile-step-3.png`. Screenshots disable transition capture so they show settled content. The existing `/tmp/openfon-cleanroom-qa/` workflow screenshots were refreshed by the 12-test run.

### Impeccable review provenance

⚠️ DEGRADED: single-context (sub-agent spawn failed: agent thread limit reached)

The functional reviewer completed source/rendered assessment before viewing the detector. An additional media agent independently reviewed desktop causality and mobile crops, separately from functional/keyboard checks. The target slug is `web-src-cleanroom-openfon-tsx`; no critique ignore list exists. Cleanroom subtree PRODUCT.md and DESIGN.md are the authority; older root artifacts were not reused.

The CLI detector ran once against `Welcome.tsx` and `OpenFon.tsx` and returned `[]` (exit 0). Native browser access was unavailable in the subagent (IAB visibility unsupported; browser inventory lacked a Codex auth token), so the authorized Playwright fallback inspected the real local HTTP app. Browser mutation preflight and detector injection succeeded in fresh headless pages for all three story stages; no human-visible browser overlay is claimed. Overlay counts were 10/13/15 during entry animations and 14 on a settled final stage. Actionable contrast findings were corrected to #5f708a and checked via rendered computed styles (5.03:1 on white). Small metadata text and approximately 95-character caption lines were reviewed; the essential example labels were enlarged. The single-font advisory is intentional: one humanist sans family is part of the accepted cleanroom design contract. The temporary overlay server on port 8400 was stopped; pages were closed. No script tag was written into the app's HTML. Disposable E2E port8792 stopped automatically; the authorized user review preview8791 remains running. Evidence screenshots remain in `/tmp` intentionally.

## Historical cleanroom baseline checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed, Worker and frontend |
| `npm test` | Passed: 83 files, 2,004 tests |
| `npm run build` | Passed: 42 modules; `index-wzODqwMj.js`, `index-Cyd-wDz-.css` |
| `OPENFON_E2E_PORT=8792 OPENFON_E2E_INSPECTOR_PORT=9234 npx playwright test e2e/cleanroom.spec.ts --reporter=line` | Passed: 9 tests, 15.8 seconds |
| Final expanded-editor layout recheck (`-g 'portable recipes'`) | Passed: 1 targeted browser test after the CSS/class-only adjustment; Start button remains within a 1280 × 800 viewport |
| Preview health and asset check | `http://localhost:8791/api/health` returned 200; HTML references final JS asset |
| Independent rendered review | No outstanding blocker on the final asset, including provider/model-specific voice choices |

The nine new browser workflows cover account creation and setup; primary receptionist persistence across reload; unsaved edits surviving cue changes, declined navigation and a rejected save; unanswered knowledge drafts and deliberate publication; a real local Worker WebSocket conversation with typed fallback and durable turns; portable recipe export/review/apply without credential transfer; explicit public web activation and pause; saved text-provider checks and reusable voice setups; local draft voice sampling without saving or reserving a call; and preservation of edits typed during an in-flight save.

Some checks are combined in a single workflow. The independent reviewer additionally exercised summary dirty-state protection, partial provider-save failure with retained voice edits, complete recipe review, sample invalidation after voice/language edits, model-scoped suggestions, conversation details and mobile layout. A reported dropped-input issue was independently rechecked and retracted: the test's exact-text selector omitted the rendered speaker label; the actual call and transcript had succeeded.

Earlier browser runs found two locator mismatches caused by nested label text/options. The test selectors were corrected; the final nine-test run is green. Existing browser tests that assert the rejected navigation/editor arrangement were not broadly rewritten or claimed green. `e2e/cleanroom.spec.ts` is the current workflow coverage for the rebuilt app; the full unit/integration suite remains green.

## Rendered artifacts

Final-build screenshots were generated outside the repository:

- Desktop: `/tmp/openfon-cleanroom-qa/desktop.png`
- Desktop with expanded editor: `/tmp/openfon-cleanroom-qa/desktop-expanded.png`
- Mobile, 390 × 844 viewport: `/tmp/openfon-cleanroom-qa/mobile.png`
- Connections: `/tmp/openfon-cleanroom-qa/connections.png`

The desktop and mobile app were visually reviewed. The final visual-only adjustment keeps the call station compact while an editor expands; the targeted layout/recipe test was rerun on the final build. The earlier complete nine-workflow run and 2,004-test suite preceded only this CSS/class adjustment. The mobile test verifies that document width does not exceed the viewport. The fresh app imports no previous React components or styles. Reuse is limited to proven UI-independent voice transport, strict recipe serialization/parsing, and server language constants, behind `web/src/cleanroom-runtime`.

## Environment and evidence limits

The review preview remains running on `http://localhost:8791` with a disposable local database and deterministic local chat/summary provider. Carrier flags are disabled; pipeline synthesis uses browser speech. The automated browser run used a separately migrated disposable local database on port 8792 and shut its own server down afterward. No production deployment, remote migration, real-provider inference purchase, carrier call, PR, or commit was performed.

The tests establish real application persistence and protocol behavior with synthetic providers. They do not establish that a real Kataleptic/OpenAI/custom provider works, that physical microphone/speaker audio is audible, or that a telephone/PSTN call is accepted. Local voice-sample tests explicitly mock browser synthesis; server sample transport tests verify typed fields, binary handling and actionable failures. Dated model-routing evidence is not a new live-session verification. Existing launch-readiness and production-preflight records remain separate and were not changed by this validation work.

Successful saves refer to acknowledged server writes; failed or later unsaved edits remain drafts. A voice sample uses selected draft voice fields and saved provider connections. A full rehearsal uses saved assistant settings. An available public link is web availability only. A callback message is a recorded request for a human to follow up, not a completed callback or confirmed booking.
