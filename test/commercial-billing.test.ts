import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  reconcileSubscription,
  verifyDodoWebhook,
  processDodoWebhook,
  prepareCommercialDeletion,
  type CommercialEnv,
} from "../src/commercial-dodo";
import { getBillingView } from "../src/commercial-api";
let db: SqliteD1, env: CommercialEnv;
const at = "2026-10-05T00:10:00.000Z";
const sub = (role = "usage", patch: Record<string, unknown> = {}) => ({
  subscription_id: role,
  product_id: role === "usage" ? "usageprod" : "baseprod",
  metadata: { openfon_checkout_id: "intent" },
  customer: { customer_id: "customer" },
  currency: "EUR",
  quantity: 1,
  on_demand: false,
  trial_period_days: 0,
  recurring_pre_tax_amount: role === "usage" ? 0 : 20400,
  tax_inclusive: false,
  payment_frequency_count: 1,
  payment_frequency_interval: role === "usage" ? "Month" : "Year",
  previous_billing_date: "2026-10-05T00:08:12.128610Z",
  next_billing_date:
    role === "usage"
      ? "2026-11-05T00:08:42.107820Z"
      : "2027-10-05T00:08:42.123643Z",
  meters:
    role === "usage"
      ? [{ meter_id: "meter", price_per_unit: "1", free_threshold: 0 }]
      : [],
  status: "active",
  ...patch,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
  db = new SqliteD1();
  applyMigrations(db);
  db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
  db.exec(
    "INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','x'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B'); INSERT INTO commercial_checkout_intents(id,business_id,provider_mode,plan_id,cadence,product_id,usage_product_id,meter_id,event_name,created_at) VALUES('intent','b','test','flex','annual','baseprod','usageprod','meter','cents','2026-10-05T00:00:00Z')",
  );
  env = {
    DB: db,
    DODO_MODE: "test",
    DODO_API_KEY: "synthetic",
    COMMERCIAL_TAX_POLICY: "exclusive",
  } as unknown as CommercialEnv;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => Response.json(sub(url.split("/").pop()))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});
const account = () =>
  db.database.prepare("SELECT * FROM commercial_accounts").get() as Record<
    string,
    unknown
  >;
it("requires both annual components and records the actual monthly period without backbilling", async () => {
  await reconcileSubscription(env, "base", at);
  expect(account().status).toBe("pending");
  expect(account().activated_at).toBeNull();
  await reconcileSubscription(env, "usage", at);
  expect(account().status).toBe("active");
  expect(account().activated_at).toBe(at);
  expect(
    db.database
      .prepare("SELECT period_start,period_end FROM commercial_billing_periods")
      .get(),
  ).toEqual({
    period_start: "2026-10-05T00:08:12.128Z",
    period_end: "2026-11-05T00:08:42.107Z",
  });
  await reconcileSubscription(env, "usage", "2026-10-05T00:11:00Z");
  expect(account().activated_at).toBe(at);
});
it.each([
  { quantity: 2 },
  { currency: "USD" },
  { product_id: "unrelated" },
  { customer: { customer_id: "other" } },
  { on_demand: true },
  { recurring_pre_tax_amount: 1 },
  { payment_frequency_interval: "Year" },
  { meters: [] },
])("refuses changed subscription contract %j", async (patch) => {
  await reconcileSubscription(env, "base", at);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(sub("usage", patch))),
  );
  await expect(reconcileSubscription(env, "usage", at)).rejects.toThrow();
  expect(account().activated_at).toBeNull();
});
it("does not resurrect canceled component from an older notification", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(sub("usage", { status: "cancelled" }))),
  );
  await reconcileSubscription(env, "usage", "2026-10-05T00:12:00Z");
  expect(account().status).toBe("canceled");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(sub("usage"))),
  );
  await reconcileSubscription(env, "usage", "2026-10-05T00:11:00Z");
  expect(account().status).toBe("canceled");
});
it("clips private test intervals to activation and actual period and excludes only operator QA", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const start = Date.parse(at) - 1000,
    end = Date.parse(at) + 1000;
  db.exec(
    "INSERT INTO calls(id,business_id,connected_at,status,environment) VALUES('test','b',CURRENT_TIMESTAMP,'completed','test'),('qa','b',CURRENT_TIMESTAMP,'completed','test')",
  );
  for (const id of ["test", "qa"])
    db.database
      .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
      .run(id, "b", start, end, end - start, at);
  db.exec(
    "INSERT INTO commercial_qa_calls VALUES('qa','operator','2026-10-05T00:09:00Z')",
  );
  const view = await getBillingView(env, "b", end);
  expect(view.usage.durationMs).toBe(1000);
  expect(view.cycle?.end).toBe("2026-11-05T00:08:42.107Z");
  expect(view.usage.provisional).toBe(true);
});
it("cancels and verifies both components before account deletion, retaining retryability", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const canceled = new Set<string>();
  let failUsage = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const id = url.split("/").pop()!;
      if (init.method === "PATCH") {
        if (id === "usage" && failUsage)
          return new Response("", { status: 503 });
        canceled.add(id);
      }
      return Response.json(
        sub(id, { status: canceled.has(id) ? "cancelled" : "active" }),
      );
    }),
  );
  await expect(prepareCommercialDeletion(env, "b")).rejects.toThrow();
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get(),
  ).toEqual({ completed_at: null });
  failUsage = false;
  await prepareCommercialDeletion(env, "b");
  expect([...canceled].sort()).toEqual(["base", "usage"]);
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get(),
  ).toEqual({ completed_at: at });
});
async function signed(raw: string, id = "event") {
  const secret = btoa("synthetic-webhook-secret");
  const timestamp = String(Date.parse(at) / 1000),
    key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("synthetic-webhook-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${id}.${timestamp}.${raw}`),
        ),
      ),
    ),
  );
  return {
    secret,
    headers: new Headers({
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": "v1," + signature,
    }),
  };
}
it("authenticates raw bytes and deduplicates multicart webhook without trusting redirect", async () => {
  const raw = JSON.stringify({
      type: "payment.succeeded",
      timestamp: at,
      data: {
        is_multi_subscription: true,
        subscription_id: null,
        subscription_ids: ["base", "usage"],
      },
    }),
    auth = await signed(raw);
  env.DODO_WEBHOOK_SECRET = auth.secret;
  await expect(
    verifyDodoWebhook(raw + " ", auth.headers, auth.secret),
  ).rejects.toThrow();
  expect(await processDodoWebhook(env, raw, auth.headers)).toEqual({
    duplicate: false,
  });
  expect(account().status).toBe("active");
  expect(await processDodoWebhook(env, raw, auth.headers)).toEqual({
    duplicate: true,
  });
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
});
