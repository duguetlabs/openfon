import {
  BillingError,
  dodoRequest,
  providerId,
  hostedUrl,
  commercialOrigin,
  type CommercialEnv,
} from "./commercial-dodo";

async function paymentAccount(env: CommercialEnv, businessId: string) {
  const account = await env.DB.prepare(
    "SELECT customer_id,provider_mode FROM commercial_accounts WHERE business_id=?",
  )
    .bind(businessId)
    .first<{ customer_id: string; provider_mode: string }>();
  if (
    !account ||
    account.provider_mode !== env.DODO_MODE ||
    !providerId(account.customer_id)
  )
    throw new BillingError("Billing details are not available.", 409);
  if (
    await env.DB.prepare(
      "SELECT business_id FROM commercial_deletion_jobs WHERE business_id=?",
    )
      .bind(businessId)
      .first()
  )
    throw new BillingError("Account deletion is in progress.", 409);
  return account;
}
export async function beginPaymentMethodUpdate(
  env: CommercialEnv,
  businessId: string,
) {
  const account = await paymentAccount(env, businessId);
  const existing = await env.DB.prepare(
    "SELECT state,payment_link FROM commercial_payment_updates WHERE business_id=? AND state<>'complete'",
  )
    .bind(businessId)
    .first<{ state: string; payment_link: string | null }>();
  if (existing) {
    if (existing.payment_link) return { url: hostedUrl(existing.payment_link) };
    throw new BillingError(
      "A payment update is being reconciled. Please retry its status.",
      409,
    );
  }
  const source = await env.DB.prepare(
    "SELECT subscription_id FROM commercial_subscription_components WHERE business_id=? AND role='usage'",
  )
    .bind(businessId)
    .first<{ subscription_id: string }>();
  if (!source)
    throw new BillingError("Subscription details need reconciliation.", 409);
  const sub = await dodoRequest(
    env,
    "/subscriptions/" + source.subscription_id,
  );
  if (
    sub.customer?.customer_id !== account.customer_id ||
    !["active", "on_hold"].includes(sub.status)
  )
    throw new BillingError(
      "This subscription cannot update its payment method yet.",
      409,
    );
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO commercial_payment_updates(business_id,id,source_subscription_id,state,created_at) VALUES(?,?,?,'preparing',?) ON CONFLICT(business_id) DO UPDATE SET id=excluded.id,source_subscription_id=excluded.source_subscription_id,state='preparing',created_at=excluded.created_at,payment_id=NULL,payment_link=NULL,method_id=NULL WHERE commercial_payment_updates.state='complete'",
  )
    .bind(businessId, id, source.subscription_id, new Date().toISOString())
    .run();
  const won = await env.DB.prepare(
    "SELECT id FROM commercial_payment_updates WHERE business_id=?",
  )
    .bind(businessId)
    .first<{ id: string }>();
  if (won?.id !== id)
    throw new BillingError(
      "Another payment update is already in progress.",
      409,
    );
  const response = await dodoRequest(
    env,
    "/subscriptions/" + source.subscription_id + "/update-payment-method",
    "POST",
    { type: "new", return_url: commercialOrigin(env) + "/settings/billing" },
  );
  if (!providerId(response.payment_id))
    throw new BillingError(
      "Payment update is being reconciled. Please contact support.",
      409,
    );
  const url = hostedUrl(response.payment_link);
  await env.DB.prepare(
    "UPDATE commercial_payment_updates SET payment_id=?,payment_link=?,state='pending' WHERE business_id=? AND id=?",
  )
    .bind(response.payment_id, url, businessId, id)
    .run();
  return { url };
}
export async function reconcilePaymentMethodUpdate(
  env: CommercialEnv,
  businessId: string,
) {
  const account = await paymentAccount(env, businessId),
    job = await env.DB.prepare(
      "SELECT * FROM commercial_payment_updates WHERE business_id=?",
    )
      .bind(businessId)
      .first<any>();
  if (!job) throw new BillingError("There is no payment update to check.", 409);
  if (job.state === "complete") return { updated: true };
  if (!providerId(job.payment_id))
    throw new BillingError(
      "This payment update needs support to reconcile.",
      409,
    );
  const payment = await dodoRequest(env, "/payments/" + job.payment_id);
  if (
    payment.customer?.customer_id !== account.customer_id ||
    payment.subscription_id !== job.source_subscription_id ||
    payment.is_update_payment_method !== true
  )
    throw new BillingError(
      "Payment update ownership could not be verified.",
      409,
    );
  if (payment.status !== "succeeded") return { updated: false, pending: true };
  const source = await dodoRequest(
      env,
      "/subscriptions/" + job.source_subscription_id,
    ),
    method = payment.payment_method_id;
  if (
    !providerId(method) ||
    source.customer?.customer_id !== account.customer_id ||
    source.payment_method_id !== method
  )
    throw new BillingError(
      "Payment authorization is still being reconciled. Please retry.",
      409,
    );
  if (job.method_id && job.method_id !== method)
    throw new BillingError(
      "Payment update changed. Please contact support.",
      409,
    );
  await env.DB.prepare(
    "UPDATE commercial_payment_updates SET method_id=?,state='propagating' WHERE business_id=? AND id=?",
  )
    .bind(method, businessId, job.id)
    .run();
  const { results: parts } = await env.DB.prepare(
    "SELECT subscription_id,product_id FROM commercial_subscription_components WHERE business_id=?",
  )
    .bind(businessId)
    .all<{ subscription_id: string; product_id: string }>();
  for (const part of parts) {
    const current = await dodoRequest(
      env,
      "/subscriptions/" + part.subscription_id,
    );
    if (
      current.customer?.customer_id !== account.customer_id ||
      current.product_id !== part.product_id
    )
      throw new BillingError(
        "Subscription ownership changed. Please contact support.",
        409,
      );
    if (current.payment_method_id !== method)
      await dodoRequest(
        env,
        "/subscriptions/" + part.subscription_id + "/update-payment-method",
        "POST",
        { type: "existing", payment_method_id: method },
      );
    const confirmed = await dodoRequest(
      env,
      "/subscriptions/" + part.subscription_id,
    );
    if (confirmed.payment_method_id !== method)
      throw new BillingError(
        "Your payment method is still being applied to the complete subscription. Please retry.",
        409,
      );
  }
  await env.DB.prepare(
    "UPDATE commercial_payment_updates SET state='complete',payment_link=NULL WHERE business_id=? AND id=? AND method_id=?",
  )
    .bind(businessId, job.id, method)
    .run();
  return { updated: true };
}
export async function listCommercialInvoices(
  env: CommercialEnv,
  businessId: string,
) {
  await paymentAccount(env, businessId);
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT payment_id AS id,amount_minor AS amountMinor,currency,occurred_at AS date FROM commercial_payment_events WHERE business_id=? AND payment_id IS NOT NULL AND event_type='payment.succeeded' ORDER BY occurred_at DESC LIMIT 50",
  )
    .bind(businessId)
    .all();
  return { invoices: results };
}
export async function getCommercialInvoice(
  env: CommercialEnv,
  businessId: string,
  paymentId: string,
): Promise<Response> {
  if (!providerId(paymentId)) throw new BillingError("Invoice not found.", 400);
  const account = await paymentAccount(env, businessId),
    owned = await env.DB.prepare(
      "SELECT payment_id FROM commercial_payment_events WHERE business_id=? AND provider_mode=? AND payment_id=? LIMIT 1",
    )
      .bind(businessId, env.DODO_MODE!, paymentId)
      .first();
  if (!owned) throw new BillingError("Invoice not found.", 400);
  const payment = await dodoRequest(env, "/payments/" + paymentId);
  if (payment.customer?.customer_id !== account.customer_id)
    throw new BillingError("Invoice not found.", 400);
  const response = await fetch(
    `https://${env.DODO_MODE}.dodopayments.com/invoices/payments/${paymentId}`,
    {
      headers: { Authorization: `Bearer ${env.DODO_API_KEY}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/pdf") ||
    !response.body
  ) {
    void response.body?.cancel();
    throw new BillingError(
      "The invoice is not available yet. Please retry later.",
    );
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new BillingError("Invoice download timed out. Please retry.")),
      15000,
    );
  });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > 4 * 1024 * 1024)
        throw new BillingError("This invoice needs support to download.");
      chunks.push(value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
    throw new BillingError("The invoice could not be verified.");
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="openfon-invoice.pdf"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
