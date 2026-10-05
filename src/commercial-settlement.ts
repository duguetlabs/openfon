import type { CommercialEnv } from "./commercial-dodo";
import { BillingError, dodoRequest, chargingReady } from "./commercial-dodo";
import { retailOverage, usageHash } from "./commercial-usage";
import type { PlanId, BillingCadence } from "./commercial-types";

/** Recompute an immutable billing interval, never the month an adjustment arrived. */
export async function prepareUsageSettlement(
  env: CommercialEnv,
  businessId: string,
  cycleStart: string,
  now = Date.now(),
) {
  const period = await env.DB.prepare(
    `SELECT p.*,a.activated_at,a.retail_stopped_at,a.paid_through,(SELECT term_end FROM commercial_cancellations c WHERE c.business_id=p.business_id) term_end FROM commercial_billing_periods p JOIN commercial_accounts a ON a.business_id=p.business_id WHERE p.business_id=? AND p.period_start=?`,
  )
    .bind(businessId, cycleStart)
    .first<{
      period_start: string;
      period_end: string;
      plan_id: PlanId;
      cadence: BillingCadence;
      activated_at: string | null;
      retail_stopped_at: string | null;
      term_end: string | null;
      paid_through: string | null;
    }>();
  if (!period?.activated_at)
    throw new BillingError("No activated billing period exists.", 409);
  const start = Math.max(
      Date.parse(period.period_start),
      Date.parse(period.activated_at),
    ),
    end = Math.min(
      Date.parse(period.period_end),
      period.retail_stopped_at
        ? Date.parse(period.retail_stopped_at)
        : Infinity,
      period.term_end ? Date.parse(period.term_end) : Infinity,
      period.paid_through ? Date.parse(period.paid_through) : Infinity,
    );
  if (now < Date.parse(period.period_end))
    throw new BillingError("This billing period is still open.", 409);
  const pending = await env.DB.prepare(
    `SELECT c.id FROM calls c WHERE c.business_id=? AND NOT EXISTS(SELECT 1 FROM commercial_qa_calls q WHERE q.call_id=c.id) AND
  ((c.status='active' AND julianday(c.started_at)<julianday(?)) OR (c.connected_at IS NOT NULL AND julianday(c.connected_at)<julianday(?) AND (c.ended_at IS NULL OR julianday(c.ended_at)>julianday(?)) AND NOT EXISTS(SELECT 1 FROM commercial_call_usage u WHERE u.call_id=c.id))) LIMIT 1`,
  )
    .bind(businessId, period.period_end, period.period_end, period.period_start)
    .first();
  if (pending)
    throw new BillingError(
      "Call usage is still being reconciled for this period.",
      409,
    );
  const raw = await env.DB.prepare(
    `SELECT COALESCE(SUM(MAX(0,MIN(ended_at_ms,?)-MAX(connected_at_ms,?))),0) ms FROM commercial_call_usage u WHERE business_id=? AND ended_at_ms>? AND connected_at_ms<? AND NOT EXISTS(SELECT 1 FROM commercial_qa_calls q WHERE q.call_id=u.call_id)`,
  )
    .bind(end, start, businessId, start, end)
    .first<{ ms: number }>();
  const adjustments = await env.DB.prepare(
    "SELECT COALESCE(SUM(delta_ms),0) ms FROM commercial_usage_adjustments WHERE business_id=? AND cycle_start=? AND cycle_end=?",
  )
    .bind(businessId, period.period_start, period.period_end)
    .first<{ ms: number }>();
  const total = retailOverage(
    Math.max(0, (raw?.ms ?? 0) + (adjustments?.ms ?? 0)),
    period.plan_id,
    period.cadence,
  );
  const hash = await usageHash(
    JSON.stringify({
      businessId,
      cycleStart,
      end: period.period_end,
      plan: period.plan_id,
      cadence: period.cadence,
      ms: total.durationMs,
      cents: total.overageMinor,
    }),
  );
  const old = await env.DB.prepare(
    "SELECT id,state,overage_minor,computed_hash FROM commercial_usage_exports WHERE business_id=? AND cycle_start=? AND cycle_end=?",
  )
    .bind(businessId, period.period_start, period.period_end)
    .first<{
      id: string;
      state: string;
      overage_minor: number;
      computed_hash: string;
    }>();
  if (old && old.computed_hash !== hash) {
    // A MAX meter cannot undo an earlier amount. Preserve the sent evidence and
    // require an explicit credit/debit reconciliation; never send a lower MAX.
    if (["sending", "sent", "reconciliation_required"].includes(old.state)) {
      await env.DB.prepare(
        "UPDATE commercial_usage_exports SET state='reconciliation_required' WHERE id=?",
      )
        .bind(old.id)
        .run();
      return {
        id: old.id,
        state: "reconciliation_required",
        computedHash: hash,
        overageMinor: total.overageMinor,
        previousOverageMinor: old.overage_minor,
      };
    }
    await env.DB.prepare(
      "UPDATE commercial_usage_exports SET usage_ms=?,overage_minor=?,computed_hash=?,state='review' WHERE id=? AND state IN ('review','approved')",
    )
      .bind(total.durationMs, total.overageMinor, hash, old.id)
      .run();
  }
  const id = old?.id ?? crypto.randomUUID();
  if (!old)
    await env.DB.prepare(
      `INSERT INTO commercial_usage_exports(id,business_id,cycle_start,cycle_end,usage_ms,overage_minor,state,computed_hash,created_at) VALUES(?,?,?,?,?,?,'review',?,?)`,
    )
      .bind(
        id,
        businessId,
        period.period_start,
        period.period_end,
        total.durationMs,
        total.overageMinor,
        hash,
        new Date(now).toISOString(),
      )
      .run();
  return {
    id,
    state: old?.computed_hash === hash ? old.state : "review",
    computedHash: hash,
    overageMinor: total.overageMinor,
  };
}

