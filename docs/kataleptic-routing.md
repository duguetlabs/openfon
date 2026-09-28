# Kataleptic model identity

OpenFon now preserves the selected model instead of substituting another one.
An unavailable or retired Kataleptic model produces an actionable configuration
error. Custom compatible providers retain their own model namespaces. Device or
Azure speech is a separate component from the text model: changing the reasoning
model in a pipeline does not change its voice.

## Deployment check: 2026-09-26, 22:54 UTC

A read-only check joined three independent pieces of evidence: the running
gateway's source revision, its effective nonsecret routing configuration and
Azure control-plane deployment metadata. No generation, customer call, remote
configuration change or carrier spending was involved.

| Requested Kataleptic model | Effective service | Actual Azure model | Version | Evidence |
| --- | --- | --- | --- | --- |
| `kataleptic-realtime-hd` | Azure Voice Live with Azure Speech | `gpt-4.1-mini` | Not established | Running gateway configuration only |
| `gpt-realtime-2` | Azure OpenAI Realtime | `gpt-realtime-2` | `2026-05-06` | Deployment metadata, `Succeeded` |
| `gpt-realtime-2.1` | Azure OpenAI Realtime | `gpt-realtime-2.1` | `2026-07-07` | Deployment metadata, `Succeeded` |
| `gpt-realtime-2.1-mini` | Azure OpenAI Realtime | `gpt-realtime-2.1-mini` | `2026-07-07` | Deployment metadata, `Succeeded` |
| `gpt-live-1` | Azure GPT-Live | `gpt-live-1` | `2026-09-10` | Deployment metadata, `Succeeded` |

Each native route's Azure deployment name matched its requested model. The
gateway had `AZURE_REALTIME_DEPLOYMENT=gpt-realtime-2` and no per-SKU overrides.
Its managed Voice Live setting was `VOICELIVE_MODEL=gpt-4.1-mini`; this service
does not use one of those customer-managed native deployments. HD therefore
has configuration evidence, not the native routes' deployment attestation.

The four native routes were different **models**, not merely four deployment
names or four gateway aliases. This is a dated deployment snapshot, not proof
of what serves a future session. The catalog API labels the evidence accordingly
and sets `liveSessionVerified: false`. It applies only to the exact canonical
`wss://api.kataleptic.com/v1/realtime` endpoint. Custom endpoints, query routing,
alternate paths and direct OpenAI do not inherit this evidence.

The running gateway source matched gateway repository commit
`5d6ec13540b3b2349f80abb44f221c66962c5b27` byte for byte for both relevant files:

| File | SHA-256 |
| --- | --- |
| `gateway.py` (`gateway/duguet-gateway.py` in source) | `69c6443b947d07c868a8b4d346f93f8ec1c5cc61766393d4bed3fd280a5b6357` |
| `voicelive_engine.py` | `3a4e80a9b236dec8ac5cbecf3a8f768fa22474e98d3b32213210cb6aa880626d` |

The audited `_native_realtime_model` resolves the catalog's `azure-realtime`
entries; `_native_realtime_deployment` applies per-SKU overrides, then the
historical default for Realtime 2, then each catalog `backend_model`.
`_run_proxied_session` passes that deployment to `AzureRealtimeSession`.
GPT-Live uses `_live_target` and its own `/v1/live/sessions` transport.
The gateway rewrites `session.model` to the requested public alias. That echo
cannot attest the actual Azure model; this is why deployment metadata was needed.

## Why choices could sound the same

The pipeline's default voice is the same Azure multilingual voice across
languages and chat models. Its text model determines replies while its speech
provider determines sound. The old runtime also silently changed retired or
unknown Kataleptic selections into HD; a customer could believe they were
hearing a different model while actually reaching HD. Those runtime substitutions
are now rejected, including retired explicit voices. The historical database
migration is retained; this change introduces no new migration.

The public catalog included transcription-only models whose names contain
`realtime`. OpenFon now requires audio output and an implemented conversation
adapter before offering a realtime conversation model. Streaming transcription
routes cannot appear as conversation choices or ordinary file-transcription
choices. A voice preview now requires the selected voice to be acknowledged
before asking the provider to generate the sample.

## Recheck without generating traffic

The portable helper takes infrastructure identifiers explicitly and uses already
authorized SSH and Azure CLI sessions. It reads exact allowlisted model fields
from the running process and deployment metadata. It never reads a legacy
credential file, prints a raw process environment, or requests a key.

```sh
python3 scripts/verify-kataleptic-routing.py \
  --ssh-host YOUR_GATEWAY_SSH_ALIAS \
  --gateway-directory YOUR_DEPLOYED_SOURCE_DIRECTORY \
  --service YOUR_GATEWAY_SYSTEMD_SERVICE \
  --subscription YOUR_AZURE_SUBSCRIPTION \
  --resource-group YOUR_RESOURCE_GROUP \
  --account YOUR_AZURE_AI_ACCOUNT
```

The helper refuses source drift, missing deployments, wrong upstream models and
duplicate actual model identities. After gateway changes, audit the new dispatch
source before updating its expected hashes. A fresh check does not automatically
rewrite the application's dated evidence; review and update that evidence as part
of a release. First-pass Azure discovery found a tenant-only default account and
one stale cached login; specifying the authorized subscription explicitly allowed
the read without changing any global login or configuration.

## Validation limits

Unit tests cover route preservation on the wire, collision detection, evidence
origin boundaries, unavailable model rejection and preview acknowledgment. These
checks do not establish audible differences, inference quality, latency, physical
microphone/speaker behavior or PSTN acceptance. A listening comparison must use
the same prompt and voice where supported, label model and renderer separately,
and record session evidence without treating a gateway alias as attestation.
Staging validation for the exact release and the acceptance gates in
[launch readiness](launch/readiness.md) remain required before rollout.
