import { releaseBusinessPhones } from "./commercial-phone";
import type { Env } from "./types";
import {
  PLANS,
  type CommercialBindings,
  type PlanId,
  type BillingCadence,
} from "./commercial-types";
import { readLivekitBody } from "./livekit-body";
import { usageHash } from "./commercial-usage";
export type CommercialEnv = Env & CommercialBindings;
export class BillingError extends Error {
  constructor(
    message: string,
    public status: 400 | 401 | 403 | 409 | 503 = 503,
  ) {
    super(message);
  }
}
export const providerId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
export function chargingReady(env: CommercialEnv): boolean {
  return (
    env.COMMERCIAL_BILLING_VERIFIED === "true" &&
    env.COMMERCIAL_CHARGING_ENABLED === "true" &&
    !!env.DODO_API_KEY &&
    !!env.DODO_WEBHOOK_SECRET &&
    ["test", "live"].includes(env.DODO_MODE ?? "") &&
    ["inclusive", "exclusive"].includes(env.COMMERCIAL_TAX_POLICY ?? "") &&
    !!env.DODO_PRODUCTS_JSON &&
    !!env.DODO_METERS_JSON
  );
}
export function commercialOrigin(env: CommercialEnv): string {
  const u = new URL(env.COMMERCIAL_PUBLIC_ORIGIN ?? "https://openfon.ai");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new BillingError("Billing is not configured.");
  return u.origin;
}
export function productFor(
  env: CommercialEnv,
  planId: PlanId,
  cadence: BillingCadence,
): string {
  if (
    !PLANS.some((p) => p.id === planId) ||
    !["monthly", "annual"].includes(cadence)
  )
    throw new BillingError("Choose a valid plan.", 400);
  if (cadence === "annual" && env.COMMERCIAL_ANNUAL_POLICY !== "upfront")
    throw new BillingError("Annual billing is not available yet.");
  let products: Record<string, unknown>;
  try {
    products = JSON.parse(env.DODO_PRODUCTS_JSON ?? "{}");
  } catch {
    throw new BillingError("Billing is not configured.");
  }
  const id = products[planId + ":" + cadence];
  if (!providerId(id))
    throw new BillingError("This plan is not available yet.");
  return id;
}
export async function dodoRequest(
  env: CommercialEnv,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Record<string, any>> {
  if (
    !env.DODO_API_KEY ||
    !["test", "live"].includes(env.DODO_MODE ?? "") ||
    !path.startsWith("/")
  )
    throw new BillingError("Billing is not configured.");
  let response: Response;
  try {
    response = await fetch(`https://${env.DODO_MODE}.dodopayments.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.DODO_API_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BillingError(
      "Billing could not be reached. Please try again later.",
    );
  }
  if (!response.ok) {
    void response.body?.cancel();
    throw new BillingError(
      "Billing could not complete this request. Please try again later.",
    );
  }
  let text: string;
  try {
    text = await readLivekitBody({ body: response.body } as Request);
  } catch {
    throw new BillingError("Billing returned an unexpected response.");
  }
  try {
    const result = JSON.parse(text);
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw Error();
    return result;
  } catch {
    throw new BillingError("Billing returned an unexpected response.");
  }
}
export function hostedUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new BillingError("Billing link is unavailable.");
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !u.hostname.endsWith(".dodopayments.com")
  )
    throw new BillingError("Billing link is unavailable.");
  return u.href;
}
export function billingMapping(
  env: CommercialEnv,
  plan: PlanId,
  cadence: BillingCadence,
) {
  const base = productFor(env, plan, cadence);
  let products: Record<string, string>,
    meters: Record<string, { id: string; event: string }>;
  try {
    products = JSON.parse(env.DODO_PRODUCTS_JSON!);
    meters = JSON.parse(env.DODO_METERS_JSON!);
  } catch {
    throw new BillingError("Billing is not configured.");
  }
  const meter = meters[plan + ":" + cadence],
    usage = cadence === "annual" ? products[plan + ":annual:usage"] : base;
  if (
    !providerId(usage) ||
    !meter ||
    !providerId(meter.id) ||
    !/^[-a-zA-Z0-9_.]{1,100}$/.test(meter.event) ||
    (cadence === "annual" && usage === base)
  )
    throw new BillingError("Billing is not configured.");
  return { base, usage, meter };
}
export async function createCheckout(
  env: CommercialEnv,
  business: { id: string; name: string; email: string },
  plan: PlanId,
  cadence: BillingCadence,
): Promise<string> {
  if (!chargingReady(env))
    throw new BillingError(
      "Subscriptions are not available yet. Your account has not been charged.",
    );
  if (
    await env.DB.prepare(
      "SELECT business_id FROM commercial_deletion_jobs WHERE business_id=?",
    )
      .bind(business.id)
      .first()
  )
    throw new BillingError("Account deletion is in progress.", 409);
  const mapping = billingMapping(env, plan, cadence);
  const account = await env.DB.prepare(
    "SELECT subscription_id FROM commercial_accounts WHERE business_id=?",
  )
    .bind(business.id)
    .first<{ subscription_id: string | null }>();
  if (account?.subscription_id)
    throw new BillingError(
      "Manage your existing subscription from billing settings.",
      409,
    );
  const pending = await env.DB.prepare(
    "SELECT plan_id,cadence,checkout_url,state FROM commercial_checkout_intents WHERE business_id=? AND state IN ('pending','ready')",
  )
    .bind(business.id)
    .first<{
      plan_id: string;
      cadence: string;
      checkout_url: string | null;
      state: string;
    }>();
  if (pending) {
    if (
      pending.plan_id === plan &&
      pending.cadence === cadence &&
      pending.checkout_url
    )
      return hostedUrl(pending.checkout_url);
    throw new BillingError(
      "A checkout is already being prepared. Please return to it or contact support.",
      409,
    );
  }
  const selected = PLANS.find((x) => x.id === plan)!;
  const products = await Promise.all(
    [...new Set([mapping.base, mapping.usage])].map((id) =>
      dodoRequest(env, "/products/" + id),
    ),
  );
  for (const product of products) {
    const p = product.price,
      isUsage = product.product_id === mapping.usage,
      amount = isUsage
        ? cadence === "monthly"
          ? selected.monthlyMinor
          : 0
        : selected.annualEquivalentMinor * 12;
    if (
      product.is_archived ||
      product.tax_category !== "saas" ||
      !p ||
      p.type !== (isUsage ? "usage_based_price" : "recurring_price") ||
      (isUsage ? p.fixed_price : p.price) !== amount ||
      p.currency !== "EUR" ||
      p.payment_frequency_count !== 1 ||
      p.payment_frequency_interval !== (isUsage ? "Month" : "Year") ||
      p.tax_inclusive !== (env.COMMERCIAL_TAX_POLICY === "inclusive") ||
      p.discount ||
      p.discount_bps ||
      p.purchasing_power_parity ||
      p.trial_period_days
    )
      throw new BillingError(
        "This subscription is being configured. Please try again later.",
      );
    if (
      isUsage &&
      (!Array.isArray(p.meters) ||
        p.meters.length !== 1 ||
        p.meters[0].meter_id !== mapping.meter.id ||
        Number(p.meters[0].price_per_unit) !== 1 ||
        p.meters[0].free_threshold !== 0)
    )
      throw new BillingError("Usage billing is being configured.");
  }
  const meter = await dodoRequest(env, "/meters/" + mapping.meter.id);
  if (
    meter.event_name !== mapping.meter.event ||
    meter.aggregation?.type !== "max" ||
    meter.aggregation?.key !== "cents" ||
    meter.filter
  )
    throw new BillingError("Usage billing is being configured.");
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO commercial_checkout_intents(id,business_id,provider_mode,plan_id,cadence,product_id,usage_product_id,meter_id,event_name,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM businesses WHERE id=?)
      AND NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)
      AND NOT EXISTS(SELECT 1 FROM commercial_accounts WHERE business_id=? AND subscription_id IS NOT NULL)`,
    )
      .bind(
        id,
        business.id,
        env.DODO_MODE!,
        plan,
        cadence,
        mapping.base,
        mapping.usage,
        mapping.meter.id,
        mapping.meter.event,
        new Date().toISOString(),
        business.id,
        business.id,
        business.id,
      )
      .run();
  } catch {
    throw new BillingError("A checkout is already being prepared.", 409);
  }
  const reserved = await env.DB.prepare(
    "SELECT id FROM commercial_checkout_intents WHERE id=? AND business_id=?",
  )
    .bind(id, business.id)
    .first();
  if (!reserved)
    throw new BillingError(
      "Your subscription or account changed. Refresh billing settings.",
      409,
    );
  // Ambiguous POST remains pending. Reconciliation must resolve it before retry.
  const checkout = await dodoRequest(env, "/checkouts", "POST", {
    product_cart: [...new Set([mapping.base, mapping.usage])].map(
      (product_id) => ({ product_id, quantity: 1 }),
    ),
    customer: { email: business.email, name: business.name },
    metadata: { openfon_checkout_id: id },
    return_url: commercialOrigin(env) + "/settings/billing",
    cancel_url: commercialOrigin(env) + "/settings/billing",
    billing_currency: "EUR",
    feature_flags: {
      allow_currency_selection: false,
      allow_discount_code: false,
    },
    confirm: false,
  });
  const url = hostedUrl(checkout.checkout_url);
  if (!providerId(checkout.session_id))
    throw new BillingError("Checkout confirmation is unavailable.");
  await env.DB.prepare(
    "UPDATE commercial_checkout_intents SET state='ready',session_id=?,checkout_url=? WHERE id=? AND business_id=?",
  )
    .bind(checkout.session_id, url, id, business.id)
    .run();
  return url;
}
export async function createPortal(
  env: CommercialEnv,
  businessId: string,
): Promise<string> {
  if (
    await env.DB.prepare(
      "SELECT business_id FROM commercial_deletion_jobs WHERE business_id=?",
    )
      .bind(businessId)
      .first()
  )
    throw new BillingError("Account deletion is in progress.", 409);
  const account = await env.DB.prepare(
    "SELECT customer_id,provider_mode,cadence FROM commercial_accounts WHERE business_id=?",
  )
    .bind(businessId)
    .first<{ customer_id: string; provider_mode: string; cadence: string }>();
  if (
    !account ||
    account.cadence !== "monthly" ||
    account.provider_mode !== env.DODO_MODE ||
    !providerId(account.customer_id)
  )
    throw new BillingError("There is no subscription to manage.", 409);
  return hostedUrl(
    (
      await dodoRequest(
        env,
        `/customers/${encodeURIComponent(account.customer_id)}/customer-portal/session?send_email=false&return_url=${encodeURIComponent(commercialOrigin(env) + "/settings/billing")}`,
        "POST",
        {},
      )
    ).link,
  );
}
const decode64 = (v: string) =>
  Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
export async function verifyDodoWebhook(
  raw: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Promise<{ id: string; payload: Record<string, any> }> {
  const id = headers.get("webhook-id"),
    timestamp = headers.get("webhook-timestamp"),
    signature = headers.get("webhook-signature");
  if (
    !id ||
    id.length > 200 ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !signature ||
    signature.length > 4096
  )
    throw new BillingError("Invalid billing notification.", 401);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      decode64(secret.replace(/^whsec_/, "")),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new BillingError("Billing notifications are not configured.");
  }
  const bytes = new TextEncoder().encode(`${id}.${timestamp}.${raw}`);
  let valid = false;
  for (const part of signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig) {
      try {
        if (await crypto.subtle.verify("HMAC", key, decode64(sig), bytes))
          valid = true;
      } catch {
        /* invalid signature cannot authorize */
      }
    }
  }
  if (!valid) throw new BillingError("Invalid billing notification.", 401);
  try {
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.type !== "string" ||
      !Number.isFinite(Date.parse(payload.timestamp)) ||
      !payload.data
    )
      throw Error();
    return { id, payload };
  } catch {
    throw new BillingError("Invalid billing notification.", 400);
  }
}

