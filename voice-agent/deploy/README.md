# Azure voice services

OpenFon keeps its website, accounts, calls and transcripts in Cloudflare. A dedicated CPU VM hosts WebRTC transport and the Node voice agent. Managed inference goes directly to the operator Azure resource. No GPU or LiveKit Cloud subscription is required.

## Layout

One Ubuntu 24.04 Standard_D2as_v5 VM (2 vCPU, 8 GiB RAM, 32 GiB Standard SSD) hosts separate staging and production Compose projects. Each has independent LiveKit keys, callback credentials, rooms and health ports. Callback origins are fixed per environment. The product Azure inference credential is distinct from coding-agent credentials.

Four DNS-only A records point at the static public IP: voice.openfon.ai, voice-staging.openfon.ai, turn.openfon.ai and turn-staging.openfon.ai. Do not enable Cloudflare HTTP proxying. nginx stream routes encrypted TLS by SNI to TURN or the internal HTTPS listener. PROXY protocol preserves caller IPs; only the local proxy is trusted. Signaling access/error request logging is disabled because URLs can carry tokens.

| Service | Production | Staging | Public exposure |
|---|---:|---:|---|
| ACME HTTP | 80 | 80 | TCP challenge/redirect |
| Signaling and TURN TLS | 443 | 443 | TCP SNI routing |
| LiveKit HTTP | 7880 | 7890 | Blocked by NSG |
| Direct RTC TCP | 7881 | 7891 | TCP |
| Direct RTC UDP | 7882 | 7892 | UDP |
| TURN UDP | 3478 | 3479 | UDP |
| TURN TLS upstream | 5349 | 5350 | Blocked by NSG |
| Agent health | 8081 | 8091 | Blocked by NSG |

SSH is limited to the current operator IP. Update that restriction through authenticated Azure management if the operator moves networks; do not open SSH globally.

## Install

1. Provision dedicated VM/VNet/IP/NSG with cloud-init.yaml, preserving unrelated resources. Check cloud-init completes. Allow only the public ports above plus restricted SSH.
2. Verify the four DNS records. Install the port-80 block of nginx.conf. Obtain a Certbot webroot certificate named openfon-voice covering all four names, webroot /var/www/acme. Use a publicly trusted chain supported by the actual native WebRTC client. The pinned native library does not include ISRG roots: a system-trusted Let's Encrypt certificate alone does not establish native TURN compatibility. ZeroSSL ACME (https://acme.zerossl.com/v2/DV90) offers a USERTrust/Sectigo chain; obtain its EAB using the official email endpoint with a verified operator email and place EAB options in a root-only Certbot config, never command arguments. Use an RSA key and verify the issued chain with the native client. Certificate terms/registration need operator authorization.
3. Install nginx.conf as /etc/nginx/sites-available/openfon-voice and enable it instead of the default site. Include nginx-stream.conf at nginx.conf top level, outside http. Validate nginx -t before reload.
4. Install renew-hook.sh as executable /etc/letsencrypt/renewal-hooks/deploy/openfon-voice. It reloads nginx and restarts both LiveKit processes on successful renewal. This may interrupt calls; this is not a highly available deployment.
5. Build the agent from the exact reviewed voice-agent source and transfer over authenticated SSH or a private registry. Verify its immutable image ID. The LiveKit image is pinned to v1.13.7 by digest in render-config.py.
6. Prepare root-only JSON per environment with LIVEKIT_API_KEY, LIVEKIT_API_SECRET, OPENFON_AGENT_SERVICE_TOKEN, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY. Generate independent high-entropy LiveKit/callback credentials and retrieve the product inference credential from its vault. Never print credentials or enable shell tracing.
7. As root run render-config.py --environment staging --credentials /root/staging-credentials.json --agent-image sha256:<verified-image-id>, then repeat for production. Place the script next to compose.yaml. Configuration files under /opt/openfon-voice/<environment> are root-only. The usage subdirectory is mode0700 owned by container UID1000; preserve it across agent image updates. Review callback origins before launch.
8. Run docker compose up -d in each environment directory. The runner must support LIVEKIT_AGENT_PORT to avoid the shared default port. Services restart after crashes and reboots.
9. Provision matching Cloudflare secrets; map OPENFON_AGENT_SERVICE_TOKEN to LIVEKIT_AGENT_SERVICE_TOKEN. Apply the additive transcript migration with a verified backup. Enable OPENFON_MANAGED_WEB=true with the operator Azure bindings and all product/action/usage migrations through the separately reviewed staging-first rollout.

Keep recoverable generated credentials and SSH keys in the operator secret store. Local transfer files alone are not durable custody; Cloudflare encrypted secrets cannot be retrieved for recovery.

## Acceptance and cost

Use docker compose config --quiet without printing expanded secrets, nginx -t, health checks and certificate expiry. Required external testing includes nonzero RTC audio and a separate relay-only ICE run proving TURN/TLS443. The composed real OpenFon/Azure call must separately demonstrate audio, selected voice, persisted transcripts, summary and orderly hangup. Synthetic transport checks do not establish provider or physical-device acceptance; see docs/launch/readiness.md.

Initial West Europe compute retail estimate is approximately EUR66.80/month at730hours. SSD, IPv4 and outbound traffic are additional. Sponsorship eligibility/balance and measured call capacity are not established by the estimate. Two CPU cores are an initial low-volume allocation.

## Rollback

Restore a reviewed complete Worker/Node/configuration pair through the Cloudflare rollout procedure; retain transcript, action and usage columns/rows. The new Node build requires direct Azure configuration, so toggling only WEB_VOICE_TRANSPORT is not a full rollback. Drain calls before stopping only the affected Compose project. An agent-only rollback restores its prior image ID in .env and recreates that agent. Keep the other environment and carrier services unchanged.

Never delete the containing resource group: existing Speech and Communication resources also live there. Shared VM/IP/NSG/VNet/certificate teardown requires checking all dependents.
