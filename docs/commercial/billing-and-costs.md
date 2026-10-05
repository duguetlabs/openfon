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

Durations aggregate as integer milliseconds. The allowance is removed and the overage rounds once per period to cents. Intervals are clipped to activation, verified paid coverage and the agreed cancellation deadline. No call or carrier leg is individually rounded for retail billing.

## Cancellation, payment changes and deletion

In-app cancellation stops renewal at the paid term end. Annual monthly usage remains authorized through the paid annual term. `maintainCommercialBilling` runs every minute, retries bounded groups with declarative provider operations, and verifies both subscriptions are canceled at term end. A delayed provider response does not extend the retail cutoff. Existing calls finish normally; admission must reject new calls after the cancellation deadline.

The general customer portal is unavailable for annual plans because it can cancel the two subscriptions independently. Merchant-wide portal settings are not modified. Narrow hosted payment updates verify the authorized payment and method, then explicitly update and read back each linked subscription. A read-only failure before mutation stays retryable. Creation and propagation share a durable per-workspace writer without expiry. A timeout, failed write, or interrupted invocation retains exclusion, preventing a stale reconciliation from restoring an older payment method. An uncertain write requires operator reconciliation; it does not silently unlock on a timer. Invoice downloads require both local workspace ownership and provider customer ownership. OpenFon never collects raw card data.

Account deletion revalidates password/session and active-call preconditions while atomically reserving **all** owned workspaces. The marker prevents new call admission and purchases. Checkout and rental intents test it at the actual SQL write and verify their own reservation before external POST. An intent that wins first keeps deletion pending. Pending rentals with known provider order IDs are reconciled with read-only carrier requests during deletion; verified cleanup identity is retained without creating a route. Unknown order IDs remain a support gate and are never purchased a second time. Verified owned phone rentals are disabled, released and read back; subscriptions are canceled and read back before local data deletion. Ambiguous orders, pending checkout reconciliation or failed external cleanup retain mappings and the retryable marker. Existing refund/legal policy remains unchanged; no new refund waiver is implied.

## Usage export and reconciliation limits

Provider observations are distinct from retail usage. GPT-Live reports cumulative session seconds; exact nanoseconds are retained where representable. Delegated reasoning and text operations record actual token counters without adding subcategories to totals. Duplicate observations do not add usage. Missing counters remain missing.

The candidate Dodo meter consumes cumulative **rounded cents**, avoiding repeating-decimal per-millisecond prices. Settlement preparation requires a closed actual billing period and reconciled call intervals; it is not scheduled to auto-publish provisional totals. Publishing needs an explicit reviewed hash and the verification gate. A lower correction after an exported MAX snapshot requires credit reconciliation; sending a smaller MAX cannot reverse the charge. Late corrections refer to the original period and never silently move into a later allowance or invoice.

Dodo accepts usage timestamps only one hour into the past. Acceptance of a backdated event does not prove an issued invoice changes. Actual minimum-amount, zero-invoice, late-usage and invoice/credit reconciliation remain launch gates. No carry-forward, waiver or minimum-charge rounding policy has been invented.

## Verified external evidence

On 5 October 2026, Dodo **test mode** accepted a meter, a zero-base monthly metered product, an annual €204 product and a combined hosted checkout. A documented synthetic card completed checkout: €204 plus €40.80 VAT, with two independently active subscriptions and shared customer/metadata. The native guest browser showed the independent annual/monthly schedules. This is actual sandbox payment acceptance, not a live customer charge.

One-cent usage ingestion succeeded. Moving the sandbox usage subscription's next billing date through the documented PATCH succeeded, but no subsequent processed renewal invoice had been observed at the last check. Do not claim that this proves tiny recurring invoice acceptance or a sandbox time-travel facility. Original evidence stays in restricted local files; credentials and card data are not committed.

An actual sandbox PDF invoice download returned HTTP 200, a PDF content type and a valid PDF header. A second zero-base standalone hosted checkout succeeded with a zero-euro payment. A separate €2 usage control was ingested and its next billing date accepted, but neither it nor the one-cent experiment produced an observed renewal or usage history at the last check. The documented current-time PATCH was rejected as not in the future; a future timestamp succeeded. Scheduling uncertainty therefore remains distinct from minimum-charge acceptance.

A hosted payment-method update succeeded using a documented synthetic card. Provider readback verified the update payment, customer, source subscription, selected method and unchanged billing date. Both original subscriptions already referenced the selected method on readback. The application still independently verifies every component rather than assuming provider-wide propagation.

Synthetic SQLite and fetch tests cover identity, replay, component races, renewal coverage, interval clipping, cancellation, payment propagation, deletion and phone ownership. They do not establish live billing, provider audio or PSTN acceptance.

## Provider costs and remaining phone gates

Telnyx's published Voice API fee is $0.002/min **plus** applicable inbound/outbound SIP fees. Its current billing article describes 60/60 increments and explicitly says six-second increments are no longer offered. Country/rate-deck terms can differ. Retail OpenFon rounding is independent of carrier rounding. Number setup/rental prices require actual `cost_information` quotes and regulatory review.

Phone ordering stays disabled until country, budget, regulatory requirements, direct carrier acceptance, rental billing and rental termination policy are verified. A subscription cancellation request does not silently release a business number. Account deletion's explicit release is a separate action. Public pricing tables are not account-specific quotes.

The direct Azure native `/openai/v1/live/sessions` GPT-Live price is still unverified. Azure Voice Live cascade pricing is a different product; Azure retail queries for GPT-Live returned transcription meters, not a verified conversation rate. No margin calculation or invented per-minute Azure rate is justified yet.

Sources:

- [Dodo multi-subscription checkout](https://docs.dodopayments.com/developer-resources/checkout-session#multi-subscription-cart)
- [Dodo usage billing](https://docs.dodopayments.com/developer-resources/usage-based-billing-guide)
- [Dodo subscription integration and minimum charges](https://docs.dodopayments.com/developer-resources/subscription-integration-guide)
- [Dodo hosted payment-method update](https://docs.dodopayments.com/api-reference/subscriptions/update-payment-method)
- [Dodo invoice retrieval](https://docs.dodopayments.com/api-reference/payments/get-invoice)
- [Telnyx billing increments](https://support.telnyx.com/en/articles/1130659-billing-increments)
- [Telnyx Voice API pricing](https://telnyx.com/pricing/call-control)

## Recovering an uncertain payment writer

There is deliberately no customer unlock or automatic expiry. Before operator recovery, stop admission of payment-update requests for the affected workspace, establish that the original application invocation is no longer running, and obtain provider confirmation that its action has settled. A single immediate GET after a timeout is insufficient proof that a delayed write cannot still land. Reconcile the hosted payment's ownership and selected method against every owned subscription, retaining the current job and provider identities. Only after that evidence may an operator repair the job and remove the exact writer token; never start a replacement authorization while the earlier mutation remains uncertain. No automated recovery endpoint is implemented. Billing remains gated until this operational recovery and invoice acceptance are ready.
