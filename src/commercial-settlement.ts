import type { CommercialEnv } from "./commercial-dodo";
import { BillingError, dodoRequest, chargingReady } from "./commercial-dodo";
import {
  retailOverage,
  usageHash,
  coveredRetailMilliseconds,
} from "./commercial-usage";
import type { PlanId, BillingCadence } from "./commercial-types";

type SettlementRecord = {
  id: string;
  business_id: string;
  cycle_start: string;
  cycle_end: string;
  usage_ms: number;
  overage_minor: number;
  state: string;
  provider_reference: string | null;
  computed_hash: string;
  created_at: string;
};

async function requireInvoiceReconciliation(
  env: CommercialEnv,
  old: SettlementRecord,
  now: number,
) {
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO commercial_usage_invoice_evidence(id,settlement_id,business_id,kind,snapshot_json,proof_json,recorded_at)
      SELECT ?,id,business_id,'invoice_snapshot',json_object('id',id,'business_id',business_id,'cycle_start',cycle_start,'cycle_end',cycle_end,'usage_ms',usage_ms,'overage_minor',overage_minor,'state',state,'provider_reference',provider_reference,'computed_hash',computed_hash,'created_at',created_at),
      '{"source":"previously_invoice_reconciled"}',?
      FROM commercial_usage_exports WHERE id=? AND computed_hash=? AND state='invoice_reconciled'`,
    ).bind(
      crypto.randomUUID(),
      new Date(now).toISOString(),
      old.id,
      old.computed_hash,
    ),
    env.DB.prepare(
      "UPDATE commercial_usage_exports SET state='reconciliation_required' WHERE id=? AND computed_hash=? RETURNING id",
    ).bind(old.id, old.computed_hash),
  ]);
  if (!result[1].results.length)
    throw new BillingError("The settlement changed. Review it again.", 409);
}

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
  const raw = await coveredRetailMilliseconds(env, businessId, start, end);
  const adjustments = await env.DB.prepare(
    "SELECT COALESCE(SUM(delta_ms),0) ms FROM commercial_usage_adjustments WHERE business_id=? AND cycle_start=? AND cycle_end=?",
  )
    .bind(businessId, period.period_start, period.period_end)
    .first<{ ms: number }>();
  const total = retailOverage(
    Math.max(0, raw + (adjustments?.ms ?? 0)),
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
    "SELECT * FROM commercial_usage_exports WHERE business_id=? AND cycle_start=? AND cycle_end=?",
  )
    .bind(businessId, period.period_start, period.period_end)
    .first<SettlementRecord>();
  const automatic = await env.DB.prepare(
    `SELECT COALESCE(MAX(overage_minor),0) maximum,
    COALESCE(MAX(CASE WHEN state IN ('sending','reconciliation_required') THEN 1 ELSE 0 END),0) uncertain
    FROM commercial_usage_snapshots WHERE business_id=? AND cycle_start=? AND state NOT IN ('prepared','superseded')`,
  )
    .bind(businessId, period.period_start)
    .first<{ maximum: number; uncertain: number }>();
  // An explicit verified credit may settle a lower amount than an immutable
  // historical MAX event. Do not repeatedly reopen that same proven snapshot.
  // Uncertain sends still require their own reconciliation.
  const correctedInvoice =
    old?.state === "invoice_reconciled" &&
    old.computed_hash === hash &&
    (await env.DB.prepare(
      `SELECT id FROM commercial_usage_invoice_evidence
      WHERE settlement_id=? AND kind='correction'
      AND json_extract(snapshot_json,'$.computed_hash')=?
      AND json_extract(snapshot_json,'$.usage_ms')=? AND json_extract(snapshot_json,'$.overage_minor')=?
      AND json_extract(snapshot_json,'$.provider_reference')=? LIMIT 1`,
    )
      .bind(
        old.id,
        hash,
        total.durationMs,
        total.overageMinor,
        old.provider_reference,
      )
      .first());
  if (
    automatic &&
    (automatic.uncertain ||
      (automatic.maximum > total.overageMinor && !correctedInvoice))
  ) {
    if (old) await requireInvoiceReconciliation(env, old, now);
    // The existing row was already guarded above. Never reopen a newer invoice
    // installed while that guarded transition was returning to this invocation.
    const conflict =
      old ??
      (await env.DB.prepare(
        `INSERT INTO commercial_usage_exports(id,business_id,cycle_start,cycle_end,usage_ms,overage_minor,state,computed_hash,created_at)
      VALUES(?,?,?,?,?,?,'reconciliation_required',?,?) ON CONFLICT(business_id,cycle_start,cycle_end)
      DO NOTHING RETURNING id`,
      )
        .bind(
          crypto.randomUUID(),
          businessId,
          period.period_start,
          period.period_end,
          total.durationMs,
          total.overageMinor,
          hash,
          new Date(now).toISOString(),
        )
        .first<{ id: string }>());
    if (!conflict)
      throw new BillingError("The settlement changed. Review it again.", 409);
    return {
      id: conflict!.id,
      state: "reconciliation_required",
      computedHash: hash,
      overageMinor: total.overageMinor,
      usageMs: total.durationMs,
      previousOverageMinor: automatic.maximum,
    };
  }
  if (old && old.computed_hash !== hash) {
    // A MAX meter cannot undo an earlier amount. Preserve the sent evidence and
    // require an explicit credit/debit reconciliation; never send a lower MAX.
    if (!["review", "approved"].includes(old.state)) {
      await requireInvoiceReconciliation(env, old, now);
      return {
        id: old.id,
        state: "reconciliation_required",
        computedHash: hash,
        overageMinor: total.overageMinor,
        usageMs: total.durationMs,
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
    usageMs: total.durationMs,
  };
}

/** Internal operator attestation AFTER external invoice/credit verification.
 * No HTTP route, provider mutation, inferred credit, or automatic rebilling.
 */
export async function recordUsageInvoiceCorrection(
  env: CommercialEnv,
  id: string,
  expectedHash: string,
  proof: {
    invoiceReference: string;
    correctionReference: string;
    verifiedBy: string;
  },
  now = Date.now(),
) {
  if (
    !/^[a-f0-9]{64}$/.test(expectedHash) ||
    !proof ||
    ![
      proof.invoiceReference,
      proof.correctionReference,
      proof.verifiedBy,
    ].every((v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(v))
  )
    throw new BillingError(
      "Explicit invoice correction evidence is required.",
      400,
    );
  const proofJson = JSON.stringify({
    invoiceReference: proof.invoiceReference,
    correctionReference: proof.correctionReference,
    verifiedBy: proof.verifiedBy,
  });
  const proofId = await usageHash(
    JSON.stringify({ id, expectedHash, proof: proofJson }),
  );
  const existing = await env.DB.prepare(
    "SELECT id FROM commercial_usage_invoice_evidence WHERE settlement_id=? AND correction_reference=?",
  )
    .bind(id, proof.correctionReference)
    .first<{ id: string }>();
  if (existing) {
    if (existing.id !== proofId)
      throw new BillingError(
        "Correction evidence already belongs to a different snapshot.",
        409,
      );
    return { recorded: true, duplicate: true, computedHash: expectedHash };
  }
  const before = await env.DB.prepare(
    "SELECT * FROM commercial_usage_exports WHERE id=?",
  )
    .bind(id)
    .first<SettlementRecord>();
  if (!before) throw new BillingError("Settlement not found.", 409);
  const candidate = await prepareUsageSettlement(
    env,
    before.business_id,
    before.cycle_start,
    now,
  );
  if (
    candidate.computedHash !== expectedHash ||
    candidate.state !== "reconciliation_required"
  )
    throw new BillingError(
      "The correction changed. Review the current invoice evidence.",
      409,
    );
  const snapshot = {
    ...before,
    usage_ms: candidate.usageMs,
    overage_minor: candidate.overageMinor,
    state: "invoice_reconciled",
    provider_reference: proof.invoiceReference,
    computed_hash: expectedHash,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO commercial_usage_invoice_evidence(id,settlement_id,business_id,kind,snapshot_json,proof_json,correction_reference,recorded_at)
      SELECT ?,id,business_id,'correction',?,?,?,? FROM commercial_usage_exports
      WHERE id=? AND computed_hash=? AND state='reconciliation_required'
      AND EXISTS(SELECT 1 FROM commercial_usage_invoice_evidence e WHERE e.settlement_id=commercial_usage_exports.id AND e.kind='invoice_snapshot')
      ON CONFLICT(id) DO NOTHING`,
    ).bind(
      proofId,
      JSON.stringify(snapshot),
      proofJson,
      proof.correctionReference,
      new Date(now).toISOString(),
      id,
      before.computed_hash,
    ),
    env.DB.prepare(
      `UPDATE commercial_usage_exports SET usage_ms=?,overage_minor=?,computed_hash=?,provider_reference=?,state='invoice_reconciled'
      WHERE id=? AND computed_hash=? AND state='reconciliation_required' AND EXISTS(SELECT 1 FROM commercial_usage_invoice_evidence WHERE id=?)`,
    ).bind(
      candidate.usageMs,
      candidate.overageMinor,
      expectedHash,
      proof.invoiceReference,
      id,
      before.computed_hash,
      proofId,
    ),
  ]);
  if (
    !(await env.DB.prepare(
      "SELECT id FROM commercial_usage_invoice_evidence WHERE id=?",
    )
      .bind(proofId)
      .first())
  )
    throw new BillingError(
      "The settlement changed before correction. Review it again.",
      409,
    );
  return { recorded: true, duplicate: false, computedHash: expectedHash };
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
  let duplicate = false;
  try {
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
    duplicate = result.ingested_count === 0;
    if (duplicate) {
      const event = await dodoRequest(env, "/events/" + eventId);
      if (
        event.event_id !== eventId ||
        event.customer_id !== record.customer_id ||
        event.event_name !== record.event_name ||
        event.metadata?.cents !== record.overage_minor ||
        Date.parse(event.timestamp) !== timestamp
      )
        throw new BillingError("Usage export needs reconciliation.", 409);
    }
  } catch {
    await env.DB.prepare(
      "UPDATE commercial_usage_exports SET state='reconciliation_required' WHERE id=? AND computed_hash=? AND state='sending'",
    )
      .bind(id, record.computed_hash)
      .run();
    throw new BillingError("Usage export needs reconciliation.", 409);
  }
  await env.DB.prepare(
    "UPDATE commercial_usage_exports SET state='sent' WHERE id=? AND computed_hash=? AND state='sending'",
  )
    .bind(id, record.computed_hash)
    .run();
  return { sent: true, duplicate };
}
