import {
  beginPaymentMethodUpdate,
  reconcilePaymentMethodUpdate,
  listCommercialInvoices,
  getCommercialInvoice,
} from "./commercial-payment";
import { requestCommercialCancellation } from "./commercial-cancellation";
import {
  getPhoneView,
  quotePhoneNumbers,
  orderPhoneNumber,
  assignPhoneNumber,
  reconcilePhoneOrder,
} from "./commercial-phone";
import type { Hono } from "hono";
import type { Env } from "./types";
import { readLivekitBody } from "./livekit-body";
import {
  PLANS,
  type BillingView,
  type PlanId,
  type BillingCadence,
} from "./commercial-types";
import {
  retailOverage,
  markOperatorQaCall,
  coveredRetailMilliseconds,
} from "./commercial-usage";
import {
  BillingError,
  chargingReady,
  billingMapping,
  providerId,
  createCheckout,
  createPortal,
  processDodoWebhook,
  reconcileBusinessCheckouts,
  type CommercialEnv,
} from "./commercial-dodo";
type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
export async function getBillingView(
  env: CommercialEnv,
  businessId: string,
  now = Date.now(),
): Promise<BillingView> {
  const account = await env.DB.prepare(
    "SELECT plan_id,cadence,status,anchor_at,activated_at,period_end,provider_mode,customer_id,retail_stopped_at,paid_through FROM commercial_accounts WHERE business_id=?",
  )
    .bind(businessId)
    .first<{
      plan_id: PlanId | null;
      cadence: BillingCadence | null;
      status: BillingView["status"];
      anchor_at: string | null;
      activated_at: string | null;
      period_end: string | null;
      provider_mode: string;
      customer_id: string;
      retail_stopped_at: string | null;
      paid_through: string | null;
    }>();
  const configured = chargingReady(env),
    sameMode = account?.provider_mode === env.DODO_MODE;
  const cancellation = await env.DB.prepare(
    "SELECT term_end AS termEnd,state AS status FROM commercial_cancellations WHERE business_id=?",
  )
    .bind(businessId)
    .first<{ termEnd: string; status: string }>();
  const deleting = !!(await env.DB.prepare(
    "SELECT business_id FROM commercial_deletion_jobs WHERE business_id=?",
  )
    .bind(businessId)
    .first());
  const availableCadences: BillingCadence[] =
    configured && !deleting
      ? (["monthly", "annual"] as BillingCadence[]).filter((cadence) =>
          PLANS.every((p) => {
            try {
              billingMapping(env, p.id, cadence);
              return true;
            } catch {
              return false;
            }
          }),
        )
      : [];
  const portalAvailable =
    !deleting &&
    !!sameMode &&
    account?.cadence === "monthly" &&
    !!env.DODO_API_KEY &&
    providerId(account?.customer_id);
  let cycle: BillingView["cycle"] = null,
    usage = {
      durationMs: 0,
      includedMs: 0,
      overageMs: 0,
      overageMinor: 0,
      provisional: true,
    };
  if (
    sameMode &&
    account?.anchor_at &&
    account.activated_at &&
    account.plan_id &&
    account.cadence &&
    Date.parse(account.anchor_at) <= now
  ) {
    const period = await env.DB.prepare(
      "SELECT period_start,period_end FROM commercial_billing_periods WHERE business_id=? AND period_start<=? AND period_end>? ORDER BY period_start DESC LIMIT 1",
    )
      .bind(
        businessId,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      )
      .first<{ period_start: string; period_end: string }>();
    if (!period)
      return {
        plan: account.plan_id,
        cadence: account.cadence,
        status: account.status,
        currency: "EUR",
        cycle: null,
        usage,
        plans: PLANS,
        checkoutAvailable: false,
        availableCadences,
        cancellation,
        portalAvailable,
        unavailableReason:
          "Usage is being reconciled. No estimated amount is final.",
      };
    cycle = { start: period.period_start, end: period.period_end };
    const start = Math.max(
        Date.parse(cycle.start),
        Date.parse(account.activated_at),
      ),
      end = Math.min(
        Date.parse(cycle.end),
        now,
        account.retail_stopped_at ? Date.parse(account.retail_stopped_at) : now,
        account.paid_through ? Date.parse(account.paid_through) : now,
        cancellation ? Date.parse(cancellation.termEnd) : now,
      );
    const total = await coveredRetailMilliseconds(env, businessId, start, end);
    const adjustment = await env.DB.prepare(
      "SELECT COALESCE(SUM(delta_ms),0) AS ms FROM commercial_usage_adjustments WHERE business_id=? AND cycle_start=? AND cycle_end=?",
    )
      .bind(businessId, cycle.start, cycle.end)
      .first<{ ms: number }>();
    usage = {
      ...retailOverage(
        Math.max(0, total + (adjustment?.ms ?? 0)),
        account.plan_id,
        account.cadence,
      ),
      provisional: true,
    };
  }
  return {
    plan: sameMode ? (account?.plan_id ?? null) : null,
    cadence: sameMode ? (account?.cadence ?? null) : null,
    status: sameMode
      ? (account?.status ?? "none")
      : configured
        ? "none"
        : "unconfigured",
    currency: "EUR",
    cycle,
    usage,
    plans: PLANS,
    checkoutAvailable: availableCadences.length > 0 && !account?.plan_id,
    availableCadences,
    cancellation,
    portalAvailable,
    unavailableReason: configured
      ? null
      : "No new checkout is available at the moment. Existing billing history is unchanged.",
  };
}
export async function commercialWorkspace(
  env: Env,
  userId: string | undefined,
) {
  if (!userId) throw new BillingError("Sign in to continue.", 401);
  const business = await env.DB.prepare(
    "SELECT b.id,b.name,u.email FROM businesses b JOIN users u ON u.id=b.user_id WHERE b.user_id=? ORDER BY b.created_at,b.id LIMIT 1",
  )
    .bind(userId)
    .first<{ id: string; name: string; email: string }>();
  if (!business) throw new BillingError("Set up your business first.", 409);
  return business;
}
export async function commercialBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new BillingError("Send a valid request.", 400);
  try {
    const value = JSON.parse(await readLivekitBody(request));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    return value;
  } catch {
    throw new BillingError("Send a valid request.", 400);
  }
}
export function registerCommercialRoutes(app: App): void {
  app.get("/api/me/billing", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await getBillingView(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Billing is temporarily unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/checkout", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId")),
        body = await commercialBody(c.req.raw);
      if (Object.keys(body).some((k) => !["plan", "cadence"].includes(k)))
        throw new BillingError("Choose a valid plan.", 400);
      return c.json({
        url: await createCheckout(
          c.env,
          b,
          body.plan as PlanId,
          body.cadence as BillingCadence,
        ),
      });
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Checkout is temporarily unavailable. No new checkout will be started automatically.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/portal", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json({ url: await createPortal(c.env, b.id) });
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Billing settings are temporarily unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/payment-method", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await beginPaymentMethodUpdate(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Payment settings are temporarily unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/payment-method/reconcile", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await reconcilePaymentMethodUpdate(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Payment settings could not be reconciled. Please retry.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.get("/api/me/billing/invoices", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await listCommercialInvoices(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Invoices are temporarily unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.get("/api/me/billing/invoices/:id", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return await getCommercialInvoice(c.env, b.id, c.req.param("id"));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("The invoice is temporarily unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/cancel", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await requestCommercialCancellation(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Cancellation could not be confirmed. Please retry.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/billing/reconcile", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await reconcileBusinessCheckouts(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Billing could not be reconciled. Please retry later.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.get("/api/me/phone", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await getPhoneView(c.env, b.id));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Phone settings are unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/phone/quotes", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(
        await quotePhoneNumbers(c.env, b.id, await commercialBody(c.req.raw)),
      );
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Phone quotes are unavailable.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/phone/orders", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId")),
        body = await commercialBody(c.req.raw);
      if (
        Object.keys(body).some((k) => !["quoteId", "assistantId"].includes(k))
      )
        throw new BillingError("Choose a valid number and assistant.", 400);
      return c.json(
        await orderPhoneNumber(c.env, b.id, body.quoteId, body.assistantId),
      );
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Your number order needs reconciliation. Please refresh its status.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/me/phone/orders/:id/reconcile", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId"));
      return c.json(await reconcilePhoneOrder(c.env, b.id, c.req.param("id")));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError(
              "Phone setup could not be reconciled. Please retry later.",
            );
      return c.json({ error: e.message }, e.status);
    }
  });
  app.put("/api/me/phone/numbers/:id", async (c) => {
    try {
      const b = await commercialWorkspace(c.env, c.get("userId")),
        body = await commercialBody(c.req.raw);
      if (
        Object.keys(body).some((k) => !["assistantId", "enabled"].includes(k))
      )
        throw new BillingError("Choose valid phone settings.", 400);
      return c.json(
        await assignPhoneNumber(
          c.env,
          b.id,
          c.req.param("id"),
          body.assistantId,
          body.enabled,
        ),
      );
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Phone settings could not be saved.");
      return c.json({ error: e.message }, e.status);
    }
  });
  // Public callback authenticates the exact raw bytes independently of cookies.
  app.post("/api/billing/webhook", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const raw = await readLivekitBody(c.req.raw);
      return c.json(await processDodoWebhook(c.env, raw, c.req.raw.headers));
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Billing notification could not be processed.");
      return c.json({ error: e.message }, e.status);
    }
  });
  app.post("/api/internal/commercial/qa", async (c) => {
    const env = c.env as CommercialEnv;
    try {
      if (
        !env.COMMERCIAL_OPERATOR_TOKEN ||
        c.req.header("Authorization") !==
          `Bearer ${env.COMMERCIAL_OPERATOR_TOKEN}`
      )
        throw new BillingError("Not authorized.", 401);
      const body = await commercialBody(c.req.raw);
      if (typeof body.callId !== "string")
        throw new BillingError("Invalid call.", 400);
      return c.json(
        await markOperatorQaCall(env, body.callId, "operator-test"),
      );
    } catch (error) {
      const e =
        error instanceof BillingError
          ? error
          : new BillingError("Could not mark the operator test.");
      return c.json({ error: e.message }, e.status);
    }
  });
}

