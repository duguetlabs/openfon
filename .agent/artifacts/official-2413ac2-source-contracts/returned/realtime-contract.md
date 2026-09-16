## CURRENT — exact 2413ac2 Protocol Break, source-only compatibility contract

Root653a7f5 selection SHA256 a0b32c894f59f8c17c49b1f9848320e6d6aa5cf97b58e9af1a3719e75f050b66 and citation-map SHA256 606f8c4126bddcf39ec199ddeef943eb6cdfedeeb67fca0a00d4c187c05928e1 uniquely assign this owner. No prior2413 receipt existed in this checkpoint. Read unchanged original5683817963, SHA256 59caa88d5f9d5fd9e49d7477d10d2d95be4a4610684b142f8a1ac796afcf1fba, 9637 bytes. Integration HEAD is frozen2413ac285754202c791178d4bf713a50116d8acc; all18 inspected paths below are committed=working. Owner HEAD remains a6d33fe7e81c4166c6a9e5d98f812f7d8fefc331, with earlier dirty source/dependency snapshots preserved and excluded as application baseline.

Disposition: the report's older/cached-client premise is source-supported, not disproved by the current browser's ACK implementation. It does not allege the shipped current browser lacks that handler. A pre-receipt client retaining its old implementation and starting a realtime call against this server sends start without any capability/version assertion; if it ignores new markers, admitted output accumulates until the oldest10second deadline or128-write/960000-byte window fails the call. Initial playback is possible for an older implementation that accepts the binary and ignores unknown JSON; not every arbitrary legacy client is guaranteed to play first. No deployed stale-client incident or actual cache response was probed. This is a real mixed-version compatibility limitation already disclosed by the retained protocol policy, not a new unbounded-output defect or evidence that current matching clients omit ACKs.

Actual protocol: CallSession447–451 validates audio_received through the per-call FIFO receipt object. sendReady500–507 advertises audioReceipts:true for realtime. sendRealtimeAudio1358–1367 and sendRealtimeControl1369–1384 always reserve output before binary/control plus a fresh random post-payload marker; neither consults a client opt-in. Browser onopen sends only start, as do both carrier adapters. Ready is one-way activation of strict receiver framing, not two-way negotiation or proof that the peer supports it. The docs' phrase "Negotiating receivers" does not create such a handshake. Generic ready/transcript/ending JSON is not itself sent through the receipted control helper.

Shipped browser: Widget96/start and Studio242/connect both instantiate VoiceCall. Its current same-socket handler141–180 checks ended/stale socket, admits PCM into bounded playback, validates one pending binary/control and matching marker, then sends audio_received. Ready183 enables receipts. Receipt acceptance does not free playback accounting: playPcm353 onward retains at most960000PCM-equivalent bytes and400nodes, including suspension; actual ended or explicit flush/discard releases buffers, with Set.delete protecting late callbacks. Current-client/new-server support is established by source; new-client/old-server legacy framing is retained when ready omits the flag. These are not guarantees for every historical protocol variant or provider event ordering.

Carrier contract: Telnyx session bridge296–327 and Asterisk control153–180 force arraybuffer and route adapter receipts back over the same internal CallSession socket with open/backpressure guards. Telnyx193–210 and Asterisk87–106 validate the pending pair and ACK after bounded conversion/queue admission. Telnyx refuses pre-ready PCM; Asterisk retains paired pre-ready compatibility and clears only legacy pairing on first valid receipts-ready. Neither carrier needs to echo internal receipt tokens. Their separate MediaOutputDebt holds up to500 sent media/control+mark pairs across flush generations; local flush and internal ACK do not free this debt. Exact returned carrier mark/barrier proves ordered transport progress/discard, not physical playback. External carrier protocol compatibility is distinct from mixing an old internal adapter with a new CallSession.

Bounds are mandatory retained constraints: max128pending output writes, max960000payload bytes, exact oldest ID before10seconds; sent independently rechecks capacity. No time refill, flush reset or ordinary upstream replacement frees receipt credit. closeUpstream clears it on terminal/failure teardown. Global audio/event/response admission, receiver buffering and carrier debt remain independent. Disabling receipts merely because a client omits opt-in would remove the Workers output bound; no such waiver, unsupported WebSocket API, new negotiation or policy change is selected.

