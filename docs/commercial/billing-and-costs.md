# Commercial billing and cost evidence

This implementation is opt-in. Existing accounts are not enrolled or charged. New checkouts require the operator's explicit `COMMERCIAL_BILLING_VERIFIED=true` and charging flag, correctly mapped Dodo products/meters, tax policy and webhook configuration. Verification is **not complete**; leave the verification flag unset.

## Customer pricing

Prices exclude VAT; Dodo, the merchant of record, determines applicable tax and reverse charge.

| Plan | Monthly base | Monthly included minutes | Monthly overage | Annual upfront | Annual-plan overage |
|---|---:|---:|---:|---:|---:|
| Flex | €19 | 0 | €0.16/min | €204 | €0.15/min |
| Small | €69 | 500 | €0.09/min | €696 | €0.08/min |
| Growth | €239 | 2,500 | €0.09/min | €2,508 | €0.08/min |

Annual allowances reset **monthly**, not annually. Annual checkout uses one annual base subscription and a separate zero-base monthly usage subscription in the same hosted checkout. Monthly checkout uses one monthly product with its base and usage meter. Both annual components must match the intended customer, product, amount, currency, quantity and interval before activation. A usage renewal alone does not confirm a renewed annual base term.

Actual monthly subscription dates govern usage periods. Sandbox evidence showed checkout creation and payment completion differing by approximately 30 seconds, and monthly/annual next dates differing by milliseconds. A locally calculated anniversary is only a prediction.

Private customer test calls and public calls count only after verified enrollment and actual service start. Only server-authorized operator QA markers exclude calls. Failed startup has no retail interval; failure after service starts retains the delivered interval. Voice previews are provider costs, not retail call minutes. Summaries and voice changes do not modify retail duration.

Durations aggregate as integer milliseconds. The allowance is removed and the overage rounds once per period to cents. Intervals are clipped to activation, verified paid coverage and the agreed cancellation deadline. Verification records positive coverage intervals atomically with account status. Temporary unpaid, past-due or incomplete coverage closes the current interval; recovery opens a new interval at verification time, leaving the unavailable gap unbilled. A renewed period observed after previous coverage expired does not backfill that gap. Permanent cancellation remains separate. Customer estimates and settlement use the same interval intersection. No call or carrier leg is individually rounded for retail billing.

## Cancellation, payment changes and deletion

In-app cancellation stops renewal at the paid term end. Annual monthly usage remains authorized through the paid annual term. `maintainCommercialBilling` runs every minute, retries bounded groups with declarative provider operations, and verifies both subscriptions are canceled at term end. A delayed provider response does not extend the retail cutoff. Existing calls finish normally; admission must reject new calls after the cancellation deadline.

Future preparation and due cancellation each reserve at most five jobs using independent durable retry order. A single database statement advances the selected batch before provider reads, so failures cannot pin every run to the same first five accounts, including after restart or overlapping maintenance. New jobs enter by request time; phase changes get their own rotation. This is fair scheduling, not an exclusive provider writer: overlapping retries of a small queue remain safe only because the existing operations declaratively set cancellation and verify it by readback. Unresolved jobs remain pending, and attempt metadata is removed with its account rather than replacing billing records.

The general customer portal is unavailable for annual plans because it can cancel the two subscriptions independently. Merchant-wide portal settings are not modified. Narrow hosted payment updates verify the authorized payment and method, then explicitly update and read back each linked subscription. A read-only failure before mutation stays retryable. Creation and propagation share a durable per-workspace writer without expiry. A timeout, failed write, or interrupted invocation retains exclusion, preventing a stale reconciliation from restoring an older payment method. An uncertain write requires operator reconciliation; it does not silently unlock on a timer. Invoice downloads require both local workspace ownership and provider customer ownership. OpenFon never collects raw card data.