export async function processDodoWebhook(
  env: CommercialEnv,
  raw: string,
  headers: Headers,
) {
  if (!env.DODO_WEBHOOK_SECRET || !env.DODO_MODE)
    throw new BillingError("Billing notifications are unavailable.");
  const { id, payload } = await verifyDodoWebhook(
    raw,
    headers,
    env.DODO_WEBHOOK_SECRET,
  );
  const hash = await usageHash(raw);
  const prior = await env.DB.prepare(
    "SELECT payload_hash,processed_at FROM commercial_webhook_events WHERE provider_mode=? AND event_id=?",
  )
    .bind(env.DODO_MODE, id)
    .first<{ payload_hash: string; processed_at: string | null }>();
  if (prior && prior.payload_hash !== hash)
    throw new BillingError("Conflicting billing notification.", 409);
  if (prior?.processed_at) return { duplicate: true };
  await env.DB.prepare(
    "INSERT INTO commercial_webhook_events(provider_mode,event_id,payload_hash,event_type,received_at) VALUES(?,?,?,?,?) ON CONFLICT(provider_mode,event_id) DO NOTHING",
  )
    .bind(env.DODO_MODE, id, hash, payload.type, new Date().toISOString())
    .run();
  const accepted = await env.DB.prepare(
    "SELECT payload_hash FROM commercial_webhook_events WHERE provider_mode=? AND event_id=?",
  )
    .bind(env.DODO_MODE, id)
    .first<{ payload_hash: string }>();
  if (accepted?.payload_hash !== hash)
    throw new BillingError("Conflicting billing notification.", 409);
  const ids = new Set<string>();
  if (providerId(payload.data.subscription_id))
    ids.add(payload.data.subscription_id);
  if (
    payload.data.is_multi_subscription === true &&
    Array.isArray(payload.data.subscription_ids)
  )
    for (const sid of payload.data.subscription_ids)
      if (providerId(sid)) ids.add(sid);
  if (!ids.size && providerId(payload.data.payment_id)) {
    const payment = await dodoRequest(
      env,
      "/payments/" + encodeURIComponent(payload.data.payment_id),
    );
    if (providerId(payment.subscription_id)) ids.add(payment.subscription_id);
    if (
      payment.is_multi_subscription === true &&
      Array.isArray(payment.subscription_ids)
    )
      for (const sid of payment.subscription_ids)
        if (providerId(sid)) ids.add(sid);
  }
  if (ids.size > 20)
    throw new BillingError("Subscription reconciliation failed.");
  for (const sid of ids)
    await reconcileSubscription(env, sid, payload.timestamp);
  const businesses = new Set<string>();
  for (const sid of ids) {
    const component = await env.DB.prepare(
      "SELECT business_id FROM commercial_subscription_components WHERE provider_mode=? AND subscription_id=?",
    )
      .bind(env.DODO_MODE, sid)
      .first<{ business_id: string }>();
    if (component) businesses.add(component.business_id);
  }
  if (businesses.size > 1)
    throw new BillingError("Payment ownership mismatch.");
  if (businesses.size === 1) {
    await env.DB.prepare(
      `INSERT INTO commercial_payment_events(provider_mode,event_id,business_id,event_type,payment_id,refund_id,amount_minor,currency,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_mode,event_id) DO NOTHING`,
    )
      .bind(
        env.DODO_MODE,
        id,
        [...businesses][0],
        payload.type,
        providerId(payload.data.payment_id) ? payload.data.payment_id : null,
        providerId(payload.data.refund_id) ? payload.data.refund_id : null,
        Number.isSafeInteger(payload.data.total_amount)
          ? payload.data.total_amount
          : null,
        typeof payload.data.currency === "string"
          ? payload.data.currency
          : null,
        payload.timestamp,
      )
      .run();
  }

  await env.DB.prepare(
    "UPDATE commercial_webhook_events SET processed_at=? WHERE provider_mode=? AND event_id=? AND payload_hash=?",
  )
    .bind(new Date().toISOString(), env.DODO_MODE, id, hash)
    .run();
  return { duplicate: false };
}

