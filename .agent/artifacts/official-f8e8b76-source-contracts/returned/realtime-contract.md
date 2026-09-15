## CURRENT — exact f8e8b76 Realtime blocked, source-only qualified disposition

Read selection SHA256 c32cfc5a6e8fe43d4de8c05e9ead067b54531b6b01d0576900e31ebb153cffda and map SHA256 0917df11ad6992800b397f1b1f6586f73e8217efd97caa85934550a283d2a34a. Exact integration HEAD f8e8b7619a86797e017f9cc317b090eaf64fe513; the seven files below match committed and working bytes. Original SHA256 349e8c6ea2647a6eb6edbcf401e1fd74eacb7fb2077389fb7a51968a66811912, 10355 bytes, is publication-pending with no comment identity in the map. Its 558 omissions (50 listed, 508 additional) remain coverage limits. Owner HEAD a6d33fe7e81c4166c6a9e5d98f812f7d8fefc331 and existing dirty source/dependency snapshots are preserved; they are not the application baseline for this assessment.

Qualified disposition: decline the precise assertion that a direct realtime key plus absent default text credentials necessarily throws LlmConfigError at startup. Fresh exact-source trace confirms resolveLlm still runs before resolveRealtime at CallSession523–524, but providers54–78 accepts blank/default-equivalent text endpoints and returns the workspace key, instance text key, or empty string without fetch or authentication validation. No exception is caused solely by that empty default key. loadSettings356–411 loads text and realtime settings independently. Distinct custom text endpoints still require a valid URL and their own text key; an invalid custom URL or missing own custom key deliberately rejects at pickup through the existing LlmConfigError path. Do not infer arbitrary custom configuration independence or change that policy automatically.

resolveRealtime20–48 separately requires a key for explicit workspace realtime selection. Instance resolution uses REALTIME_API_KEY, with the retained DEFAULT_LLM_API_KEY fallback only for gateway; direct OpenAI does not borrow the default text key. A realtime key is not substituted into text summary authentication. No new provider lookup or request was performed.

Finalization qualification: runFinalize closes caller/upstream before summary processing, rehydrates settings/history and reuses an already memoized summary. For an unsummarized conversation with history.length > 2, CallSession2007 resolves text settings again and invokes chatComplete. providers164–207 posts to the text chat/completions endpoint with Authorization Bearer using that text key and manual redirects. An empty key may reach this later request; startup acceptance is not proof of authenticated/generated summaries, structured extraction, service availability or model compatibility. HTTP authentication failure becomes LlmRequestError, and bounded response/network failures use fixed ProviderResponseError. The finalizer catches summary failure at2030–2032, can use the first caller excerpt at2034–2037, and persists the fallback; summary failure alone does not set the call failure used for final status. No authenticated-summary promise or new finalization policy is justified.

Current test source at CallSession2406 onward contains paired web/Telnyx native greeting cases with direct realtime credentials and blank text credentials, asserting one direct fetch, ready1, PCM1 and error0. LLM configuration and realtime provider tests retain default fallback/no cross-endpoint credential lending controls. These are inspected test bodies and retained historical evidence only: no discovery, import, test, typecheck or new passing attribution. No concrete counterexample to the qualified default-empty-key disposition was established in this scope.

Exact SHA256 identities, committed=working:

| Path | SHA256 |
| --- | --- |
| src/call-session.ts | 8c884f8a6f39d7db83b22ff40eb9d0233436eb0391866b0701a7a09c2d18b413 |
| src/providers.ts | 8a3b941f17d9d7250cde355b46ed10a90e9bdbc63b85ab14fb012fe50edb5fe7 |
| src/realtime-providers.ts | 3dbaafdc7de38bbca7cd24f5d11bf26c3e75b8b4dbd36f705b4ee89e720963d0 |
| src/provider-response.ts | 7dba2fa2361876a813580fe1fb4d1b45b1ec42525977a52a2ba469e21db09bad |
| test/call-session.test.ts | 375fd7ff8be609e36317262ffbc9bcf226fcf516e6402e6d104579238feaadec |
| test/llm-config.test.ts | 3818041a4dac1098b844b0b3e1eb32f9baf81827ddd677911b2ca89e9e50e77f |
| test/realtime-providers.test.ts | 8b4974b8043241498fe727e5df340e6bec2be5c6cc0a8591dab1f019ccfb21fd |

Only this safe owned source receipt changed. Return to integration only; its independent QA routing remains pending dialog clearance. No QA prompt/dialog operation, application/fixture preparation, runtime, dependencies, credentials, inference, publication or new agent. Prior Piper43PASS1FAIL and separate6PASS, gateway evidence, rebuilt132 (not former binary identity), unknown failed2926 discarded-stderr cause and all historical proof limits remain unchanged. No blanket review clearance or automatic implementation selected.