Account deletion revalidates password/session and active-call preconditions while atomically reserving **all** owned workspaces. The marker prevents new call admission and purchases. Before any provider cancellation, deletion checks finalized retail amounts, missing finalization records and every prepared or uncertain usage outbox. An outstanding positive amount needs a matching operator-verified invoice settlement; merely ingesting a MAX event is not proof the amount was invoiced. Clean accounts with no amount due remain deletable. Pending deletion retains account and invoice read access and can be retried idempotently after reconciliation. Checkout and rental intents test it at the actual SQL write and verify their own reservation before external POST. An intent that wins first keeps deletion pending. Pending rentals with known provider order IDs are reconciled with read-only carrier requests during deletion; verified cleanup identity is retained without creating a route. When a purchase response loses the order ID, a bounded read-only lookup by the durable customer reference can recover exactly one order only if complete pagination, connection and phone identity agree. Missing, multiple or incomplete matches retain the support gate and are never purchased a second time. Phone orders retain the historical assistant ID without preventing an otherwise eligible assistant from being deleted. A rental completed after that deletion retains its carrier identity but receives no route until it is reassigned to an owned assistant. A verified terminal unsuccessful order is marked failed only after a complete inventory check confirms that its number was not allocated; uncertain or partially allocated rentals retain their cleanup obligation. Purchase admission checks current paid coverage, permanent stops and cancellation deadlines at SQL insertion and again before the provider request, even if the cancellation scheduler is delayed. Verified owned phone rentals are disabled, released and read back; subscriptions are canceled and read back before local data deletion. Ambiguous orders, pending checkout reconciliation or failed external cleanup retain mappings and the retryable marker. Existing refund/legal policy remains unchanged; no new refund waiver is implied.

## Usage export and reconciliation limits

Provider observations are distinct from retail usage. GPT-Live reports cumulative session seconds; exact nanoseconds are retained where representable. Delegated reasoning and text operations record actual token counters without adding subcategories to totals. Duplicate observations do not add usage. Missing counters remain missing.

Finality belongs to the measured quantity. A lower terminal counter cannot certify a larger retained interim counter, and a later larger interim value cannot inherit an earlier smaller value's final flag. Equal quantities retain valid certification already observed; unknown terminal fields do not invent measurements or erase known values. The shared database rule applies to Node, carrier and preview observations independently per metric.

The candidate Dodo meter consumes cumulative **rounded cents**, avoiding repeating-decimal per-millisecond prices. Minute maintenance now processes at most five least-recently checked billing periods. With the verification and charging flags enabled, it sends cumulative rounded cents only from immutable finalized call intervals in the still-current verified usage period. It checks the actual subscription mandate again before sending, honors paid/cancellation/deletion boundaries and persists an immutable outbox payload with deterministic event identity. Repeated runs send neither individual-call charges nor duplicate snapshots. The MAX meter receives the current total, not increments. The event timestamp is the time of that cumulative snapshot.

Calls that finish after a period closes, audited adjustments, downward changes, mandate changes and uncertain provider results enter explicit reconciliation; their charges are never shifted into another month. An unfinished call contributes nothing to automatic export until its final interval exists. Uncertain sends do not expire into a replacement writer; their exact provider event must be reconciled. A duplicate ingestion response requires matching event readback. Ingested snapshots still require invoice reconciliation, and the verification flag remains disabled until actual aggregation/invoice acceptance passes. Settlement preparation requires a closed actual billing period and reconciled call intervals; it is not scheduled to auto-publish provisional totals. Publishing needs an explicit reviewed hash and the verification gate. A lower correction after an exported MAX snapshot requires credit reconciliation; sending a smaller MAX cannot reverse the charge. Late corrections refer to the original period and never silently move into a later allowance or invoice.

Dodo accepts usage timestamps only one hour into the past. Acceptance of a backdated event does not prove an issued invoice changes. Actual minimum-amount, zero-invoice, late-usage and invoice/credit reconciliation remain launch gates. No carry-forward, waiver or minimum-charge rounding policy has been invented.

## Verified external evidence

On 5 October 2026, Dodo **test mode** accepted a meter, a zero-base monthly metered product, an annual €204 product and a combined hosted checkout. A documented synthetic card completed checkout: €204 plus €40.80 VAT, with two independently active subscriptions and shared customer/metadata. The native guest browser showed the independent annual/monthly schedules. This is actual sandbox payment acceptance, not a live customer charge.

One-cent usage ingestion succeeded. Moving the sandbox usage subscription's next billing date through the documented PATCH succeeded, but no subsequent processed renewal invoice had been observed at the last check. Do not claim that this proves tiny recurring invoice acceptance or a sandbox time-travel facility. Original evidence stays in restricted local files; credentials and card data are not committed.

An actual sandbox PDF invoice download returned HTTP 200, a PDF content type and a valid PDF header. A second zero-base standalone hosted checkout succeeded with a zero-euro payment. A separate €2 usage control was ingested and its next billing date accepted, but neither it nor the one-cent experiment produced an observed renewal or usage history at the last check. The documented current-time PATCH was rejected as not in the future; a future timestamp succeeded. Scheduling uncertainty therefore remains distinct from minimum-charge acceptance. A later read-only audit verified numeric cents, matching event and customer identities, the exact product and subscription meter, MAX over the `cents` metadata property with no filter, and UTC timestamps inside each original period. The event API exposes no processing-status/error field, and neither subscription’s previous billing date had advanced. No concrete configuration mismatch was found; aggregation and invoice settlement are still unproven. All three owned active sandbox subscriptions were then canceled and read back as canceled; the failed setup subscription remained failed.