/** Operator-reviewed only until invoice reconciliation and small-charge acceptance pass. */
export async function approveUsageSettlement(
  env: CommercialEnv,
  id: string,
  expectedHash: string,
) {
  const result = await env.DB.prepare(
    "UPDATE commercial_usage_exports SET state='approved' WHERE id=? AND computed_hash=? AND state='review' RETURNING id",
  )
    .bind(id, expectedHash)
    .first();
  if (!result)
    throw new BillingError("The settlement changed. Review it again.", 409);
  return { approved: true };
}
export async function publishUsageSettlement(
  env: CommercialEnv,
  id: string,
  now = Date.now(),
) {
  if (!chargingReady(env))
    throw new BillingError("Usage billing is not enabled.", 409);
  const record = await env.DB.prepare(
    `SELECT e.*,a.customer_id,i.event_name,a.provider_mode FROM commercial_usage_exports e JOIN commercial_accounts a ON a.business_id=e.business_id JOIN commercial_checkout_intents i ON i.id=a.subscription_id WHERE e.id=?`,
  )
    .bind(id)
    .first<any>();
  if (
    !record ||
    record.provider_mode !== env.DODO_MODE ||
    !["approved", "sending", "sent"].includes(record.state)
  )
    throw new BillingError("This settlement is not approved.", 409);
  if (record.state === "sent") return { sent: true, duplicate: true };
  const computed = await prepareUsageSettlement(
    env,
    record.business_id,
    record.cycle_start,
    now,
  );
  if (
    computed.computedHash !== record.computed_hash ||
    computed.state === "reconciliation_required"
  )
    throw new BillingError(
      "Usage changed. Reconcile this settlement before sending.",
      409,
    );
  // Backdating within a documented ingestion window is not proof an already
  // issued invoice will change. Such invoices still require separate matching.
  const timestamp = Date.parse(record.cycle_end) - 1;
  if (now - timestamp > 3600000 || timestamp > now) {
    await env.DB.prepare(
      "UPDATE commercial_usage_exports SET state='reconciliation_required' WHERE id=?",
    )
      .bind(id)
      .run();
    throw new BillingError(
      "This period needs invoice reconciliation. Usage will not be moved to another month.",
      409,
    );
  }
  const eventId = "openfon-" + record.computed_hash;
  const claimed = await env.DB.prepare(
    "UPDATE commercial_usage_exports SET state='sending',provider_reference=? WHERE id=? AND computed_hash=? AND state IN ('approved','sending') RETURNING id",
  )
    .bind(eventId, id, record.computed_hash)
    .first();
  if (!claimed)
    throw new BillingError("Settlement changed before sending.", 409);
  const result = await dodoRequest(env, "/events/ingest", "POST", {
    events: [
      {
        event_id: eventId,
        customer_id: record.customer_id,
        event_name: record.event_name,
        timestamp: new Date(timestamp).toISOString(),
        metadata: { cents: record.overage_minor },
      },
    ],
  });
  if (![0, 1].includes(result.ingested_count))
    throw new BillingError("Usage export needs reconciliation.", 409);
  await env.DB.prepare(
    "UPDATE commercial_usage_exports SET state='sent' WHERE id=? AND computed_hash=? AND state='sending'",
  )
    .bind(id, record.computed_hash)
    .run();
  return { sent: true, duplicate: result.ingested_count === 0 };
}
