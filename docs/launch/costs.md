# Measured cost worksheet

Blank worksheet: **no measured example bill is available for this release**. There is no universal per-minute price. Use actual provider usage and invoices for one defined window; record currency, taxes, credits and rounding. MIT software carries no OpenFon license fee, but operations still have costs.

## Fill in a single observation window

- Start / end / currency / release commit:
- Engine, model, speech provider, carrier and country (if applicable):
- Attempted calls / connected calls / completed tasks:
- Connected conversation seconds (define start/end consistently):
- Rate-source invoice or dated provider quote reference (no secrets):

| Cost component | Metered quantity | Billing unit size | Price per billing unit | Extended cost |
| --- | --- | --- | --- | --- |
| Text input tokens (including summaries where used) | | | | |
| Text output tokens | | | | |
| Transcription audio | | | | |
| Speech synthesis characters/audio | | | | |
| Realtime input audio/text | | | | |
| Realtime output audio/text | | | | |
| GPT-Live session seconds (`gpt-live-1` bills per second of session, plus its delegation model's tokens) | | | | |
| Cloudflare requests, compute, storage and D1 | | | | |
| Carrier inbound/forwarded minutes or media fees | | | | |
| Other usage actually billed | | | | |

For each line: `extended_cost = billed_quantity / billing_unit_size × unit_price`.
Use the provider’s billed quantity **after its rounding/minimum rules**. Split cached/non-cached tokens, models, languages or price tiers into separate rows when rates differ. Only enter components actually billed: do not charge pipeline STT/TTS again for a realtime bundle that already includes them. Browser synthesis has no separately metered server TTS charge in this app, but device/service behavior is not a promise that every third-party voice is free.

Record fixed costs separately: number rental, hosting minimums, subscriptions and other recurring charges. Allocate shared fixed costs using a declared rule, such as this instance’s share of total usage; do not quietly assign the entire shared bill to a few test calls. Keep maintainer time separate, or state the hourly rate if estimating a fully loaded cost.

```text
variable_cost = sum(extended_cost for all applicable lines)
allocated_fixed_cost = sum(fixed charges assigned to this window and instance)
operating_cost_before_tax = variable_cost + allocated_fixed_cost
cash_paid = operating_cost_before_tax + applicable_tax - applied_credits
connected_minutes = connected_conversation_seconds / 60
cost_per_connected_minute = operating_cost_before_tax / connected_minutes
cost_per_completed_task = operating_cost_before_tax / completed_tasks
```

If a denominator is zero, report **not applicable**, not zero cost. Failed calls and retries still belong in the numerator if billed; disclose them. Report pre-credit operating cost alongside cash paid so introductory credits do not imply a lasting price. Carrier-billed minutes may differ from connected conversation minutes: keep both.

## Reconcile before sharing

Match the observation window to provider exports/invoices, separate unrelated traffic, and explain any residual difference, invoice lag or rounding. Record estimated/unbilled items as estimates. Attach only sanitized totals. Publish sample size, duration, engine/model, currency, dated rates, fixed-cost allocation and exclusions with every cost claim. Compare providers only on the same scenario and successful outcome definition.

A forecast can use `fixed monthly costs + expected monthly usage × measured variable cost per usage unit`, but label it a forecast and retain the underlying measured window. Do not extrapolate a synthetic local test into a provider bill.
