# Browser regression coverage

`npm run test:e2e` runs the business interface against a fresh local Worker/D1 database and a deterministic local conversation fixture. It makes no paid inference or carrier calls. `OPENFON_E2E_MANAGED=true npm run test:e2e` runs the managed customer boundary tests against the actual operator flag, real local authentication and account isolation. Billing, phone availability and action content fixtures in the managed UI test are explicitly synthetic.

Retained coverage includes authentication and logout recovery, account export/deletion, business and assistant save acknowledgement, unsaved edits, stale asynchronous navigation, knowledge, public links and publication, call searches and history, recording deletion, voice preview cancellation/cache/size limits, repeated audio playback, mobile layout and keyboard use.

Files ending in `.legacy.ts` preserve tests for removed technical provider/recipe/profile configuration screens. They are not selected by the current browser command because these screens are absent from managed customer navigation. Their backend contract tests remain in `test/`. General recovery, history, dirty-form and audio assertions from mixed suites were ported into the active business-interface specs. The isolated `provider-strictmode` component regression remains runnable for the preserved legacy component.

A passing browser suite does not prove actual Azure speech, physical microphone quality, phone-number activation or completed Dodo payment. Those require separate external acceptance recorded in the launch documentation.
