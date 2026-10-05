import type { Hono } from "hono";
import type { Env } from "./types";
import { readLivekitBody } from "./livekit-body";
import {
  PLANS,
  type BillingView,
  type PlanId,
  type BillingCadence,
} from "./commercial-types";
import { retailOverage, markOperatorQaCall } from "./commercial-usage";
import {
  BillingError,
  chargingReady,
  createCheckout,
  createPortal,
  processDodoWebhook,
  type CommercialEnv,
} from "./commercial-dodo";
type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
export async function getBillingView(
  env: CommercialEnv,
  businessId: string,
  now = Date.now(),
): Promise<BillingView> {
  const account = await env.DB.prepare(
    "SELECT plan_id,cadence,status,anchor_at,activated_at,period_end,provider_mode FROM commercial_accounts WHERE business_id=?",
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
    }>();
  const configured = chargingReady(env),
    sameMode = account?.provider_mode === env.DODO_MODE;
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
        portalAvailable: true,
        unavailableReason:
          "Usage is being reconciled. No estimated amount is final.",
      };
    cycle = { start: period.period_start, end: period.period_end };
    const start = Math.max(
        Date.parse(cycle.start),
        Date.parse(account.activated_at),
      ),
      end = Math.min(Date.parse(cycle.end), now);
    const total = await env.DB.prepare(
      `SELECT COALESCE(SUM(MAX(0,MIN(u.ended_at_ms,?)-MAX(u.connected_at_ms,?))),0) AS ms
   FROM commercial_call_usage u WHERE u.business_id=? AND u.ended_at_ms>? AND u.connected_at_ms<?
   AND NOT EXISTS(SELECT 1 FROM commercial_qa_calls q WHERE q.call_id=u.call_id)`,
    )
      .bind(end, start, businessId, start, end)
      .first<{ ms: number }>();
    const adjustment = await env.DB.prepare(
      "SELECT COALESCE(SUM(delta_ms),0) AS ms FROM commercial_usage_adjustments WHERE business_id=? AND created_at>=? AND created_at<?",
    )
      .bind(businessId, cycle.start, cycle.end)
      .first<{ ms: number }>();
    usage = {
      ...retailOverage(
        Math.max(0, (total?.ms ?? 0) + (adjustment?.ms ?? 0)),
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
    checkoutAvailable: configured && !account?.plan_id,
    portalAvailable: !!sameMode && !!account,
    unavailableReason: configured
      ? null
      : "Subscriptions are not available yet. Your account has not been charged.",
  };
}
export async function commercialWorkspace(
  env: Env,
  userId: string | undefined,
) {
  if (!userId) throw new BillingError("Sign in to continue.", 401);
  const business = await env.DB.prepare(
    "SELECT b.id,b.name,u.email FROM businesses b JOIN users u ON u.id=b.user_id WHERE b.user_id=?",
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
