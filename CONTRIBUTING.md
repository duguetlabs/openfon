# Contributing to OpenFon

OpenFon is MIT-licensed software from Duguet Labs. Contributions to independent AI providers, open telephone gateways, accessibility, setup documentation and reproducible bug reports are welcome. Kataleptic is the founder’s optional paid inference service; a contribution need not use or promote it.

For a larger change, open an issue explaining the user problem, intended scope and validation before building a new adapter. Keep changes focused and preserve provider defaults unless a change is explicitly agreed. Include documentation for every new capability and label its actual evidence level.

## Local setup

Use Node 22.13+ and `npm ci`. Create a gitignored `.dev.vars` only if real local provider access is needed, using your credential manager. Never commit keys or raw customer transcripts. Most automated tests use synthetic providers and do not need paid accounts.

```sh
npm run db:migrate:local
npm run build
npm run dev:worker -- --port 8815 --inspector-port 9255
# UI and API: http://localhost:8815
npm run typecheck
npm test
```

Choose unused local ports. The example serves the built UI with the Worker; rebuild after UI edits. Never run `npm run deploy` as a preview: it applies remote migrations.

Run checks relevant to your change. Provider/media changes also need the appropriate synthetic/runtime suite and, before claiming service compatibility, a consented real-provider test. `npm run test:telnyx` uses local simulated services; `npm run test:e2e` uses isolated local state and its own server. Inspect their port configuration before running concurrent suites. Install Playwright’s matching Chromium with `npx playwright install chromium` when needed.

## Pull requests and reports

Explain the concrete problem, changed behavior and exact validation results, including skips and failures. Distinguish unit/synthetic tests, local Worker runtime, real AI-provider audio and real telephone calls. Include provider/model/version and a sanitized reproduction for compatibility claims. A successful model list or text reply alone does not establish realtime or telephone support.

Review every finding against the code and respond with a fix or a reason. Required CI and review checks apply. Do not merge around unresolved security findings or claim checks that did not run.

Use [provider compatibility](docs/providers.md) and the [pilot evaluation](docs/launch/pilot-evaluation.md) for adapter acceptance. Keep carrier lifecycle and media conversion separate from assistant knowledge/conversation logic. Avoid hidden provider fallback or routing credentials to a different endpoint.

Report ordinary bugs through repository issues with version, environment and sanitized steps. Never attach keys, authentication-bearing URLs, private account exports or customer recordings. A private security-reporting contact has not yet been confirmed; obtain a private reporting route from the maintainer before sharing sensitive details publicly. Contributions and issue reports do not create a guaranteed support response time.
