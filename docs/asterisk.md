# Inbound Asterisk integration (experimental)

OpenFon can receive an authenticated Asterisk `chan_websocket` media channel.
Asterisk terminates your existing SIP/RTP connection; OpenFon remains a Cloudflare
Worker with D1 and Durable Objects. No extra Node gateway is required. This is
inbound only and does not provision trunks, numbers, outbound calls or transfers.
Keep `ASTERISK_ENABLED=false` until your installation passes a real PBX pilot.

## Versions and protocol

Use Asterisk **20.18+, 22.8+, or 23.2+** with `chan_websocket` and
`res_websocket_client` loaded. Earlier chan_websocket versions lack the required
JSON control format. The adapter requires `c(ulaw)nf(json)`: mono G.711 μ-law,
8 kHz, 160-byte/20 ms frames. It converts this to/from CallSession's 24 kHz PCM16
using the same stateful FIR converters as Telnyx. Asterisk paces output; playback
marks acknowledge audio, FLUSH_MEDIA cancels queued speech, and XOFF/XON controls
sending. Local and unacknowledged output together are capped at 10 seconds.

Protocol and configuration verified against official documentation on 2026-09-12:
[Asterisk WebSocket channel driver](https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket/)
and [websocket_client.conf sample](https://github.com/asterisk/asterisk/blob/master/configs/samples/websocket_client.conf.sample).

## Configure an existing installation

1. Apply migrations through `0011_asterisk_inbound.sql` to your chosen database.
   Preserve migration 0010 for provider configuration when integrating the release.
   Deploy the Worker with the `ASTERISK_CALL` binding / `AsteriskCall` class and
   Durable Object migration v3 from wrangler.jsonc. Follow your normal backup,
   staging and deployment process; these instructions do not deploy automatically.
2. Configure and activate a realtime assistant. Telephone audio requires a working
   realtime provider and server-generated greeting audio; browser speech synthesis
   cannot serve this route. The existing CallSession checks apply.
3. Apply migration `0014_asterisk_credentials.sql` before deploying this adapter.
   It preserves route IDs and workspace/assistant assignments, disables every
   legacy route, and discards its fast SHA-256 verifier. **Existing routes require
   password rotation and explicit reprovisioning before they can be enabled.**
   Previously revoked routes remain disabled. There is no legacy-hash fallback.

   Create a unique route identifier such as `pbx` and generate a new random
   password (32–512 characters using only `A-Z`, `a-z`, `0-9`, `_` and `-`) in your secret manager.
   Provisioning and authentication enforce this configuration-safe token alphabet.
   Asterisk treats semicolons as comments; punctuation, whitespace and Unicode
   are rejected rather than relying on config escaping. Generate a fresh token
   using this alphabet; rotate any previously provisioned password outside it. Pass the password through
   stdin to `node scripts/asterisk-credential.mjs`, redirecting its output to a
   protected local file. Never pass the password as a command-line argument.
   The helper emits only a salted PBKDF2-SHA256 verifier: a fresh 16-byte salt and
   32-byte key, using 100,000 iterations, in the existing `src/auth.ts` format.
   Bind that verifier as `password_hash` in operator provisioning:

   ```sql
   INSERT INTO asterisk_routes
     (id,business_id,assistant_id,password_sha256,enabled,password_hash)
   VALUES (?, ?, ?, lower(hex(randomblob(32))), 1, ?);
   ```

   For an existing route, bind its new verifier and ID explicitly:

   ```sql
   UPDATE asterisk_routes
   SET password_hash=?, password_sha256=lower(hex(randomblob(32))), enabled=1
   WHERE id=?;
   ```

   Update the PBX password to the same rotated secret. The old `password_sha256`
   column remains only for deployed-schema compatibility and contains a random
   placeholder; never store a password digest there. Authentication reads only
   `password_hash`. A null verifier is permitted only while a route is disabled.
   Do not bulk re-enable migrated or previously revoked routes.

   The composite foreign key requires the assistant to belong to that business.
   A route credential authorizes only this assignment. Do not use caller-supplied
   phone numbers to select a workspace. The authenticated PBX is trusted to admit
   only your intended inbound calls. Revoke a credential by disabling its route;
   rotate by replacing its salted verifier and PBX configuration. Existing calls end at their
   normal hangup/duration limit; route revocation prevents new calls.
4. Copy the relevant sections from
   [websocket_client.conf](../examples/asterisk/websocket_client.conf) and
   [extensions.conf](../examples/asterisk/extensions.conf) into your PBX. Replace
   the hostname, route username/path, and password locally, protecting the file
   with mode 0600. Use WSS and keep certificate and hostname verification enabled.
   Do not put passwords in dialplan URLs, logs, version control or SQL history.
5. Reload Asterisk configuration and verify the modules with `module show like
   websocket`. Enable `ASTERISK_ENABLED=true` on the Worker. Route a test inbound
   extension/trunk to `s@openfon-inbound`; keep your main business number unchanged
   until the pilot is verified.

`call` uses Asterisk's generated UNIQUEID, with a PBX prefix if multiple systems
share a route. Reusing a call ID is rejected, including after hangup. HTTP Basic
credentials travel only in the upgrade Authorization header. Admission atomically
checks active realtime assistant state and workspace daily/concurrent limits.
The shared telephoneRealtimeAvailable resolver checks the selected provider key
and greeting capability before reservation, including workspace credentials.
Browser call routes cannot attach to Asterisk calls. The PBX receives only media
and control commands, never transcript/tool metadata.

## Failure behavior and validation

A malformed MEDIA_START fails closed before answering/inference. Input before
provider readiness is discarded. Missing startup fails after 20 seconds; missing
final playback acknowledgments fail after 12 seconds. The durable owner enforces
30 minutes and closes both sockets on errors. chan_websocket closes its channel
when the media websocket closes; the dialplan then hangs up. Keep the PBX absolute
timeout and ping/pong checks enabled as independent protection against network
partitions. A recovered owner releases the D1 reservation and retires a lost
session. Unlike Telnyx, there is no independent paid carrier leg controlled by a
separate HTTP API after the websocket ends.

Run `npx vitest run test/asterisk-media.test.ts` and
`node scripts/asterisk-smoke.mjs`. The latter uses real local workerd, D1 and Durable
Objects with a **simulated PBX and AI provider**, default ports 8811/9251 (override
with OPENFON_TEST_PORT / OPENFON_INSPECTOR_PORT), and blocked
external provider requests. It is not an Asterisk or PSTN pilot.

Real pilot checklist: record PBX version/loaded modules, route/assistant IDs (no
credentials), commit, and time; call from a consented SIP endpoint; hear greeting,
ask a question, interrupt speech, request a message, hang up from each end, check
saved transcript/summary and reservation release. Repeat disabled/wrong credential,
paused assistant, full concurrency, provider failure, PBX disconnect and network
loss. Use `channel originate Local/s@openfon-inbound application Echo` only for a
local PBX smoke, with no external trunk. Confirm no remaining channels using
`core show channels`. No real PBX/provider/PSTN success is claimed by the synthetic
suite. A real local Asterisk 22.11.0 runtime test subsequently passed on
2026-09-12 after starting the installed Docker Desktop. See
[the runtime evidence](asterisk-runtime-validation-2026-09-12.md).


## Repeat the actual PBX runtime test

Start your installed Docker runtime, then from the repository root run:

```sh
docker build -t openfon-asterisk-runtime:22.11.0 examples/asterisk/runtime
node scripts/asterisk-smoke.mjs --asterisk
```

The Dockerfile builds the pinned official Asterisk source and checks its SHA-256.
The harness creates and removes only its own `openfon-asterisk-<pid>` container,
fixture config and recordings. It exposes no SIP ports. Asterisk Local channels
play a generated 660 Hz caller tone, while the mocked AI sends a 440 Hz response;
MixMonitor and signal checks verify the response in the real PBX. A transparent
local WebSocket proxy counts actual commands/acknowledgments without modifying
the adapter. It also verifies revoked-route rejection and zero remaining PBX
channels. Temporary audio is deleted after validation.

Ports default to Worker 8811, inspector 9251 and capture proxy 8821. Override with
`OPENFON_TEST_PORT`, `OPENFON_INSPECTOR_PORT`, and `OPENFON_ASTERISK_PROXY_PORT` for
concurrent work. `OPENFON_ASTERISK_IMAGE` selects another locally built image.
The fixture-only Docker-to-host hop uses plain WS with a synthetic password;
production configuration continues to require verified WSS. The test does not
use a real AI account, microphone, SIP trunk, telephone number or PSTN carrier.

### Authentication resource bounds

Before route lookup or PBKDF2, each Worker isolate has one constant-size budget:
16 starts initially, replenished at two per second, with at most four concurrent
checks. Invalid known-route attempts consume the same budget as valid ones.
Excess attempts fail authentication without database access, writes, durable
objects, attacker-indexed keys, or an in-memory wait queue. Database/KDF failures
release concurrency; they do not refund the attempt. The existing authenticated
D1 admission limit still runs only after successful verification. The public route is the sole PBKDF2 verifier and consumes one budget start.
It constructs a new request through the AsteriskCall binding with a version of
the verified route assignment and salted credential; it never forwards the
caller's admission header or password. The owner performs a fresh enabled-route,
assignment and credential-version check before reservation, without PBKDF2 or
another budget charge. Disabling, reassigning or rotating a route invalidates an
in-flight handoff. This internal version is not a public authentication token:
`/media` is reachable only through the private binding, not public routing.
Do not expose a pass-through endpoint to that binding.

This is an isolate-local CPU/concurrency bound, not a global distributed rate
limit: isolate creation/restart replenishes its budget. An attack can exhaust
local authentication capacity and temporarily deny legitimate PBX connections.
For exposed deployments, apply operator-managed edge/network restrictions for
trusted PBX egress as well; this code does not create or configure those policies.
The budget holds no per-IP/route entries and needs no persistent cleanup.

Config syntax source: [Asterisk22.11.0 main/config.c](https://github.com/asterisk/asterisk/blob/22.11.0/main/config.c)
uses semicolon as COMMENT_META and strips it during config parsing.
