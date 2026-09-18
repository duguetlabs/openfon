# First private browser call

This guide targets the Cloudflare Worker + D1 application in this repository. It is a setup recipe, not evidence of a fresh-install or real-voice pass. Start with fictional information and a private assistant. No telephone number is needed. See [readiness](launch/readiness.md) for outstanding release gates.

The [workspace settings contract](providers.md#workspace-settings-contract) describes separate text, transcription and realtime choices. Apply its migrations with the matching consolidated code, then use workspace settings and check existing assistant model overrides. This recipe starts with instance defaults; a preset selection alone does not verify provider access.

## 1. Prepare your accounts and configuration

You need Node 22.13+ and npm, a Cloudflare account you control, and valid text-generation and transcription provider credentials. Browser speech synthesis can supply the spoken reply without an Azure key; available voices depend on the browser/device. Hosting and provider usage may be billed separately from the MIT-licensed code.

```sh
git clone https://github.com/duguetlabs/openfon
cd openfon
npm ci
npx wrangler login
npx wrangler d1 create openfon
```

In `wrangler.jsonc`, replace the example `database_id` with the ID of **your new database**, and check `name` and `database_name` before any remote operation. Keep `TELNYX_ENABLED` and, on the consolidated release, `ASTERISK_ENABLED` set to `false` for this browser recipe. Do not apply these steps to an existing deployment without a backup and the [upgrade/release procedure](launch/readiness.md#deployment-procedure-prepared-not-executed).

Choose text generation and transcription separately using the [provider guide](providers.md). The shipped URLs point to Kataleptic, the founder’s optional paid service. To use another service, configure both endpoint URLs and model IDs for that service; changing only the text model does not switch speech or realtime traffic. Use a model available to your account, not an assumed model from a tutorial.

For the simplest browser pipeline, set `DEFAULT_TTS_PROVIDER` to `browser` in `wrangler.jsonc`. For Azure synthesis, keep `azure`, choose your region/voice and enter `AZURE_SPEECH_KEY` separately. Keep provider keys out of `wrangler.jsonc` and version control.

## 2. Enter secrets and deploy

```sh
npx wrangler secret put DEFAULT_LLM_API_KEY
npx wrangler secret put DEFAULT_STT_API_KEY
# Only if using Azure speech:
# npx wrangler secret put AZURE_SPEECH_KEY
npm run typecheck
npm run build
npm run deploy
```

Enter each credential at Wrangler’s prompt. `npm run deploy` builds, applies **remote D1 migrations**, then uploads the Worker; it is not a local preview. Verify the account and database first. If using an API token instead of interactive login, the deployment needs Workers Scripts and D1 edit permissions and an explicit `CLOUDFLARE_ACCOUNT_ID` to select the intended account. Use your credential manager; do not paste keys into commands or bug reports.

For a final public domain, supply `OPENFON_PUBLIC_URL=https://your-domain.example` to the build/deploy environment after replacing the example with your actual HTTPS origin. Without it, preview builds omit canonical/sitemap metadata. This is metadata configuration, not domain provisioning.

## 3. Test privately before sharing

1. Open the printed HTTPS Worker URL, create an account and complete onboarding with fictional business details. Keep the assistant in **draft**.
2. Add a known answer (for example, Saturday hours) and approve its knowledge item. Leave another question deliberately unanswered.
3. Choose the **Pipeline** engine for this first recipe, save, and open the private Test Studio.
4. Allow the microphone. Ask the known question, then an unknown question and a callback request. Listen to the actual response. Text-only success does not prove transcription or audio output.
5. Interrupt a response, end the call, then check the saved transcript, summary and captured details. Also test microphone denial and the text fallback. Record failures in the [evaluation template](launch/pilot-evaluation.md).
6. Only after those checks pass, publish the assistant and test its browser call link while signed out. Pause it again if the public test fails. Publishing a browser link does not connect a phone number.

## Troubleshooting and limits

- Authentication/403 errors from a provider: check account access, selected model, endpoint and matching credential. A configured key name does not prove access. Share status codes and request IDs, never tokens or full provider URLs containing authentication.
- Text works but speech does not: verify microphone permission, transcription configuration and browser audio/voice availability. Test with headphones. Azure needs its own working key and region.
- Changing a custom endpoint: save its own key alongside it; an instance key is not sent to arbitrary custom text endpoints. Review the README’s private-network opt-in before local model experiments.
- Realtime and telephone: use their specific adapter instructions and verification gates. A generic “OpenAI-compatible” URL is insufficient.
- Lost password: forgotten-password recovery is not implemented. Save credentials in a password manager; do not promise email recovery to pilot users.

The [pilot support scope](launch/pilot.md#support-scope) describes what maintainers can currently offer. Operator identity, hosted-service terms, data-retention policy and the final production hostname remain release inputs; this guide does not invent them.