Cache/rollout evidence: package.json deploy runs build, migration and wrangler deploy; vite.config.ts builds web into dist/client. wrangler.jsonc serves that asset directory as an SPA and runs the Worker first for /api/* and /ws/*. web/index.html loads the application entry; site-metadata only adjusts public metadata/sitemap. In inspected src/web/build configuration there is no application service-worker registration, client-version comparison, receipt capability exchange, reload gate or custom static-asset Cache-Control/_headers file. The no-store middleware in index289 applies to selected private API paths, not to HTML/JS freshness. No build, generated asset inventory, response headers, CDN behavior or deployment was examined. Even content-addressed assets/revalidation, if provided by the build/platform, would not prove an already-loaded old page was replaced. Same-build packaging is rollout intent, not proof every loaded client upgraded.

Retained docs explicitly say new servers require receipt-capable consumers, old browsers/custom bridges fail at the window/deadline, and matching browser/adapters must deploy together. Thus a qualified policy disposition can retain unsupported old clients while acknowledging the reported behavior. It cannot assert backward-compatible negotiation or claim cache invalidation eliminates it. If supporting old loaded pages or rejecting them before output is newly required, integration must select that rollout/version contract separately while preserving bounded admission; this assessment neither selects nor prepares a correction.

Read current voice-client bounded receipt/admission/suspension/teardown test bodies and realtime-output budget controls only. No discovery/import/test/type/native/browser execution or new pass attribution. Prior owner runtime remains historical, not mixed-version rollout proof. Original574 omissions (50listed+524additional), rebuilt132 versus former binary identity, unknown failed2926 discarded-stderr cause, Piper43PASS1FAIL versus separate6PASS, gateway and all previous evidence limits remain unchanged. Integration receives this contract only and routes independent pK audit once; no separate QA dispatch, publication or new agent.

Exact SHA256 identities, committed=working:

| Path | SHA256 |
| --- | --- |
| src/call-session.ts | 8c884f8a6f39d7db83b22ff40eb9d0233436eb0391866b0701a7a09c2d18b413 |
| src/realtime-output.ts | b0174aa67bbd646915c66136c69d211da6b36b480c065b84d2a3f72a75304c6d |
| web/src/voice.ts | 9783d4bc29e2a62048fa543423c6b7da368b596e334403755d3f3a531ea05636 |
| web/src/pages/Widget.tsx | cde3e8eca7c283773160e70c85a391b1ef1ed7a48681c788bed8c2e75bce717a |
| web/src/pages/Studio.tsx | 23ebbb9cae00b8640609dd0947f5fdc8f50d0fb5b3a5f75779bacb2982a8be8e |
| src/telnyx-media.ts | e34f6146cf35e17f3bbc76baec61e2b647f8aa3e668bc8b8146dcd9dc6a59740 |
| src/asterisk-media.ts | 89b7448be299211ec7a016e96b4cdc0be58b4640f7cf501780c9888f1be2a583 |
| src/asterisk-control.ts | f6e314bf97f70de409a0af56640bc73585a202a785f6377337183a39ac1a24d9 |
| src/media-output-debt.ts | c64be7586ab4b804fcb7158144e322a95061f0504fe080052475b1fabba8c5a4 |
| docs/realtime-output-bounds.md | c52618717b7ed7b8e93059566a7c4a2e18db7f057e5f31c0ca863d5e850fb1ed |
| src/index.ts | 7d21900e2bc6ace0af34c9b0b4f745eeb0f3285249f469575fd7eb6b31e5e9d4 |
| vite.config.ts | ffdfcaaf8fa02cf9fed6ec887f06667019b53a33b6a5a034043974e62e954ed2 |
| wrangler.jsonc | 0b23bfd315e432d084dec890c163228330c9528149b9bc7f9f36c15657a578ee |
| web/index.html | 103313bf182aeec6acdc1a7d7eb72a023e5e92b17c3090aef044a5146aa1afbe |
| package.json | baf608b541ac2f7667ec07e062975ac66d08b4201245412c0207e5951942b233 |
| scripts/site-metadata.mjs | 88bc5ecce5312d2fa0dd6500cf8f09fde79f0fa623660854b6cff8ccadc37fc9 |
| test/voice-client.test.ts | 7fd2717c8ebcab5169abc33bd47345faf56040a3d31e2a9e5b568fbb4b6f9418 |
| test/realtime-output.test.ts | 3bc917c1775c93b584680bbd7f0dc5f4e2fc4d34ce19a95d1ac7d586fbb4f182 |

