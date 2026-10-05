import {
  chargingReady,
  dodoRequest,
  reconcileSubscription,
  type CommercialEnv,
} from "./commercial-dodo";
import {
  coveredRetailMilliseconds,
  COVERED_RETAIL_MILLISECONDS_SQL,
  retailOverage,
  usageHash,
} from "./commercial-usage";
import type { BillingCadence, PlanId } from "./commercial-types";

type Context = {
  business_id: string;
  period_start: string;
  period_end: string;
  subscription_id: string;
  plan_id: PlanId;
  cadence: BillingCadence;
  status: string;
  customer_id: string;
  provider_mode: string;
  activated_at: string;
  paid_through: string | null;
  retail_stopped_at: string | null;
  term_end: string | null;
  event_name: string;
  deleting: number;
  component_start: string | null;
  component_end: string | null;
  component_subscription: string | null;
};
async function context(env: CommercialEnv, businessId: string, start: string) {
  return env.DB.prepare(
    `SELECT p.*,a.status,a.customer_id,a.provider_mode,a.activated_at,a.paid_through,a.retail_stopped_at,i.event_name,
 c.term_end,u.period_start component_start,u.period_end component_end,u.subscription_id component_subscription,
 EXISTS(SELECT 1 FROM commercial_deletion_jobs d WHERE d.business_id=p.business_id) deleting
 FROM commercial_billing_periods p JOIN commercial_accounts a ON a.business_id=p.business_id
 JOIN commercial_checkout_intents i ON i.id=a.subscription_id AND i.business_id=a.business_id
 LEFT JOIN commercial_cancellations c ON c.business_id=p.business_id
 LEFT JOIN commercial_subscription_components u ON u.business_id=p.business_id AND u.role='usage'
 WHERE p.business_id=? AND p.period_start=?`,
  )
    .bind(businessId, start)
    .first<Context>();
}
async function flag(
  env: CommercialEnv,
  businessId: string,
  start: string,
  reason: string,
) {
  await env.DB.prepare(
    "UPDATE commercial_usage_streams SET state='reconciliation_required',reason=? WHERE business_id=? AND cycle_start=?",
  )
    .bind(reason, businessId, start)
    .run();
  return { state: "reconciliation_required", reason };
}
function availability(c: Context, now: number): string | null {
  if (c.deleting) return "account_deletion";
  if (Date.parse(c.period_start) > now || Date.parse(c.period_end) <= now)
    return "period_closed";
  if (c.retail_stopped_at && Date.parse(c.retail_stopped_at) <= now)
    return "retail_stopped";
  if (c.term_end && Date.parse(c.term_end) <= now) return "cancellation_cutoff";
  if (
    c.status !== "active" ||
    !c.paid_through ||
    Date.parse(c.paid_through) <= now
  )
    return "coverage_pending";
  if (
    c.component_subscription !== c.subscription_id ||
    c.component_start !== c.period_start ||
    c.component_end !== c.period_end
  )
    return "period_identity_changed";
  return null;
}
async function total(env: CommercialEnv, c: Context, now: number) {
  const end = Math.min(
    now,
    Date.parse(c.period_end),
    Date.parse(c.paid_through!),
    c.term_end ? Date.parse(c.term_end) : now,
    c.retail_stopped_at ? Date.parse(c.retail_stopped_at) : now,
  );
  const ms = await coveredRetailMilliseconds(
    env,
    c.business_id,
    Math.max(Date.parse(c.period_start), Date.parse(c.activated_at)),
    end,
    now,
  );
  return retailOverage(ms, c.plan_id, c.cadence);
}

/** Publish only finalized calls in the still-current, verified usage mandate.
 * Ingestion is not invoice confirmation. Uncertain writes never unlock by expiry.
 */
