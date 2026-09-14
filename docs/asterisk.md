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

Use a local Docker Desktop daemon (macOS or Linux), or a local rootful Docker
Engine on native Linux, then from the repository root run:

```sh
docker build -t openfon-asterisk-runtime:22.11.0 examples/asterisk/runtime
node scripts/asterisk-smoke.mjs --asterisk
```

The Dockerfile builds the pinned official Asterisk source and checks its SHA-256.
The harness gives its container a random `openfon-asterisk-<pid>-<invocation>`
name and an invocation label. It verifies that label and the full container ID
before exec, logs or removal; those commands target the immutable ID. A failed
run may have created a container, so recovery checks only that invocation's name
and label before binding cleanup to its ID. A pre-run failure performs no
container lookup. Failed ownership verification or removal reports uncertainty;
there is no unchecked name removal or prefix sweep. Fixture config and recordings
are temporary. It exposes no SIP ports. Asterisk Local channels
play a generated 660 Hz caller tone, while the mocked AI sends a 440 Hz response;
MixMonitor and signal checks verify the response in the real PBX. A transparent
local WebSocket proxy counts actual commands/acknowledgments without modifying
the adapter. It also verifies revoked-route rejection and zero remaining PBX
channels. Temporary audio is deleted after validation.

Ports default to Worker 8811, inspector 9251 and capture proxy 8821. Override with
`OPENFON_TEST_PORT`, `OPENFON_INSPECTOR_PORT`, and `OPENFON_ASTERISK_PROXY_PORT` for
concurrent work. `OPENFON_ASTERISK_IMAGE` selects another locally built image.
The proxy and Worker remain bound to host `127.0.0.1`. Docker Desktop uses its
`host.docker.internal` forwarding. Native Linux Docker Engine uses
`--network=host` and connects directly to `127.0.0.1`; a bridge `host-gateway`
DNS mapping alone cannot reach a loopback-only listener. The native Linux fixture
shares the host network namespace; it runs only the generated Local-channel PBX
configuration, with SIP/IAX modules disabled, and publishes no ports.

The harness resolves `DOCKER_CONTEXT` first, then `DOCKER_HOST`, then the saved
context. It pins that Unix-socket endpoint for daemon inspection, image inspection,
container startup, commands, logs and cleanup, so a later default-context change
cannot redirect the fixture. Build the image on that selected local daemon before
starting the harness; runtime startup requires the image there and never pulls it.
The daemon's Docker Desktop identity, not its Linux kernel/OSType alone, selects
the Desktop connection path.
Only a local Unix-socket daemon on the machine running the harness is supported;
Detectable TCP/SSH endpoints, rootless native Engine and non-Desktop daemons
on non-Linux hosts are refused. Other VM runtimes and forwarded Unix sockets are
unsupported topologies, not reliably detected by this check. The operator must
ensure that the bind-mounted fixture files and host loopback belong to the
machine running the harness; a Unix endpoint alone does not establish locality. No Docker
Desktop host-networking setting is required or changed. Recorded real-PBX
validation was on macOS Docker Desktop; the Linux connection mode is not itself
evidence that the PBX smoke passed on Linux.

The fixture-only Docker-to-host hop uses plain WS with a synthetic password;
production configuration continues to require verified WSS. The test does not
use a real AI account, microphone, SIP trunk, telephone number or PSTN carrier.

### Authentication resource bounds

Before route lookup or PBKDF2, each Worker isolate has one constant-size budget:
16 starts initially, replenished at two per second, with at most four concurrent
checks. Invalid known-route attempts consume the same budget as valid ones.
Excess attempts fail authentication without database access, writes, durable
objects, attacker-indexed keys, or an in-memory wait queue. Database/KDF failures
release concurrency; they do not refund the attempt. Public ingress uses a separate constant-size budget with the same burst of 16,
2 starts/second and 4 in-flight bounds, held through authentication, workspace
preflight and the owner response. Excess ingress receives 429 without database
access. It creates no D1 rate counters or per-IP/route entries. After authentication,
a read-only workspace concurrency/daily-quota preflight rejects known-full
workspaces before creating/contacting a durable owner. This check is advisory:
the owner retains atomic reservation quotas and fresh credential-version checks
for races. A known-full public refusal returns 403, including duplicate attempts;
when capacity is available the owner still rejects replay with 409. The preflight uses the owner's occupied-call and rolling-day rules;
released calls still count toward the daily quota, while unreserved/unconnected
abandoned calls do not. The public route is the sole PBKDF2 verifier and consumes one budget start.
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


### Admission configuration changes

Asterisk validates realtime eligibility and direct OpenAI model/voice compatibility,
then conditionally reserves against the same route assignment, credential and
provider/assistant compatibility fields. A change before the reservation commits
returns a generic rejection without creating a call or starting CallSession; the
PBX call identity is retired to prevent replay. Start a new PBX attempt after the
configuration settles. Quota and active-assistant checks remain atomic with that
reservation. This is an admission boundary, not a frozen per-call configuration:
CallSession reloads settings at pickup and performs its normal provider/audio
startup checks. Configuration edits after reservation can affect that startup.
