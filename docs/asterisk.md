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
3. Create a unique route identifier such as `pbx`, and a random password of at least
   32 bytes in your secret manager. Store only the lowercase hexadecimal SHA-256
   digest of the password in D1. Operator route provisioning (bind these values):

   ```sql
   INSERT INTO asterisk_routes
     (id,business_id,assistant_id,password_sha256,enabled)
   VALUES (?, ?, ?, ?, 1);
   ```

   The composite foreign key requires the assistant to belong to that business.
   A route credential authorizes only this assignment. Do not use caller-supplied
   phone numbers to select a workspace. The authenticated PBX is trusted to admit
   only your intended inbound calls. Revoke a credential by disabling its route;
   rotate by replacing its hash and PBX configuration. Existing calls end at their
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
Objects with a **simulated PBX and AI provider**, ports 8811/9251, and blocked
external provider requests. It is not an Asterisk or PSTN pilot.

Real pilot checklist: record PBX version/loaded modules, route/assistant IDs (no
credentials), commit, and time; call from a consented SIP endpoint; hear greeting,
ask a question, interrupt speech, request a message, hang up from each end, check
saved transcript/summary and reservation release. Repeat disabled/wrong credential,
paused assistant, full concurrency, provider failure, PBX disconnect and network
loss. Use `channel originate Local/s@openfon-inbound application Echo` only for a
local PBX smoke, with no external trunk. Confirm no remaining channels using
`core show channels`. No real PBX/provider/PSTN success is claimed by the synthetic
suite. This development host has no Asterisk executable and Docker's daemon was
unavailable at the 2026-09-12 check.