export async function exportCurrentUsage(
  env: CommercialEnv,
  businessId: string,
  start: string,
  now = Date.now(),
) {
  if (!chargingReady(env)) return { state: "disabled" };
  let c = await context(env, businessId, start);
  if (!c || c.provider_mode !== env.DODO_MODE || !c.activated_at)
    return { state: "unavailable" };
  const stamp = new Date(now).toISOString();
  await env.DB.prepare(
    `INSERT INTO commercial_usage_streams(business_id,cycle_start,cycle_end,last_checked_at) VALUES(?,?,?,?)
 ON CONFLICT(business_id,cycle_start) DO UPDATE SET last_checked_at=excluded.last_checked_at`,
  )
    .bind(businessId, start, c.period_end, stamp)
    .run();
  const stream = await env.DB.prepare(
    "SELECT state,last_usage_ms,last_overage_minor FROM commercial_usage_streams WHERE business_id=? AND cycle_start=?",
  )
    .bind(businessId, start)
    .first<{
      state: string;
      last_usage_ms: number;
      last_overage_minor: number;
    }>();
  if (stream?.state === "reconciliation_required")
    return { state: stream.state };
  let blocked = availability(c, now);
  if (blocked === "coverage_pending")
    return { state: "pending", reason: blocked };
  if (blocked) return flag(env, businessId, start, blocked);
  if (
    await env.DB.prepare(
      "SELECT id FROM commercial_usage_adjustments WHERE business_id=? AND cycle_start=? LIMIT 1",
    )
      .bind(businessId, start)
      .first()
  )
    return flag(env, businessId, start, "usage_adjustment");
  const unresolved = await env.DB.prepare(
    "SELECT state FROM commercial_usage_snapshots WHERE business_id=? AND cycle_start=? AND state IN ('sending','reconciliation_required') LIMIT 1",
  )
    .bind(businessId, start)
    .first<{ state: string }>();
  if (unresolved)
    return {
      state: "reconciliation_required",
      reason: "provider_confirmation_pending",
    };
  let amount = await total(env, c, now);
  if (
    amount.durationMs < (stream?.last_usage_ms ?? 0) ||
    amount.overageMinor < (stream?.last_overage_minor ?? 0)
  )
    return flag(env, businessId, start, "downward_usage");
  if (amount.overageMinor <= (stream?.last_overage_minor ?? 0)) {
    await env.DB.prepare(
      "UPDATE commercial_usage_streams SET last_usage_ms=MAX(last_usage_ms,?) WHERE business_id=? AND cycle_start=?",
    )
      .bind(amount.durationMs, businessId, start)
      .run();
    return { state: "unchanged" };
  }
  // Reuse full enrollment validation: customer/product/amount/currency/meter,
  // current dates and both annual components, not merely an active local flag.
  const { results: parts } = await env.DB.prepare(
    "SELECT subscription_id FROM commercial_subscription_components WHERE business_id=? ORDER BY role",
  )
    .bind(businessId)
    .all<{ subscription_id: string }>();
  try {
    for (const part of parts)
      await reconcileSubscription(env, part.subscription_id, stamp);
  } catch {
    return { state: "pending", reason: "mandate_verification" };
  }
  c = await context(env, businessId, start);
  if (!c) return { state: "unavailable" };
  blocked = availability(c, now);
  if (blocked === "coverage_pending")
    return { state: "pending", reason: blocked };
  if (blocked) return flag(env, businessId, start, blocked);
  amount = await total(env, c, now);
  if (
    amount.durationMs < (stream?.last_usage_ms ?? 0) ||
    amount.overageMinor < (stream?.last_overage_minor ?? 0)
  )
    return flag(env, businessId, start, "downward_usage");
  if (amount.overageMinor <= (stream?.last_overage_minor ?? 0))
    return { state: "unchanged" };
  const id =
    "openfon-live-" +
    (await usageHash(
      JSON.stringify({
        businessId,
        start,
        end: c.period_end,
        subscription: c.subscription_id,
        customer: c.customer_id,
        mode: c.provider_mode,
        event: c.event_name,
        ms: amount.durationMs,
        cents: amount.overageMinor,
      }),
    ));
  await env.DB.prepare(
    `INSERT INTO commercial_usage_snapshots(id,business_id,cycle_start,cycle_end,subscription_id,customer_id,provider_mode,event_name,event_timestamp,usage_ms,overage_minor,state,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?) ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      id,
      businessId,
      start,
      c.period_end,
      c.subscription_id,
      c.customer_id,
      c.provider_mode,
      c.event_name,
      stamp,
      amount.durationMs,
      amount.overageMinor,
      stamp,
    )
    .run();
  // A single current-period writer; duplicate runs cannot emit concurrent or
  // replacement payloads while an earlier provider request is unresolved.
  const claimed = await env.DB.prepare(
    `UPDATE commercial_usage_snapshots SET state='sending' WHERE id=? AND state='prepared'
 AND NOT EXISTS(SELECT 1 FROM commercial_usage_snapshots other WHERE other.business_id=? AND other.cycle_start=? AND other.id<>? AND other.state IN ('sending','reconciliation_required'))
 AND EXISTS(SELECT 1 FROM commercial_usage_streams s WHERE s.business_id=? AND s.cycle_start=? AND s.state='active' AND s.last_overage_minor<?)
 AND EXISTS(SELECT 1 FROM commercial_accounts a JOIN commercial_subscription_components u ON u.business_id=a.business_id AND u.role='usage'
 WHERE a.business_id=? AND a.status='active' AND a.provider_mode=? AND a.customer_id=? AND a.paid_through>?
 AND (a.retail_stopped_at IS NULL OR a.retail_stopped_at>?) AND u.subscription_id=? AND u.period_start=? AND u.period_end=? AND u.period_end>?)
 AND NOT EXISTS(SELECT 1 FROM commercial_cancellations WHERE business_id=? AND term_end<=?)
 AND NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)
 AND NOT EXISTS(SELECT 1 FROM commercial_usage_adjustments WHERE business_id=? AND cycle_start=?)
 AND ? = (${COVERED_RETAIL_MILLISECONDS_SQL}) RETURNING id`,
  )
    .bind(
      id,
      businessId,
      start,
      id,
      businessId,
      start,
      amount.overageMinor,
      businessId,
      c.provider_mode,
      c.customer_id,
      stamp,
      stamp,
      c.subscription_id,
      start,
      c.period_end,
      stamp,
      businessId,
      stamp,
      businessId,
      businessId,
      start,
      amount.durationMs,
      businessId,
      now,
      Math.max(Date.parse(start), Date.parse(c.activated_at)),
      businessId,
      Math.max(Date.parse(start), Date.parse(c.activated_at)),
      now,
      now,
    )
    .first();
  if (!claimed) return { state: "pending", reason: "snapshot_changed" };
  const record = await env.DB.prepare(
    "SELECT * FROM commercial_usage_snapshots WHERE id=?",
  )
    .bind(id)
    .first<{
      event_timestamp: string;
      customer_id: string;
      event_name: string;
      overage_minor: number;
    }>();
  if (!record) return flag(env, businessId, start, "snapshot_missing");
  // Never move a delayed event into a new month or mutate its original timestamp.
  const sendNow = Date.now();
  const sendingContext = await context(env, businessId, start);
  if (!sendingContext || availability(sendingContext, sendNow)) {
    await env.DB.prepare(
      "UPDATE commercial_usage_snapshots SET state='reconciliation_required' WHERE id=?",
    )
      .bind(id)
      .run();
    return flag(env, businessId, start, "mandate_changed_before_send");
  }
  if (
    sendNow >= Date.parse(c.period_end) ||
    sendNow - Date.parse(record.event_timestamp) > 3600000 ||
    Date.parse(record.event_timestamp) - sendNow > 300000
  ) {
    await env.DB.prepare(
      "UPDATE commercial_usage_snapshots SET state='reconciliation_required' WHERE id=?",
    )
      .bind(id)
      .run();
    return flag(env, businessId, start, "event_window_expired");
  }
  try {
    const result = await dodoRequest(env, "/events/ingest", "POST", {
      events: [
        {
          event_id: id,
          customer_id: record.customer_id,
          event_name: record.event_name,
          timestamp: record.event_timestamp,
          metadata: { cents: record.overage_minor },
        },
      ],
    });
    if (![0, 1].includes(result.ingested_count))
      throw Error("Ingestion not confirmed");
    // A zero count is only safe if the exact durable event can be read back.
    if (result.ingested_count === 0) {
      const event = await dodoRequest(env, "/events/" + id);
      if (
        event.event_id !== id ||
        event.customer_id !== record.customer_id ||
        event.event_name !== record.event_name ||
        event.metadata?.cents !== record.overage_minor ||
        Date.parse(event.timestamp) !== Date.parse(record.event_timestamp)
      )
        throw Error("Event identity mismatch");
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE commercial_usage_snapshots SET state='ingested',confirmed_at=? WHERE id=? AND state='sending'",
      ).bind(new Date().toISOString(), id),
      env.DB.prepare(
        "UPDATE commercial_usage_streams SET last_usage_ms=MAX(last_usage_ms,?),last_overage_minor=MAX(last_overage_minor,?) WHERE business_id=? AND cycle_start=?",
      ).bind(amount.durationMs, amount.overageMinor, businessId, start),
    ]);
    return { state: "ingested", overageMinor: amount.overageMinor };
  } catch {
    await env.DB.prepare(
      "UPDATE commercial_usage_snapshots SET state='reconciliation_required' WHERE id=?",
    )
      .bind(id)
      .run();
    return flag(env, businessId, start, "provider_result_uncertain");
  }
}

/** Five least-recently checked periods per minute; no global scans or retries of uncertain writes. */
export async function maintainCurrentUsage(
  env: CommercialEnv,
  now = Date.now(),
) {
  if (!chargingReady(env)) return { disabled: true, checked: 0, pending: 0 };
  const { results: periods } = await env.DB.prepare(
    `SELECT p.business_id,p.period_start FROM commercial_billing_periods p
 JOIN commercial_accounts a ON a.business_id=p.business_id
 JOIN commercial_checkout_intents i ON i.id=a.subscription_id AND i.business_id=a.business_id
 LEFT JOIN commercial_usage_streams s ON s.business_id=p.business_id AND s.cycle_start=p.period_start
 WHERE a.provider_mode=? AND a.activated_at IS NOT NULL AND p.period_start<=? AND (s.state IS NULL OR s.state='active')
 ORDER BY (p.period_end>?) DESC,COALESCE(s.last_checked_at,'') ASC,p.period_start DESC LIMIT 5`,
  )
    .bind(
      env.DODO_MODE!,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    )
    .all<{ business_id: string; period_start: string }>();
  let pending = 0;
  for (const period of periods) {
    try {
      const result = await exportCurrentUsage(
        env,
        period.business_id,
        period.period_start,
        now,
      );
      if (!["ingested", "unchanged"].includes(result.state)) pending++;
    } catch {
      pending++;
    }
  }
  return { disabled: false, checked: periods.length, pending };
}