/** Explicit customer export projection: no credentials, raw payloads or routing. */
export async function exportCommercialData(
  env: Pick<Env, "DB">,
  businessId: string,
) {
  const [subscription, usage, adjustments, payments, phones] =
    await Promise.all([
      env.DB.prepare(
        "SELECT plan_id,cadence,status,anchor_at,activated_at,period_end FROM commercial_accounts WHERE business_id=?",
      )
        .bind(businessId)
        .all(),
      env.DB.prepare(
        "SELECT call_id,connected_at_ms,ended_at_ms,duration_ms,recorded_at FROM commercial_call_usage WHERE business_id=?",
      )
        .bind(businessId)
        .all(),
      env.DB.prepare(
        "SELECT call_id,delta_ms,reason,created_at FROM commercial_usage_adjustments WHERE business_id=?",
      )
        .bind(businessId)
        .all(),
      env.DB.prepare(
        "SELECT event_type,amount_minor,currency,occurred_at FROM commercial_payment_events WHERE business_id=?",
      )
        .bind(businessId)
        .all(),
      env.DB.prepare(
        "SELECT id,assistant_id,phone_number,state,created_at FROM commercial_phone_orders WHERE business_id=?",
      )
        .bind(businessId)
        .all(),
    ]);
  return {
    subscription: subscription.results,
    usage: usage.results,
    adjustments: adjustments.results,
    payments: payments.results,
    phones: phones.results,
  };
}