A hosted payment-method update succeeded using a documented synthetic card. Provider readback verified the update payment, customer, source subscription, selected method and unchanged billing date. Both original subscriptions already referenced the selected method on readback. The application still independently verifies every component rather than assuming provider-wide propagation.

Synthetic SQLite and fetch tests cover identity, replay, component races, renewal coverage, interval clipping, cancellation, payment propagation, deletion and phone ownership. They do not establish live billing, provider audio or PSTN acceptance.

## Provider costs and remaining phone gates

The operator-selected Mini adapter records Azure Realtime per-response tokens,
including separate audio/text/cache subsets, rather than GPT-Live cumulative
seconds. Session plus response identities deduplicate retransmitted observations;
independent reasoning usage remains separate. Missing counters are unknown, not
zero. Separate transcription observations retain provider item/content identity,
the accepted transcription model and reported tokens or precise duration. They
are independent of conversation responses and never affect customer call minutes.
Actual Azure meter/rate and invoice reconciliation remain unverified. These provider observations do not change retail call-duration
aggregation or establish invoice costs. See [the adapter contract](../managed-mini-voice.md).

Telnyx's published Voice API fee is $0.002/min **plus** applicable inbound/outbound SIP fees. Its current billing article describes 60/60 increments and explicitly says six-second increments are no longer offered. Country/rate-deck terms can differ. Retail OpenFon rounding is independent of carrier rounding. Number setup/rental prices require actual `cost_information` quotes and regulatory review.

Phone ordering stays disabled until country, budget, regulatory requirements, direct carrier acceptance, rental billing and rental termination policy are verified. A subscription cancellation request does not silently release a business number. Account deletion's explicit release is a separate action. Public pricing tables are not account-specific quotes.

The direct Azure native `/openai/v1/live/sessions` GPT-Live price is still unverified. Azure Voice Live cascade pricing is a different product; Azure retail queries for GPT-Live returned transcription meters, not a verified conversation rate. A resource-filtered Azure cost audit for the known project account returned Cost Management HTTP 429 and an empty Consumption usage-details page with no next page. That provides no meter unit or rate and does not establish zero cost. No margin calculation or invented per-minute Azure rate is justified yet.

Sources:

