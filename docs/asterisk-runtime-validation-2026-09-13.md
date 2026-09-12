# Asterisk revoked-route harness correction — 2026-09-13

Official report5649387055 correctly identified a stale harness expectation:
a disabled route is rejected before the authenticated D1 rate counter changes.
The previous counter-growth wait therefore cannot prove the rejected attempt.
No adapter, authentication, schema or deployment change was needed.

The revised harness originates a distinct `runtime-revoked` Local channel.
Its local proxy must observe a new handshake sequence for that call with HTTP401
before checking channel cleanup. Missing, old, unrelated or successful handshakes
cannot pass; zero channels before originate has started cannot pass either.
A test-only Worker entry wrapper observes rate-counter mutation statement
preparation/exec attempts and attaches the count to rejected responses. It writes
no audit rows, exposes no credentials, and is absent from the production bundle.
The harness requires exactly zero attempts and identical rate-counter rows.

Validation performed sequentially in the assigned slot:

- `node node_modules/vitest/vitest.mjs run test/asterisk-runtime.test.ts`:4/4 PASS.
  Negative cases reject absent/stale/wrong/successful handshakes and nonzero or
  missing instrumentation. Observer coverage includes a rejected SQL attempt
  with no successful mutation, distinguishing attempts from row snapshots.
- `OPENFON_TEST_PORT=8811 OPENFON_INSPECTOR_PORT=9251 OPENFON_ASTERISK_PROXY_PORT=8821 node scripts/asterisk-smoke.mjs --asterisk`:PASS.
  Real source-built Asterisk22.11.0/Linux aarch64 with actual Local channels and
  WebSocket client, local workerd/D1/DO, synthetic provider only.
- Revoked attempt:sequence2,call `runtime-revoked`,HTTP401,rate-write attempts0;
  counter rows unchanged, no additional call row, zero active channels afterward.
- Normal call:completed/connected/released,3 persisted synthetic transcript turns;
  real caller tone reached960-byte PCM24 input. PBX assistant recording18,560 PCM
  bytes,peak7,932,measured440Hz amplitude7,981. ANSWER1,MARK_MEDIA11,FLUSH_MEDIA1,
  HANGUP1; actual PBX MEDIA_MARK_PROCESSED11.
- Fixture process exited0 after cleanup. `docker ps -a --filter name=openfon-asterisk-`
  returned no fixture containers; `lsof` showed no listeners on8811/9251/8821
  (exit1/no matches). Docker/image retained; no unrelated container changed.

This is new real PBX/runtime evidence with mocked AI/audio/transcripts. It is not
live provider, physical microphone, SIP trunk, PSTN, staging or production
validation. The original 2026-09-12 evidence remains unchanged and separately
dated. No broad suite or duplicate full-review inference was run.
