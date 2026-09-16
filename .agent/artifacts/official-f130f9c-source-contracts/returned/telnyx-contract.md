# Disabled Bypass — unique f130 source-only contract

Status: owner assessment complete; integration routes independent QA. No correction or execution selected. Recorded 2026-09-16.

Frozen integration HEAD: `f130f9c56ad3c69e6679c69fc65cb45c2c25d98f`. Selection SHA-256 `b4898ab639ad7634d561ac1899c870aeac5f5dad22fb6f8b70b8b5b5653c5d83`; citation-map SHA-256 `ba5c4805e6b8638e47945cc968aa9a2ad5b92791bc0a9a21793255c7f98e2d6b`. Both independently read and matched. No prior f130 assignment receipt was found in the owned checkpoint/artifact search.

Read the retained original for [comment5692471142](https://github.com/duguetlabs/openfon/pull/16#issuecomment-5692471142), 13202 bytes, independently matched SHA-256 `e90c7c779a3a1de4813e05fa4c5333abc668b301948423a2be874513e84a89e3`. Public-body SHA-256 `025ba68dff2c2d95ff39f1b730c4200762232d27069527f8ecb4cee1b6b8d781` is attributed to the integration citation map; this turn did not repeat public readback. The original's 596 omissions and released official attempt remain unchanged.

## Exact source identities

All following files were independently read from the frozen integration commit and matched to its working bytes. The owner checkout was not used as current application source.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `src/index.ts` | 76784 | `7d21900e2bc6ace0af34c9b0b4f745eeb0f3285249f469575fd7eb6b31e5e9d4` |
| `src/telnyx-routes.ts` | 8299 | `2351a3bcdca548785d439ae32be2cdfb64be6148e1d1c03a681281b8b2d73c41` |
| `src/telnyx-webhook.ts` | 9092 | `fba2355f23073ae5fdaa2ae4f4d056cb4e27dca67c49dad18c7f3c15d66a97e5` |
| `src/telnyx-webhook-admission.ts` | 1925 | `fc043545b374aa6b6d378faf64a51006df6bfb9ebc752535dcaa62807c777e24` |
| `src/telnyx-control.ts` | 25052 | `00a3ae80f7c3f79e700a58e58548d8e70f4410b0eea175c0e860e12e9fee845c` |
| `src/telnyx-admission.ts` | 6408 | `259de6b3f8eb3d6787e1d6a7bce2e23fbca461fdcaf90a357ef1486335b2bc63` |
| `docs/telephony.md` | 10215 | `62f3ac9910d7f51623e3a4b602c3f43c753aa1d963fc099a6ef8dd26cabec871` |
| `test/telnyx-control.test.ts` | 61703 | `e72ab0cafde73700880f7483b3076e70c21edf54d3a7787cb015ae3c1587a7c9` |

## Current report premise and caller contract

The new wording correctly identifies that signed initiation can be dispatched while the flag is absent/false and that reserveTelnyxCall does not independently check the flag. Its inference that this permits disabled inbound reservation omits the actual caller. Searching the frozen src tree finds only the helper declaration and the call at telnyx-control.ts264. Immediately before it, line263 returns through end when already ending or TELNYX_ENABLED is not exactly true. No disabled-owner helper invocation was found on this public path. This is a caller-enforced contract, not a claim that the exported helper independently enforces the rollout flag or that any hypothetical future caller would be safe.

Public routes74-98 require the owner binding, verification public key and connection ID, acquire bounded webhook admission, verify the original body with Ed25519 and timestamp checks, enforce the expected connection, convert only supported control events and dispatch to the deterministic connection/leg owner. Initiation conversion additionally requires incoming direction and valid destination/caller fields. Signature verification remains active when disabled; the flag is not an authentication bypass. Public200 acknowledges a successful owner response and is not proof of reservation.

For enabled initiation, routes90 additionally requires telnyxConfigured, including API key and valid HTTPS public origin. If the helper is legitimately called, it first permits exact existing-link recovery without a new INSERT; otherwise current route/assistant/provider compatibility and conditional snapshot/quota predicates govern reservation and the immediately changes-gated link INSERT. Those config checks are distinct from the caller's flag check. This does not freeze configuration for the call lifetime or make rollout changes atomic with an already-started D1 batch.

## Existing, absent and queued owner states

- No existing control state, flag absent/false: owner300 returns204 before newState, inbox persistence or alarm scheduling. No reservation or provider command follows this event. Route200 therefore does not establish admission. Retired owners return204 at298 before recreation.
- Existing nonterminal state with no initiation yet: a correlated incoming initiation at261 marks initiationSeen, then the disabled/ending guard returns through end without calling reserveTelnyxCall. end205-211 removes answer/stream commands and permits a hangup for the now-observed incoming leg. It does not reserve a new call.
- Initiation already queued while enabled, consumed while the owner observes disabled: consume263 still refuses reservation. A new route gate cannot remove this already-persisted event or replace the consume guard.
- Existing admitted owner: tick354 enters ending before new answer/stream planning at364. Ending closes the bridge and preserves existing reason/failure rules; hangup/status cleanup can continue. Already-dispatched operations are a separate in-flight case, not recalled by this flag check.
- Existing observation-only owner with neither initiationSeen nor admitted: tick360-362 clears commands and expires its reorder state at the setup deadline without commanding an unowned leg. Terminal cleanup and durable retired marker preserve replay protection.

## Initiation-only proposal, assessed separately

Unlike the prior blanket availability guard, an initiation-only gate need not block signed call.hangup callbacks. That old blanket-guard objection is not used as the reason to reject this proposal. The claimed disabled-reservation exploit is unsupported because the sole current caller is guarded.

There is also a concrete source-level behavior difference to preserve: an owner can already exist from a supported out-of-order observation accepted while enabled, with admitted=false and initiationSeen=false. If the flag is then disabled and a signed incoming initiation arrives, the current route lets the owner recognize the incoming leg and plan hangup without admission. A gate that acknowledges and discards that initiation removes that transition; the observation-only owner can instead expire without issuing hangup unless a separate terminal event arrives. A rejecting gate has different provider-redelivery consequences, which are not specified or proved here. Neither case is a selected policy change. This is a source-derived schedule, not a newly executed fixture or a guarantee about provider delivery/billing.

A route gate likewise does not stop initiation already queued or reservation/commands already authorized under an enabled owner. There is no source evidence requiring the proposed gate to enforce the existing no-new-admission contract. Recommend qualified decline of the admission/security inference and no correction under this assignment, subject to integration's aggregate independent QA. Do not claim that filtering initiation can never be a deliberately selected policy; it would need an explicit draining/retry contract.

## Terminal/status drain and retained limitations

Existing-event correlation is checked at owner302; inbox deduplication/capacity remain. consume249 processes signed hangup before the terminal guard; confirmEnded236-246 marks terminal, clears commands/token and records carrier release/link state. Terminal cleanup340-351 later compacts to the durable retired marker. A successful hangup command alone does not prove release: retry/status handling391-406 retains capacity until a signed terminal event or authenticated matching control/leg/session response with is_alive=false. Missing/mismatched/ambiguous status and404 are not release proof. Late results only merge with a still-present matching command identity397. The scheduled sweep wakes owners; it does not independently release an unconfirmed leg. docs/telephony.md129-133 explicitly retains disabled cleanup.

Media route114 and owner461/487 check the flag for claims/installation. This does not promise instantaneous shutdown of existing media, atomic cross-deployment flag observation, cancellation of an already-started reservation/provider request, immediate carrier drain, zero billing, or no D1/DO/provider work while disabled. Missing owner/public-key/connection bindings prevent terminal ingress; missing API key prevents command/status drain. Existing no-state disabled handling does not actively hang up every externally offered carrier leg. Provider outcome and request/confirmation uncertainty remain.

Pre-auth body/crypto/owner dispatch consume bounded application resources even while disabled. The existing sixteen isolate leases,128KiB/read-work/five-second body limits and full-route/consume/cancel/lock release policy remain; cleanup failure or lost context can strand capacity. No global/TCP/availability guarantee or reinterpretation of prior native2PASS2UNAVAILABLE follows. Reason/finalizer/timing/admission/lease evidence and all original failures, rebuilt-runtime and cleanup limitations remain preserved. Existing test559's disabled-terminal/fresh-owner assertions are source context only; no f130 test or new native/live evidence is claimed.

## Delivery boundary

Only this owned documentation receipt is newly written. No application/fixture preparation, source/policy/dependency change, imports/tests/types/SQL/native/browser/inference/publication or runner was performed. No separate QA message: integration receives this receipt once and owns aggregate QA routing and any later correction/publication decision. Frozen source and preexisting owned dependency state remain intact.