- [Dodo multi-subscription checkout](https://docs.dodopayments.com/developer-resources/checkout-session#multi-subscription-cart)
- [Dodo usage billing](https://docs.dodopayments.com/developer-resources/usage-based-billing-guide)
- [Dodo subscription integration and minimum charges](https://docs.dodopayments.com/developer-resources/subscription-integration-guide)
- [Dodo hosted payment-method update](https://docs.dodopayments.com/api-reference/subscriptions/update-payment-method)
- [Dodo invoice retrieval](https://docs.dodopayments.com/api-reference/payments/get-invoice)
- [Telnyx exact customer-reference order discovery](https://developers.telnyx.com/api-reference/phone-number-orders/list-number-orders)
- [Telnyx billing increments](https://support.telnyx.com/en/articles/1130659-billing-increments)
- [Telnyx Voice API pricing](https://telnyx.com/pricing/call-control)

## Recovering an uncertain payment writer

There is deliberately no customer unlock or automatic expiry. Before operator recovery, stop admission of payment-update requests for the affected workspace, establish that the original application invocation is no longer running, and obtain provider confirmation that its action has settled. A single immediate GET after a timeout is insufficient proof that a delayed write cannot still land. Reconcile the hosted payment's ownership and selected method against every owned subscription, retaining the current job and provider identities. Only after that evidence may an operator repair the job and remove the exact writer token; never start a replacement authorization while the earlier mutation remains uncertain. No automated recovery endpoint is implemented. Billing remains gated until this operational recovery and invoice acceptance are ready.

## Operator deployment configuration

The guarded release can expose billing information while keeping new checkout and automatic usage export disabled. The current acceptance state does **not** authorize setting `COMMERCIAL_BILLING_VERIFIED=true`.

Apply the reviewed `0027_commercial.sql` before deploying code that uses its tables, including paid-coverage intervals, payment writers and usage outboxes. It has not yet been remotely applied at this checkpoint. If an earlier version has already been applied in another environment, create an additive migration; editing an applied migration will not update that database. Retain a protected database backup and the exact Worker version/schema combination in the release preflight. Do not reset existing account, call or provider data.

| Setting | Required value or role |
|---|---|
| `DODO_MODE` | `test` for the isolated sandbox environment; `live` only for the independently configured commercial environment. |
| `DODO_API_KEY` | Vault-backed API key for that exact Dodo mode, installed as a server secret. |
| `DODO_WEBHOOK_SECRET` | Signing secret for that mode's webhook endpoint, also a server secret. |
| `DODO_PRODUCTS_JSON` | Map of product IDs described below, from the same Dodo mode. |
| `DODO_METERS_JSON` | Map of usage meter IDs and event names described below, from the same mode. |
| `COMMERCIAL_TAX_POLICY` | `exclusive` for the selected published prices; product `tax_inclusive` must therefore be false. |
| `COMMERCIAL_PUBLIC_ORIGIN` | Exact HTTPS application origin, without a path, query or fragment; production is `https://openfon.ai`. |
| `COMMERCIAL_CHARGING_ENABLED` | Leave unset or `false` for the guarded release. |
| `COMMERCIAL_BILLING_VERIFIED` | Leave unset or `false` until the outstanding actual invoice/aggregation and recovery gates are resolved. |
| `COMMERCIAL_OPERATOR_TOKEN` | Optional separate server secret for authenticated operator QA exclusion; never a customer-controlled call flag. |

Use distinct test/live secrets, products, meters, webhook destinations and application databases. Do not switch a business with an existing subscription between test and live modes. Read secrets through the authorized vault tooling and install them through the deployment platform's secret mechanism; never put them in JSON examples, source, command output or browser configuration.

For every plan key `flex`, `small` and `growth`, `DODO_PRODUCTS_JSON` contains:

- `<plan>:monthly`: the monthly usage-based product, including its monthly base.
- `<plan>:annual`: the recurring annual base product, paid upfront.
- `<plan>:annual:usage`: a **different**, zero-base monthly usage product for the same annual plan.

`DODO_METERS_JSON` contains `<plan>:monthly` and `<plan>:annual`, each with the shape `{ "id": "REPLACE_WITH_METER_ID", "event": "REPLACE_WITH_EVENT_NAME" }`. The annual entry belongs to the annual plan's monthly usage product. Configure MAX aggregation over numeric metadata property `cents`, no filter, price per unit `1` in EUR minor units and free threshold `0`; OpenFon already removes the plan allowance before reporting rounded cents. Commercial HTTP requests use Workers-compatible manual redirects and reject non-2xx responses without forwarding credentials to a redirected destination. Products must have no discount, trial or purchasing-power adjustment. The monthly bases are 1900 / 6900 / 23900 cents; annual bases are 20400 / 69600 / 250800 cents. Annual usage-product bases are zero. The application verifies product, currency, quantity, interval and meter configuration before accepting enrollment.

Configure the mode-specific Dodo webhook at `<COMMERCIAL_PUBLIC_ORIGIN>/api/billing/webhook` for the applicable subscription lifecycle and payment notifications. Preserve the raw request body and Standard Webhooks signature headers. The handler verifies signatures and re-reads provider state; checkout redirects do not authorize enrollment. Keep the existing per-minute `maintainCommercialBilling` schedule enabled for cancellation recovery even while charging is disabled. Normal current-period usage export runs through that same schedule only when both charging and verification gates pass. A cadence appears in the customer interface only when mappings for all three plans are present.

### Acceptance before charging

Actual sandbox evidence covers combined annual/monthly checkout, a standalone zero-base hosted checkout, invoice PDF retrieval and a hosted payment-method update. Synthetic tests cover coverage recovery, ownership, SQL races, outbox replay and exception routing. Neither class proves a normal metered renewal invoice: the one-cent and €2 control events were ingested but no aggregation/renewal history was observed. Resolve the ordinary metered invoice, zero/minimum amount, late/downward credit reconciliation, uncertain payment/outbox recovery and term-end lifecycle acceptance before enabling verification. Keep the explicit annual-upfront policy; there is no automatic customer enrollment, retroactive charge, carry-forward or waiver.

### Phone purchase prerequisites

Leave `TELNYX_PURCHASES_ENABLED` and `TELNYX_CARRIER_VERIFIED` unset or false. Enabling purchasing also requires `TELNYX_ENABLED`, the server `TELNYX_API_KEY`, the validated `TELNYX_CONNECTION_ID`, `TELNYX_PURCHASE_COUNTRY` (two-letter country), `TELNYX_PURCHASE_CURRENCY` (three-letter currency), and integer minor-unit ceilings `TELNYX_MAX_SETUP_MINOR` / `TELNYX_MAX_MONTHLY_MINOR`. Country/regulatory requirements, live direct-carrier acceptance, actual account quotes, rental charging and rental termination policy remain unresolved. Do not infer authorization from the account balance or published rate tables. Purchasing and assistant publication are separate operations; a purchased rental starts with answering disabled.

### Rollback and paused charging

Disabling `COMMERCIAL_CHARGING_ENABLED` or `COMMERCIAL_BILLING_VERIFIED` stops new OpenFon checkout and automated usage export. It does **not** cancel existing Dodo renewals, issue refunds, release rented numbers or erase owed usage. Keep authenticated webhooks, cancellation/deletion recovery and authoritative call-interval capture operating. A backlog still in its original current period can be recomputed; closed-period and uncertain outboxes require reconciliation, not re-dating into a new period.

Retain the commercial schema and immutable provider/outbox identities when rolling back application code. Do not truncate the ledger, lower a sent MAX value, clear a writer solely because it is old, or downgrade to code that silently ignores unresolved commercial cleanup. Disable phone purchasing separately; that does not release existing rentals. Any actual refund, credit, cancellation or number release is an explicit operational action with verified ownership and readback.

### Deletion while an invoice is outstanding

Deletion is not fully automatic when a current period has billable usage but no reconciled invoice. The account remains marked for deletion, new commercial actions remain blocked, and the customer can still read billing/invoice information. No subscription cancellation or irreversible local cleanup occurs until the outstanding tail is reconciled. Do not mark ingestion, an empty usage-history response or a future invoice estimate as completed invoicing.

The explicit support path is to verify the correct provider customer, original billing period, invoice/payment and any required credit or adjustment. Record the provider reference and exact covered milliseconds/rounded cents in the corresponding `commercial_usage_exports` row and mark it `invoice_reconciled` only after that verification. The row must match the currently computed amount; subsequent changes block deletion again. There is no customer endpoint or automatic job that grants this state.

When an audited adjustment changes a previously reconciled invoice, run `prepareUsageSettlement` again. It atomically archives the original invoice row in immutable `commercial_usage_invoice_evidence`, retaining its quantity, amount, hash and reference, and enters `reconciliation_required`. The returned candidate hash describes what needs review; it is not an approval or a new bill. Do not overwrite the archived invoice or issue a lower MAX event to undo a charge.

After independently verifying the matching invoice and actual credit/debit correction, a trusted operator can call `recordUsageInvoiceCorrection(env, settlementId, candidateHash, { invoiceReference, correctionReference, verifiedBy })`. Use bounded provider/audit references and the operator identity; never credentials or raw provider bodies. This internal function has no HTTP route and makes no provider calls. It records an attestation of external verification, not verification by itself. The proof and corrected snapshot are installed atomically, the same proof is idempotent, and competing or stale candidate proofs are rejected. An exact verified credit can reconcile a lower amount while the historical MAX event remains unchanged. Uncertain outboxes still need their own reconciliation. Retry deletion afterwards; its independent current aggregation rejects any later usage or adjustment not covered by the proof. Evidence follows the existing account-deletion lifecycle and introduces no new retention policy.

SQLite tests exercise positive/negative synthetic corrections, a retained higher MAX, rollback and concurrent proofs through a successful deletion retry. Their fixture attestations do not establish a live provider credit, debit or invoicing workflow; that acceptance gate remains open.

An older never-claimed `prepared` snapshot is automatically marked `superseded` only when an `ingested` snapshot for the same business, period, subscription, customer, provider mode and event covers at least its duration and amount. Its payload remains immutable. The SQL update rechecks `prepared` at the write boundary; a concurrent `sending` claim, an uncertain result or a different mandate is never retired. A new finalized call between calculation and claim can therefore be exported by the next run without leaving an obsolete deletion blocker. This does not replace invoice reconciliation for the actual covered amount.

For other prepared or uncertain snapshots, first establish that the original invocation and provider action have settled. Preserve the immutable payload and identity; use `reconciled` for a support-resolved outbox that should no longer block deletion, rather than relabeling an unprocessed event as ingested. The stream stays out of automatic export while reconciliation is pending. Both automatic export and operator-approved settlement require exact event ID, customer, name, timestamp and amount readback when ingestion reports zero new events. Missing, mismatched or failed readback retains explicit reconciliation, not a successful send or invoice confirmation. Retry the same deletion request after these records are verified. These states record operational evidence, not a new retention, refund or debt-waiver policy. Without the required invoice/provider proof, the account remains pending and support must finish the original billing workflow.

A defensive aggregate check also repeats the exact covered-duration calculation inside the export claim. The reproduced QA-marker drift used a direct database insertion; the supported QA API requires an active call without finalized usage, so it was not a demonstrated customer/API exploit. No revision schema was added.