interface Intent {
  id: string;
  business_id: string;
  product_id: string;
  usage_product_id: string;
  meter_id: string;
  plan_id: PlanId;
  cadence: BillingCadence;
  created_at: string;
}
/** Only API-verified subscriptions carrying our server-created intent can enroll. */
export async function reconcileSubscription(
  env: CommercialEnv,
  sid: string,
  eventAt: string,
) {
  const sub = await dodoRequest(
    env,
    "/subscriptions/" + encodeURIComponent(sid),
  );
  const intentId = sub.metadata?.openfon_checkout_id;
  const intent = providerId(intentId)
    ? await env.DB.prepare(
        "SELECT * FROM commercial_checkout_intents WHERE id=? AND provider_mode=?",
      )
        .bind(intentId, env.DODO_MODE!)
        .first<Intent>()
    : null;
  if (!intent) return;
  const usage = sub.product_id === intent.usage_product_id,
    role = usage ? "usage" : "base",
    plan = PLANS.find((p) => p.id === intent.plan_id)!;
  const amount = usage
    ? intent.cadence === "monthly"
      ? plan.monthlyMinor
      : 0
    : plan.annualEquivalentMinor * 12;
  const states: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    on_hold: "unpaid",
    failed: "unpaid",
    pending: "pending",
    cancelled: "canceled",
    expired: "canceled",
    paused: "unpaid",
  };
  const status = states[sub.status],
    startMs = Date.parse(sub.previous_billing_date),
    endMs = Date.parse(sub.next_billing_date);
  if (
    !status ||
    sub.subscription_id !== sid ||
    (!usage && sub.product_id !== intent.product_id) ||
    sub.currency !== "EUR" ||
    sub.quantity !== 1 ||
    sub.on_demand ||
    sub.trial_period_days ||
    sub.recurring_pre_tax_amount !== amount ||
    sub.tax_inclusive !== (env.COMMERCIAL_TAX_POLICY === "inclusive") ||
    sub.payment_frequency_count !== 1 ||
    sub.payment_frequency_interval !== (usage ? "Month" : "Year") ||
    !providerId(sub.customer?.customer_id) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  )
    throw new BillingError("Subscription reconciliation failed.");
  if (
    usage &&
    (!Array.isArray(sub.meters) ||
      sub.meters.length !== 1 ||
      sub.meters[0].meter_id !== intent.meter_id ||
      Number(sub.meters[0].price_per_unit) !== 1 ||
      sub.meters[0].free_threshold !== 0)
  )
    throw new BillingError("Usage reconciliation failed.");
  const start = new Date(startMs).toISOString(),
    end = new Date(endMs).toISOString();
  const existing = await env.DB.prepare(
    "SELECT customer_id FROM commercial_subscription_components WHERE business_id=? LIMIT 1",
  )
    .bind(intent.business_id)
    .first<{ customer_id: string }>();
  if (existing && existing.customer_id !== sub.customer.customer_id)
    throw new BillingError("Subscription ownership mismatch.");
  const prior = await env.DB.prepare(
    "SELECT subscription_id FROM commercial_subscription_components WHERE business_id=? AND role=?",
  )
    .bind(intent.business_id, role)
    .first<{ subscription_id: string }>();
  if (prior && prior.subscription_id !== sid)
    throw new BillingError("A subscription is already linked.");
  await env.DB.prepare(
    `INSERT INTO commercial_subscription_components(business_id,role,provider_mode,subscription_id,customer_id,product_id,status,period_start,period_end,updated_event_at)
 SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM commercial_subscription_components WHERE business_id=? AND customer_id<>?)
 ON CONFLICT(business_id,role) DO UPDATE SET status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,updated_event_at=excluded.updated_event_at
 WHERE subscription_id=excluded.subscription_id AND updated_event_at<=excluded.updated_event_at`,
  )
    .bind(
      intent.business_id,
      role,
      env.DODO_MODE!,
      sid,
      sub.customer.customer_id,
      sub.product_id,
      status,
      start,
      end,
      eventAt,
      intent.business_id,
      sub.customer.customer_id,
    )
    .run();
  const now = new Date().toISOString();
  // Derive the account projection from current component rows in the write
  // statement itself. Cached reads can regress an active multi-cart account
  // when same-timestamp webhook deliveries interleave.
  await env.DB.prepare(
    `WITH current_components AS (
    SELECT COALESCE(u.customer_id,b.customer_id) customer_id,u.period_start,u.period_end,CASE WHEN b.period_end IS NULL THEN u.period_end ELSE MIN(u.period_end,b.period_end) END paid_through,
      CASE WHEN u.status='active' AND u.period_start<=? AND u.period_end>? AND (?='monthly' OR (b.status='active' AND b.period_start<=? AND b.period_end>?)) THEN 'active'
       WHEN u.status='canceled' OR b.status='canceled' THEN 'canceled'
       WHEN u.status='unpaid' OR b.status='unpaid' THEN 'unpaid'
       WHEN u.status='past_due' OR b.status='past_due' THEN 'past_due' ELSE 'pending' END status
    FROM businesses owner LEFT JOIN commercial_subscription_components u ON u.business_id=owner.id AND u.role='usage'
    LEFT JOIN commercial_subscription_components b ON b.business_id=owner.id AND b.role='base' WHERE owner.id=?
  ) INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,subscription_id,plan_id,cadence,status,anchor_at,activated_at,period_end,paid_through,updated_event_at)
    SELECT ?,?,customer_id,?,?,?,status,CASE WHEN status='active' THEN period_start END,CASE WHEN status='active' THEN ? END,period_end,paid_through,?
    FROM current_components WHERE customer_id IS NOT NULL
    ON CONFLICT(business_id) DO UPDATE SET status=excluded.status,period_end=excluded.period_end,paid_through=excluded.paid_through,
      updated_event_at=MAX(COALESCE(commercial_accounts.updated_event_at,''),excluded.updated_event_at),
      activated_at=COALESCE(commercial_accounts.activated_at,excluded.activated_at),anchor_at=COALESCE(commercial_accounts.anchor_at,excluded.anchor_at),
      retail_stopped_at=CASE WHEN commercial_accounts.activated_at IS NOT NULL AND excluded.status IN ('canceled','unpaid','past_due') THEN COALESCE(commercial_accounts.retail_stopped_at,?) ELSE commercial_accounts.retail_stopped_at END
    WHERE commercial_accounts.customer_id=excluded.customer_id`,
  )
    .bind(
      now,
      now,
      intent.cadence,
      now,
      now,
      intent.business_id,
      intent.business_id,
      env.DODO_MODE!,
      intent.id,
      intent.plan_id,
      intent.cadence,
      now,
      eventAt,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO commercial_billing_periods(business_id,subscription_id,period_start,period_end,plan_id,cadence,recorded_at)
    SELECT a.business_id,u.subscription_id,u.period_start,u.period_end,a.plan_id,a.cadence,? FROM commercial_accounts a
    JOIN commercial_subscription_components u ON u.business_id=a.business_id AND u.role='usage'
    WHERE a.business_id=? AND a.status='active' AND a.retail_stopped_at IS NULL
    ON CONFLICT(business_id,period_start) DO NOTHING`,
  )
    .bind(now, intent.business_id)
    .run();
  await env.DB.prepare(
    "UPDATE commercial_checkout_intents SET state='completed' WHERE id=? AND EXISTS(SELECT 1 FROM commercial_accounts WHERE business_id=? AND status='active')",
  )
    .bind(intent.id, intent.business_id)
    .run();
}

/** Retry-safe external cleanup before account rows may be deleted. */
export async function prepareCommercialDeletion(
  env: CommercialEnv,
  businessId: string,
  auth?: { userId: string; passwordHash: string; sessionToken: string },
): Promise<void> {
  if (!auth)
    throw new BillingError("Sign in again before deleting your account.", 409);
  // This reservation and call admission's NOT EXISTS(marker) form a single
  // database boundary: either the call wins or deletion wins, never both.
  const markers = await env.DB.prepare(
    `INSERT INTO commercial_deletion_jobs(business_id,requested_at)
    SELECT b.id,? FROM businesses b JOIN users u ON u.id=b.user_id WHERE u.id=? AND u.password_hash=?
    AND EXISTS(SELECT 1 FROM businesses requested WHERE requested.id=? AND requested.user_id=u.id)
    AND EXISTS(SELECT 1 FROM sessions WHERE token=? AND user_id=u.id AND expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM calls JOIN businesses owned ON owned.id=calls.business_id
      WHERE owned.user_id=u.id AND ((calls.status='active' AND (calls.channel!='web' OR calls.connected_at IS NOT NULL OR calls.browser_claim_required!=1
        OR EXISTS(SELECT 1 FROM call_turns WHERE call_turns.call_id=calls.id))) OR (calls.reserved_at IS NOT NULL AND calls.carrier_released_at IS NULL)))
    ON CONFLICT(business_id) DO UPDATE SET requested_at=commercial_deletion_jobs.requested_at RETURNING business_id`,
  )
    .bind(
      new Date().toISOString(),
      auth.userId,
      auth.passwordHash,
      businessId,
      auth.sessionToken,
      new Date().toISOString(),
    )
    .all<{ business_id: string }>();
  if (!markers.results.length)
    throw new BillingError(
      "Finish active calls and sign in again if your account changed before deleting.",
      409,
    );
  for (const marker of markers.results)
    await finishBusinessDeletion(env, marker.business_id);
}
async function finishBusinessDeletion(env: CommercialEnv, businessId: string) {
  if (
    await env.DB.prepare(
      "SELECT business_id FROM commercial_payment_writers WHERE business_id=?",
    )
      .bind(businessId)
      .first()
  )
    throw new BillingError(
      "A payment update must finish reconciliation before deletion. Please contact support.",
      409,
    );
  await reconcileBusinessCheckouts(env, businessId);
  await releaseBusinessPhones(env, businessId);
  const { results: parts } = await env.DB.prepare(
    "SELECT subscription_id,provider_mode FROM commercial_subscription_components WHERE business_id=?",
  )
    .bind(businessId)
    .all<{ subscription_id: string; provider_mode: string }>();
  for (const part of parts) {
    if (part.provider_mode !== env.DODO_MODE)
      throw new BillingError(
        "Subscription cancellation needs support before deletion.",
        409,
      );
    const sub = await dodoRequest(
      env,
      "/subscriptions/" + part.subscription_id,
    );
    if (!["cancelled", "expired"].includes(sub.status))
      await dodoRequest(
        env,
        "/subscriptions/" + part.subscription_id,
        "PATCH",
        { status: "cancelled" },
      );
    const readback = await dodoRequest(
      env,
      "/subscriptions/" + part.subscription_id,
    );
    if (!["cancelled", "expired"].includes(readback.status))
      throw new BillingError(
        "Subscription cancellation is still pending. Please retry deletion.",
        409,
      );
  }
  const pending = await env.DB.prepare(
    "SELECT id FROM commercial_checkout_intents WHERE business_id=? AND state IN ('pending','ready') LIMIT 1",
  )
    .bind(businessId)
    .first();
  if (pending)
    throw new BillingError(
      "A pending checkout must be reconciled before account deletion.",
      409,
    );
  await env.DB.prepare(
    "UPDATE commercial_deletion_jobs SET completed_at=? WHERE business_id=?",
  )
    .bind(new Date().toISOString(), businessId)
    .run();
}

/** Resolve abandoned checkouts without starting a second payment attempt. */
export async function reconcileBusinessCheckouts(
  env: CommercialEnv,
  businessId: string,
) {
  const { results: intents } = await env.DB.prepare(
    "SELECT id,provider_mode,session_id,created_at FROM commercial_checkout_intents WHERE business_id=? AND state IN ('pending','ready')",
  )
    .bind(businessId)
    .all<{
      id: string;
      provider_mode: string;
      session_id: string | null;
      created_at: string;
    }>();
  for (const intent of intents) {
    if (intent.provider_mode !== env.DODO_MODE)
      throw new BillingError("Billing reconciliation needs support.", 409);
    if (intent.session_id) {
      const session = await dodoRequest(env, "/checkouts/" + intent.session_id);
      if (providerId(session.payment_id)) {
        const payment = await dodoRequest(
          env,
          "/payments/" + session.payment_id,
        );
        const ids =
          payment.is_multi_subscription === true
            ? payment.subscription_ids
            : [payment.subscription_id];
        if (Array.isArray(ids))
          for (const id of ids)
            if (providerId(id))
              await reconcileSubscription(env, id, new Date().toISOString());
      }
    }
    // An unconfirmed hosted link is valid for 24h. After an extra hour, enumerate
    // subscriptions in its fixed creation window before releasing the local lock.
    // If pagination cannot prove completeness, retain the retryable intent.
    if (Date.now() - Date.parse(intent.created_at) < 25 * 3600000) continue;
    let complete = false,
      found = false;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({
        page_size: "100",
        page_number: String(page),
        created_at_gte: intent.created_at,
        created_at_lte: new Date(
          Date.parse(intent.created_at) + 25 * 3600000,
        ).toISOString(),
      });
      const response = await dodoRequest(env, "/subscriptions?" + params);
      if (!Array.isArray(response.items))
        throw new BillingError("Billing reconciliation is incomplete.", 409);
      for (const sub of response.items) {
        if (
          sub.metadata?.openfon_checkout_id === intent.id &&
          providerId(sub.subscription_id)
        ) {
          found = true;
          await reconcileSubscription(
            env,
            sub.subscription_id,
            new Date().toISOString(),
          );
        }
      }
      if (response.items.length < 100) {
        complete = true;
        break;
      }
    }
    if (!complete)
      throw new BillingError(
        "Billing reconciliation needs support before retrying.",
        409,
      );
    await env.DB.prepare(
      "UPDATE commercial_checkout_intents SET state=? WHERE id=? AND business_id=? AND state IN ('pending','ready')",
    )
      .bind(found ? "completed" : "expired", intent.id, businessId)
      .run();
  }
  return { reconciled: true };
}
