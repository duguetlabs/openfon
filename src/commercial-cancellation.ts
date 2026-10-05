import { maintainCurrentUsage } from "./commercial-export";
import {
  BillingError,
  dodoRequest,
  providerId,
  type CommercialEnv,
} from "./commercial-dodo";

/** Cancel renewal as one product while retaining the customer's paid term. */
export async function requestCommercialCancellation(
  env: CommercialEnv,
  businessId: string,
) {
  const account = await env.DB.prepare(
    "SELECT cadence,status,provider_mode,customer_id FROM commercial_accounts WHERE business_id=?",
  )
    .bind(businessId)
    .first<{
      cadence: string;
      status: string;
      provider_mode: string;
      customer_id: string;
    }>();
  if (
    !account ||
    account.provider_mode !== env.DODO_MODE ||
    account.status !== "active"
  )
    throw new BillingError(
      "Your subscription needs reconciliation before cancellation. Please contact support.",
      409,
    );
  const role = account.cadence === "annual" ? "base" : "usage";
  const part = await env.DB.prepare(
    "SELECT subscription_id,product_id FROM commercial_subscription_components WHERE business_id=? AND role=?",
  )
    .bind(businessId, role)
    .first<{ subscription_id: string; product_id: string }>();
  if (!part)
    throw new BillingError("Your subscription needs reconciliation.", 409);
  const sub = await dodoRequest(env, "/subscriptions/" + part.subscription_id);
  if (
    sub.customer?.customer_id !== account.customer_id ||
    sub.product_id !== part.product_id ||
    sub.status !== "active" ||
    !Number.isFinite(Date.parse(sub.next_billing_date))
  )
    throw new BillingError(
      "Your subscription changed. Please refresh billing.",
      409,
    );
  const termEnd = new Date(Date.parse(sub.next_billing_date)).toISOString();
  const existing = await env.DB.prepare(
    "SELECT term_end,state FROM commercial_cancellations WHERE business_id=?",
  )
    .bind(businessId)
    .first<{ term_end: string; state: string }>();
  if (existing && existing.term_end !== termEnd)
    throw new BillingError(
      "Your cancellation needs reconciliation before another change.",
      409,
    );
  await env.DB.prepare(
    "INSERT INTO commercial_cancellations(business_id,term_end,state,requested_at) VALUES(?,?,'preparing',?) ON CONFLICT(business_id) DO NOTHING",
  )
    .bind(businessId, termEnd, new Date().toISOString())
    .run();
  // A declarative PATCH is retryable. Verify the retained paid date afterwards.
  if (!sub.cancel_at_next_billing_date)
    await dodoRequest(env, "/subscriptions/" + part.subscription_id, "PATCH", {
      cancel_at_next_billing_date: true,
    });
  const confirmed = await dodoRequest(
    env,
    "/subscriptions/" + part.subscription_id,
  );
  if (
    !confirmed.cancel_at_next_billing_date ||
    new Date(Date.parse(confirmed.next_billing_date)).toISOString() !== termEnd
  )
    throw new BillingError(
      "Cancellation confirmation is pending. Please retry.",
      409,
    );
  await env.DB.prepare(
    "UPDATE commercial_cancellations SET state='scheduled' WHERE business_id=? AND term_end=?",
  )
    .bind(businessId, termEnd)
    .run();
  return { scheduled: true, termEnd };
}

/** Run from the Worker schedule even if new checkouts are disabled. */
export async function finishDueCommercialCancellations(
  env: CommercialEnv,
  now = Date.now(),
) {
  const { results: jobs } = await env.DB.prepare(
    "SELECT c.business_id,c.term_end,a.customer_id,a.provider_mode FROM commercial_cancellations c JOIN commercial_accounts a ON a.business_id=c.business_id WHERE c.term_end<=? AND c.state IN ('preparing','scheduled','closing') ORDER BY c.term_end LIMIT 5",
  )
    .bind(new Date(now).toISOString())
    .all<{
      business_id: string;
      term_end: string;
      customer_id: string;
      provider_mode: string;
    }>();
  let completed = 0,
    pending = 0;
  for (const job of jobs) {
    try {
      if (job.provider_mode !== env.DODO_MODE)
        throw new BillingError("Cancellation mode mismatch.");
      await env.DB.prepare(
        "UPDATE commercial_cancellations SET state='closing' WHERE business_id=?",
      )
        .bind(job.business_id)
        .run();
      // Retail cutoff is the agreed term, irrespective of scheduler or API delay.
      await env.DB.prepare(
        "UPDATE commercial_accounts SET retail_stopped_at=CASE WHEN retail_stopped_at IS NULL OR retail_stopped_at>? THEN ? ELSE retail_stopped_at END WHERE business_id=?",
      )
        .bind(job.term_end, job.term_end, job.business_id)
        .run();
      const { results: parts } = await env.DB.prepare(
        "SELECT subscription_id,product_id FROM commercial_subscription_components WHERE business_id=?",
      )
        .bind(job.business_id)
        .all<{ subscription_id: string; product_id: string }>();
      if (!parts.length)
        throw new BillingError("Cancellation components missing.");
      for (const part of parts) {
        if (!providerId(part.subscription_id))
          throw new BillingError("Cancellation identity missing.");
        const sub = await dodoRequest(
          env,
          "/subscriptions/" + part.subscription_id,
        );
        if (
          sub.customer?.customer_id !== job.customer_id ||
          sub.product_id !== part.product_id
        )
          throw new BillingError("Cancellation ownership mismatch.");
        if (!["cancelled", "expired"].includes(sub.status))
          await dodoRequest(
            env,
            "/subscriptions/" + part.subscription_id,
            "PATCH",
            { status: "cancelled" },
          );
        const confirmed = await dodoRequest(
          env,
          "/subscriptions/" + part.subscription_id,
        );
        if (!["cancelled", "expired"].includes(confirmed.status))
          throw new BillingError("Cancellation still pending.");
      }
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE commercial_cancellations SET state='complete' WHERE business_id=?",
        ).bind(job.business_id),
        env.DB.prepare(
          "UPDATE commercial_accounts SET status='canceled',coverage_checked_at=? WHERE business_id=?",
        ).bind(new Date(now).toISOString(), job.business_id),
      ]);
      completed++;
    } catch {
      pending++;
    }
  }
  return { completed, pending };
}

/** Call every minute: bounded cancellation maintenance and separately gated usage export. */
export async function maintainCommercialBilling(
  env: CommercialEnv,
  now = Date.now(),
) {
  const { results: preparing } = await env.DB.prepare(
    "SELECT business_id FROM commercial_cancellations WHERE state='preparing' AND term_end>? ORDER BY requested_at LIMIT 5",
  )
    .bind(new Date(now).toISOString())
    .all<{ business_id: string }>();
  let pendingPreparation = 0;
  for (const job of preparing) {
    try {
      await requestCommercialCancellation(env, job.business_id);
    } catch {
      pendingPreparation++;
    }
  }
  return {
    ...(await finishDueCommercialCancellations(env, now)),
    pendingPreparation,
    usage: await maintainCurrentUsage(env, now),
  };
}
