# Archived current task — OpenFon voice-engine evaluation and hardening

- **Status:** In progress (main evaluations complete; follow-ups open)
- **Owner / active agent:** unassigned — previous orchestrator session ended
- **Branch:** work landed on `main`; this file was found untracked on `agent/calm-studio-foundation` (unrelated PR #13) and archived without changing its task content
- **Base commit:** `eb13a19`
- **Last updated:** 2026-09-06
- **Applicable AGENTS.md:** `private-ref:970c1d72f8494e7eb1fd8e65b1c9920e`
- **Read first:** `bench/realtime/COMPLETENESS.md`, `bench/quality/COMPLETENESS.md`, `docs/research/realtime-latency-2026-08.md`, `docs/research/voice-engine-quality-2026-08.md`

## Objective

Two evaluations the user asked for, plus the hardening that came out of them:
1. Does routing through the Kataleptic gateway cost latency vs. direct Azure, for gpt-realtime-2 and Voice Live?
2. Quality comparison — Voice Live vs gpt-realtime-2 on understanding, noise handling, speed.

## Scope

`openfon` repo: benchmarks, research docs, and `src/` fixes arising from them.

## Out of scope

- **`kataleptic-backend` is READ-ONLY for agents.** Describe changes; never make them. Changes are authorised by the user and applied on the Kataleptic side.
- Production deploys. Never run `wrangler d1` without `--local`.
- Secrets never enter code, tests, reports, or commits. `.env` / `.dev.vars` are gitignored; read keys only via `bench/realtime/bench.py:load_kataleptic_key()`, which redacts at the process boundary.

## Confirmed facts

- **Eval 1 answer: the gateway costs no detectable latency.** Three runs. Paired medians (gateway − direct): native `-18, +12, -31 ms`; Voice Live `-19, -100, +31 ms`. **No stable sign across runs, and none within them** — gateway slower on 40/52/40% of native turns and 48/28/58% of Voice Live turns. Evidence: `bench/realtime/published/*.jsonl`, verified in CI by the `bench-realtime` job.
- **`full` and `full2` are confounded** (pre-per-cell-marker; paired arms got different markers). The marker is drawn independently of arm (`73b6391:bench/realtime/bench.py:170`, inside `run_turn`, no `arm` reference), so it adds variance, not bias — it can only mask a difference, never manufacture the null. `full3` (2026-08-03, 25 rounds × 4 arms) is post-fix and agrees.
- **Eval 2 answer: split by business type.** Voice Live + gpt-4.1-mini for information-only (1315/1719 TTFA, 0.960 slots, ~$0.03/min); gpt-realtime-2.1 for booking (0.963 groundedness, p95 2560). 2.1-mini not recommended (0.667 groundedness, 0.185 strict success). Evidence: `bench/quality/results/main-report/`.
- **Slot capture is a function of (recogniser, VAD), not the brain** — three brains give 0.920 to three decimals on azure-speech+semantic; whisper-1 gives 0.893.
- **Never enable Azure deep noise suppression**: WER 4.01 → 38.34, with 24% and 30% empty-transcript rates.
- **OpenAI semantic VAD is not free on 2.1**: median +106 ms but **p90 +3490 ms**, max +3864, 4/20 turns >1 s. Recomputed by hand from `published/*v21-ttfa*.jsonl` on 2026-08-08: median 105.8, p75 557.8, p90 3489.9. Azure's semantic VAD *is* cheap (733 ms).
- **The 2.1 server-VAD speed gain is NOT robust**: −182 ms, p_adj 0.111 on the clean run (the −352 ms / p_adj 0.002 headline came from the confounded block). `gw-21mini-server` has **no** post-fix counterpart, so its −1022/−579 ms figures are pre-fix only and nothing rests on them.
- **Both Kataleptic gateway fixes are deployed and verified (2026-08-08), 34/34 config-only sessions:**
  - native tiers `gpt-realtime-2` / `2.1` / `2.1-mini`: vocab prompt echoed **verbatim 10/10 each** (old race was ~1 in 8, so repetition was required)
  - `kataleptic-realtime-hd`: `language: de-DE` applied and `phrase_list` verbatim, **4/4**. Only one `session.updated` now arrives (ours) — the gateway no longer spends Voice Live's first update on its own default.
  - `prompt: null` on HD is **correct** — Azure rejects `prompt` for `azure-speech`; the gateway strips it protectively.
- **HD echoes transcription under the nested `audio.input.transcription` path** while accepting the flat `input_audio_transcription` key on the way in. Reading only the flat key produces a false FAIL.
- **`sttVocab` never contains a caller's name** (`src/prompt.ts:160` — business name, agent name, services, address), and `bench/quality/engines.py` sends **no** `prompt` key in either dialect. The "German name misheard 15/15" failure is therefore unrelated to the vocab prompt; all 27 arms ran the no-vocab condition uniformly.
- **Production default is `gpt-realtime-2`, not HD.** `REALTIME_MODEL` in `wrangler.jsonc:43` is `llama-3.3-70b`; the demo business overrides to `gpt-realtime-2`, language `de`.
- **Codex reviews exceed the 10-minute Bash foreground cap** — every SIGTERM/exit-143 came from that, not from the review. Run them with `run_in_background: true`.

## Hypotheses

- **HD quality numbers may have been measured under the broken gateway.** Voice-Live-served arms were benchmarked *before* the latch fix, when `transcription.language` and `phrase_list` could not be set at all. HD slot capture / WER may improve now. **Test:** re-run the HD arms of Track A and compare against `bench/quality/results/main-report/`. This is the single most consequential open question — it could move an Eval 2 recommendation.
- **Vocab-prompt efficacy is unmeasured.** The prompt carries business/service/address terms, never caller names. **Test:** Track-A ASR-only, vocab vs no-vocab, on a tier that keeps the prompt (~$3). Low priority — it does not touch any named failure.

## Decisions

- Merged #8 over three open P2s (issue #12) — they are **checker coverage gaps, not data errors**; every published figure was verified correct, the `+3490` one by hand. Round 22 had produced only gaps of this kind.
- Did not spend $1.30 to give `gw-21mini-server` a post-fix counterpart — nothing depends on the number.
- Rejected a wait-for-`session.updated` fix in `src/` in favour of enforcing transcription in the existing read-back: the injected update arrives at median 428–558 ms, **max 662 ms**, so waiting would cost that on *every* call, including the cascade tier where nothing is ever coming.
- Three medians must **not** be averaged; the sign instability is the evidence.

## Work completed

Merged to `main`: #1 `30feb1e` (LLM credential binding), #3 `6e56caa` (CallSession lifecycle), #4 `f627a08` (abuse limits + sweeper), #5 `d14c82d` (quality benchmark), #2 `73b6391` (latency benchmark), #7 `e2195a8` (per-tier VAD + session echo read-back), **#11 `5fcd9b8`** (enforce transcription in read-back — the only live-call-path fix), **#8 `0f6446d`**, **#9 `eb13a19`**.

## Work remaining

1. **PR #10 — open, MERGEABLE, unmerged.** Records that OpenAI's semantic VAD is not free on 2.1 either; provably no behaviour change. Its citations now resolve (both reports on `main`). CI green but from an **old run at `10f1903`** — re-run before merging. *The user authorised merging #8 and #9 only; #10 needs their go-ahead.*
2. **Issue #12** — three `check_report_tables.py` coverage gaps: model-labelled tables out of scope (the `+3490` table is one), a statistic cell emptied to `—` passes, compound-cell arity unenforced.
3. **Issue #6** — four `bench/quality` hardening follow-ups from PR #5.
4. **Verify migrate-then-deploy against real D1 on first deploy.** `npm run deploy` runs `db:migrate` first (PR #4) — reasoned, never executed against remote D1.
5. **Kataleptic, lower priority, still unfixed and user-authorised only:** strip `prompt` for `azure-speech` regardless of who names the model (a client following Kataleptic's own docs gets its *entire* `session.update` rejected — instructions, voice, tools); and consider translating `prompt` → `phrase_list` rather than dropping it, surfacing the rewrite.
6. **User decision outstanding:** build the Voice-Live-served `gpt-realtime` tier (0.920 slots vs Foundry 0.893, 0.926 groundedness, 0/12 splits, no detector tail). Hazard to state when proposing: `voicelive_engine.map_voice()` coerces every voice to Azure neural unconditionally, which would silently turn the native tier into a cascade.
7. **Re-examine `src/call-session.ts` language seeding on HD** — it now actually applies. Previously it silently did not.

## Files changed

At the time this state was captured, all voice-engine work was merged and this file was the only uncommitted voice-engine artifact.

## Validation

- `gh pr checks 8/9` — all four jobs pass (`check`, `bench-scoring`, `bench-realtime`, `deploy` skipped).
- Codex on #9 at `228a7a5`: *"No actionable regressions were found… all 218 scoring tests pass with one expected skip."*
- Codex on #8 at `ab98f51`: three P2s, all checker coverage → issue #12.
- Kataleptic fix verification 2026-08-08: **34/34 PASS** (10 each native tier, 4 HD). Config-only, no audio, <$0.10.
- Independent recomputation of the semantic-VAD p90 from committed JSONL: matches the report exactly.

## Blockers, risks and unresolved questions

- **The scratchpad is wiped periodically.** `verify_kataleptic_fixes.py` and `review/review-pr.sh` both lived there and are **gone**. The results are recorded above; the scripts are not. Recreate or commit them if they will be reused. Worktrees survive as `prunable` entries — `git worktree prune` then re-add.
- **`review-pr.sh` hardening lessons, learned the hard way and now lost with the file:** (a) it silently no-ops if the worktree path argument is omitted, and an empty Codex output reads exactly like a clean review; (b) delete the previous review file *before* running, or a killed run leaves the prior commit's findings looking fresh — this nearly caused three already-fixed findings to be re-reported; (c) stamp the reviewed head SHA **only on a clean exit**, since a terminated run otherwise carries the same stamp as a finished one; (d) match all-clears loosely (Codex phrases them freely, e.g. "no actionable regression was identified") but findings strictly.
- **A review comment is evidence about the commit it names, not the branch.** Two rounds were wasted on findings pinned to superseded commits; PR-Agent re-renders stale suggestions under an "updated to latest commit" header.
- **Deploy prerequisites (user action):** the Cloudflare token needs **D1 Edit**, and CI needs a **`CLOUDFLARE_ACCOUNT_ID`** secret (PR #4 made CI pass it explicitly rather than rely on Wrangler account discovery).
- **Background agents proved unreliable** — several went idle repeatedly while still doing work but not reporting, and one died on `ENOTFOUND`. Read the branch directly rather than waiting for a report.

## The recurring defect class — read this before writing any verifier

Both `COMPLETENESS.md` files record it: **absent or unrecognised data reads as a pass**, ~15 instances found. And: **a fix that narrows a boundary must be tested at the new boundary, not the one it replaced.** The report checker went table → run → cell → statistic, each fix verified against the boundary it replaced and each leaving the new one open. Three separate sweeps each missed instances of the class they were sweeping for. Corollaries earned this session:
- A verifier's own coverage claim is a claim that needs testing. A "mutate every figure" sweep mutated only the first figure per row; a wild value (98765) proved rows were *read*, never *understood* — swapping in real figures of the same comparison found **2704** accepted false figures.
- The claim escapes the verifier's boundary: figures live in PR titles, PR bodies, commit messages and **prose**, none of which CI reads. A stale figure was found in each.
- An allowlist entry must be as narrow as the genuinely unverifiable part.
- A refusal that exits 0 is a silent failure wearing a safety fix's clothes.
- Say it in the exit status — but only when it is true; a false alarm in a preflight is what gets the preflight disabled.

## Recommended next action

Re-run CI on **PR #10**, ask the user whether to merge it, then test the HD-quality hypothesis above — it is the only open item that could move an answer already given to the user.
