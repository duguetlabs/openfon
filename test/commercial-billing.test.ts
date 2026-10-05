import {
  requestCommercialCancellation,
  maintainCommercialBilling,
} from "../src/commercial-cancellation";
import {
  beginPaymentMethodUpdate,
  reconcilePaymentMethodUpdate,
  getCommercialInvoice,
} from "../src/commercial-payment";
import {
  prepareUsageSettlement,
  approveUsageSettlement,
  publishUsageSettlement,
} from "../src/commercial-settlement";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  reconcileSubscription,
  verifyDodoWebhook,
  processDodoWebhook,
  prepareCommercialDeletion,
  reconcileBusinessCheckouts,
  type CommercialEnv,
} from "../src/commercial-dodo";
import { getBillingView, commercialWorkspace } from "../src/commercial-api";
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
    "INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','x'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B'); INSERT INTO sessions(token,user_id,expires_at) VALUES('session','u','2027-01-01T00:00:00Z'); INSERT INTO commercial_checkout_intents(id,business_id,provider_mode,plan_id,cadence,product_id,usage_product_id,meter_id,event_name,created_at) VALUES('intent','b','test','flex','annual','baseprod','usageprod','meter','cents','2026-10-05T00:00:00Z')",
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
  await expect(
    prepareCommercialDeletion(env, "b", {
      userId: "u",
      passwordHash: "x",
      sessionToken: "session",
    }),
  ).rejects.toThrow();
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get(),
  ).toEqual({ completed_at: null });
  failUsage = false;
  await prepareCommercialDeletion(env, "b", {
    userId: "u",
    passwordHash: "x",
    sessionToken: "session",
  });
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

it("uses the same oldest workspace as business settings for same-owner accounts", async () => {
  db.exec(
    "DROP TRIGGER businesses_one_workspace_per_user; UPDATE businesses SET created_at='2026-10-04' WHERE id='b'; INSERT INTO businesses(id,user_id,slug,name,created_at) VALUES('another','u','another','Other','2026-10-05')",
  );
  expect((await commercialWorkspace(env, "u")).id).toBe("b");
});
it("keeps late adjustments attached to the original billing period", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  db.exec(
    "INSERT INTO calls(id,business_id,status,connected_at) VALUES('old','b','completed',CURRENT_TIMESTAMP); INSERT INTO commercial_usage_adjustments(id,business_id,call_id,delta_ms,cycle_start,cycle_end,reason,created_at,actor) VALUES('adj','b','old',60000,'2026-09-05T00:00:00Z','2026-10-05T00:00:00Z','late correction','2026-10-05T00:10:00Z','operator')",
  );
  expect(
    (await getBillingView(env, "b", Date.parse(at) + 60000)).usage.durationMs,
  ).toBe(0);
});
it("stale auth and active call block deletion reservation before external effects", async () => {
  await expect(
    prepareCommercialDeletion(env, "b", {
      userId: "u",
      passwordHash: "x",
      sessionToken: "stale",
    }),
  ).rejects.toThrow();
  db.exec(
    "INSERT INTO calls(id,business_id,status,connected_at) VALUES('running','b','active',CURRENT_TIMESTAMP)",
  );
  await expect(
    prepareCommercialDeletion(env, "b", {
      userId: "u",
      passwordHash: "x",
      sessionToken: "session",
    }),
  ).rejects.toThrow();
  expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  expect(
    db.database
      .prepare("SELECT COUNT(*) n FROM commercial_deletion_jobs")
      .get(),
  ).toEqual({ n: 0 });
});
it("projects current components when same-time webhook account writes interleave", async () => {
  let release!: () => void, reached!: () => void;
  const blocked = new Promise<void>((r) => (release = r)),
    paused = new Promise<void>((r) => (reached = r));
  let accounts = 0;
  const store = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (sql.includes("INSERT INTO commercial_accounts")) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (++accounts === 1) {
            reached();
            await blocked;
          }
          return run();
        };
      }
      return statement;
    },
    batch: db.batch.bind(db),
  };
  const concurrent = { ...env, DB: store } as unknown as CommercialEnv;
  const base = reconcileSubscription(concurrent, "base", at);
  await paused;
  await reconcileSubscription(concurrent, "usage", at);
  expect(account().status).toBe("active");
  release();
  await base;
  expect(account().status).toBe("active");
  expect(account().period_end).toBe("2026-11-05T00:08:42.107Z");
});

it("reserves historical sibling workspaces before the first external cancellation", async () => {
  db.exec(
    "DROP TRIGGER businesses_one_workspace_per_user; INSERT INTO businesses(id,user_id,slug,name) VALUES('sibling','u','sibling','Sibling')",
  );
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(
        db.database
          .prepare("SELECT count(*) n FROM commercial_deletion_jobs")
          .get(),
      ).toEqual({ n: 2 });
      return Response.json(sub(url.split("/").pop(), { status: "cancelled" }));
    }),
  );
  await prepareCommercialDeletion(env, "b", {
    userId: "u",
    passwordHash: "x",
    sessionToken: "session",
  });
  expect(
    db.database
      .prepare(
        "SELECT count(*) n FROM commercial_deletion_jobs WHERE completed_at IS NOT NULL",
      )
      .get(),
  ).toEqual({ n: 2 });
});
it("expires an abandoned checkout only after its lifetime and complete subscription reconciliation", async () => {
  vi.setSystemTime("2026-10-07T00:00:00Z");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [] })),
  );
  await reconcileBusinessCheckouts(env, "b");
  expect(
    db.database.prepare("SELECT state FROM commercial_checkout_intents").get(),
  ).toEqual({ state: "expired" });
});
async function closedSettlement() {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const begin = Date.parse("2026-10-06T00:00:00Z"),
    end = begin + 60000;
  db.exec(
    "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES('settled','b','completed','2026-10-06T00:00:00Z','2026-10-06T00:01:00Z')",
  );
  db.database
    .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
    .run("settled", "b", begin, end, 60000, at);
  vi.setSystemTime("2026-11-05T00:08:43Z");
  return prepareUsageSettlement(env, "b", "2026-10-05T00:08:12.128Z");
}
it("requires explicit credit reconciliation after a lower correction to an exported MAX snapshot", async () => {
  const draft = await closedSettlement();
  expect(draft.overageMinor).toBe(15);
  db.database
    .prepare("UPDATE commercial_usage_exports SET state='sent' WHERE id=?")
    .run(draft.id);
  db.exec(
    "INSERT INTO commercial_usage_adjustments(id,business_id,call_id,delta_ms,cycle_start,cycle_end,reason,created_at,actor) VALUES('correction','b','settled',-60000,'2026-10-05T00:08:12.128Z','2026-11-05T00:08:42.107Z','verified correction','2026-11-05T00:08:43Z','operator')",
  );
  const corrected = await prepareUsageSettlement(
    env,
    "b",
    "2026-10-05T00:08:12.128Z",
  );
  expect(corrected.state).toBe("reconciliation_required");
  expect(corrected.overageMinor).toBe(0);
  expect(
    db.database
      .prepare("SELECT overage_minor,state FROM commercial_usage_exports")
      .get(),
  ).toEqual({ overage_minor: 15, state: "reconciliation_required" });
});
it("does not shift late settled usage into a new invoice period", async () => {
  const draft = await closedSettlement();
  await expect(
    approveUsageSettlement(env, draft.id, "stale-hash"),
  ).rejects.toThrow();
  await approveUsageSettlement(env, draft.id, draft.computedHash);
  Object.assign(env, {
    COMMERCIAL_CHARGING_ENABLED: "true",
    COMMERCIAL_BILLING_VERIFIED: "true",
    DODO_WEBHOOK_SECRET: "synthetic",
    DODO_PRODUCTS_JSON: "{}",
    DODO_METERS_JSON: "{}",
  });
  vi.setSystemTime("2026-11-05T02:00:00Z");
  vi.mocked(fetch).mockClear();
  await expect(publishUsageSettlement(env, draft.id)).rejects.toThrow(
    "another month",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  "new",
  "exact",
  "event_id",
  "customer_id",
  "event_name",
  "timestamp",
  "cents",
  "missing",
])("requires exact duplicate settlement evidence: %s", async (kind) => {
  const draft = await closedSettlement();
  await approveUsageSettlement(env, draft.id, draft.computedHash);
  Object.assign(env, {
    COMMERCIAL_CHARGING_ENABLED: "true",
    COMMERCIAL_BILLING_VERIFIED: "true",
    DODO_WEBHOOK_SECRET: "synthetic",
    DODO_PRODUCTS_JSON: "{}",
    DODO_METERS_JSON: "{}",
  });
  let event: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/events/ingest")) {
        event = JSON.parse(init.body as string).events[0];
        return Response.json({ ingested_count: kind === "new" ? 1 : 0 });
      }
      expect(url).toContain("/events/" + event.event_id);
      if (kind === "missing") return new Response(null, { status: 404 });
      const response = { ...event, metadata: { ...event.metadata } };
      if (kind === "cents") response.metadata.cents++;
      else if (kind === "timestamp")
        response.timestamp = "2026-11-05T00:00:00Z";
      else if (kind !== "exact") response[kind] = "different";
      return Response.json(response);
    }),
  );
  if (["new", "exact"].includes(kind)) {
    await expect(publishUsageSettlement(env, draft.id)).resolves.toEqual({
      sent: true,
      duplicate: kind === "exact",
    });
    expect(fetch).toHaveBeenCalledTimes(kind === "new" ? 1 : 2);
  } else {
    await expect(publishUsageSettlement(env, draft.id)).rejects.toThrow(
      "reconciliation",
    );
    expect(
      db.database
        .prepare(
          "SELECT state,provider_reference FROM commercial_usage_exports",
        )
        .get(),
    ).toEqual({
      state: "reconciliation_required",
      provider_reference: "openfon-" + draft.computedHash,
    });
    vi.mocked(fetch).mockClear();
    await expect(publishUsageSettlement(env, draft.id)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  }
});

it("keeps annual usage mandate through paid term and cancels both at its exact end", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const scheduled = new Set<string>(),
    canceled = new Set<string>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const role = url.split("/").pop()!;
      if (init.method === "PATCH") {
        const body = JSON.parse(init.body as string);
        if (body.cancel_at_next_billing_date) scheduled.add(role);
        if (body.status === "cancelled") canceled.add(role);
      }
      return Response.json(
        sub(role, {
          cancel_at_next_billing_date: scheduled.has(role),
          status: canceled.has(role) ? "cancelled" : "active",
        }),
      );
    }),
  );
  const requested = await requestCommercialCancellation(env, "b");
  expect(requested.termEnd).toBe("2027-10-05T00:08:42.123Z");
  expect([...scheduled]).toEqual(["base"]);
  expect([...canceled]).toEqual([]);
  await maintainCommercialBilling(env, Date.parse(requested.termEnd) - 1);
  expect(canceled.size).toBe(0);
  await maintainCommercialBilling(env, Date.parse(requested.termEnd) + 1000);
  expect([...canceled].sort()).toEqual(["base", "usage"]);
  expect(account().retail_stopped_at).toBe(requested.termEnd);
});
it("respects cancellation cutoff while provider cancellation is unavailable", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  db.exec(
    "INSERT INTO commercial_cancellations VALUES('b','2026-10-05T00:10:01Z','preparing','2026-10-05T00:10:00Z')",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );
  expect(
    (await maintainCommercialBilling(env, Date.parse(at) + 2000)).pending,
  ).toBe(1);
  expect(account().retail_stopped_at).toBe("2026-10-05T00:10:01Z");
  expect(
    db.database.prepare("SELECT state FROM commercial_cancellations").get(),
  ).toEqual({ state: "closing" });
});
it("reconciles hosted authorization but retains uncertainty after a failed sibling write", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const methods: Record<string, string> = { base: "old", usage: "old" };
  let paymentSucceeded = false,
    failBase = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/payments/updatepay"))
        return Response.json({
          customer: { customer_id: "customer" },
          subscription_id: "usage",
          is_update_payment_method: true,
          status: paymentSucceeded ? "succeeded" : "processing",
          payment_method_id: "newmethod",
        });
      if (url.endsWith("/update-payment-method")) {
        const role = url.split("/").at(-2)!;
        const body = JSON.parse(init.body as string);
        if (body.type === "new")
          return Response.json({
            payment_id: "updatepay",
            payment_link: "https://test.checkout.dodopayments.com/update",
          });
        if (role === "base" && failBase)
          return new Response("", { status: 503 });
        methods[role] = body.payment_method_id;
        return Response.json({});
      }
      const role = url.split("/").pop()!;
      return Response.json(sub(role, { payment_method_id: methods[role] }));
    }),
  );
  expect((await beginPaymentMethodUpdate(env, "b")).url).toContain(
    "test.checkout",
  );
  expect(await reconcilePaymentMethodUpdate(env, "b")).toEqual({
    updated: false,
    pending: true,
  });
  paymentSucceeded = true;
  methods.usage = "newmethod";
  await expect(reconcilePaymentMethodUpdate(env, "b")).rejects.toThrow();
  expect(
    db.database.prepare("SELECT state FROM commercial_payment_updates").get(),
  ).toEqual({ state: "propagating" });
  failBase = false;
  vi.mocked(fetch).mockClear();
  await expect(reconcilePaymentMethodUpdate(env, "b")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    db.database.prepare("SELECT state FROM commercial_payment_writers").get(),
  ).toEqual({ state: "uncertain" });
  expect(methods).toEqual({ base: "old", usage: "newmethod" });
});
it("rejects invoice identifiers outside the current workspace before provider fetch", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  vi.mocked(fetch).mockClear();
  await expect(
    getCommercialInvoice(env, "b", "foreignpayment"),
  ).rejects.toThrow("Invoice not found");
  expect(fetch).not.toHaveBeenCalled();
});

it("does not confirm a renewed annual entitlement from only a new monthly usage component", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  vi.setSystemTime("2027-10-05T00:09:00Z");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        sub("usage", {
          previous_billing_date: "2027-10-05T00:08:42.107Z",
          next_billing_date: "2027-11-05T00:08:42.107Z",
        }),
      ),
    ),
  );
  await reconcileSubscription(env, "usage", "2027-10-05T00:09:00Z");
  expect(account().status).toBe("pending");
  expect(account().paid_through).toBe("2027-10-05T00:08:42.123Z");
  expect(account().retail_stopped_at).toBeNull();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        sub("base", {
          previous_billing_date: "2027-10-05T00:08:42.123Z",
          next_billing_date: "2028-10-05T00:08:42.123Z",
        }),
      ),
    ),
  );
  await reconcileSubscription(env, "base", "2027-10-05T00:09:01Z");
  expect(account().status).toBe("active");
  expect(account().paid_through).toBe("2027-11-05T00:08:42.107Z");
});

it.each(["on_hold", "past_due", "pending"])(
  "restores verified coverage after %s without charging the unavailable gap",
  async (status) => {
    await reconcileSubscription(env, "base", at);
    await reconcileSubscription(env, "usage", at);
    const initial = Date.parse(at),
      failAt = new Date(initial + 60000).toISOString(),
      recoverAt = new Date(initial + 120000).toISOString();
    vi.setSystemTime(failAt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(sub("usage", { status }))),
    );
    await reconcileSubscription(env, "usage", failAt);
    expect(account().retail_stopped_at).toBeNull();
    vi.setSystemTime(recoverAt);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(sub("usage"))),
    );
    await reconcileSubscription(env, "usage", recoverAt);
    expect(account().status).toBe("active");
    db.database
      .prepare(
        "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES('recovery','b','completed',?,?)",
      )
      .run(
        new Date(initial + 30000).toISOString(),
        new Date(initial + 150000).toISOString(),
      );
    db.database
      .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
      .run(
        "recovery",
        "b",
        initial + 30000,
        initial + 150000,
        120000,
        recoverAt,
      );
    expect(
      (await getBillingView(env, "b", initial + 180000)).usage.durationMs,
    ).toBe(60000);
    vi.setSystemTime("2026-11-05T00:08:43Z");
    const settled = await prepareUsageSettlement(
      env,
      "b",
      "2026-10-05T00:08:12.128Z",
    );
    expect(settled.overageMinor).toBe(15);
  },
);
it.each(["paid", "cancellation", "permanent"])(
  "clips customer estimates to the same %s boundary as settlement",
  async (boundary) => {
    await reconcileSubscription(env, "base", at);
    await reconcileSubscription(env, "usage", at);
    const initial = Date.parse(at),
      end = new Date(initial + 60000).toISOString();
    if (boundary === "paid")
      db.database
        .prepare("UPDATE commercial_accounts SET paid_through=?")
        .run(end);
    if (boundary === "permanent")
      db.database
        .prepare("UPDATE commercial_accounts SET retail_stopped_at=?")
        .run(end);
    if (boundary === "cancellation")
      db.database
        .prepare(
          "INSERT INTO commercial_cancellations VALUES('b',?,'scheduled',?)",
        )
        .run(end, at);
    db.database
      .prepare(
        "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES('bounded','b','completed',?,?)",
      )
      .run(at, new Date(initial + 180000).toISOString());
    db.database
      .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
      .run("bounded", "b", initial, initial + 180000, 180000, at);
    expect(
      (await getBillingView(env, "b", initial + 240000)).usage.durationMs,
    ).toBe(60000);
    vi.setSystemTime("2026-11-05T00:08:43Z");
    expect(
      (await prepareUsageSettlement(env, "b", "2026-10-05T00:08:12.128Z"))
        .overageMinor,
    ).toBe(15);
  },
);
it("closes expired coverage before recovering the next paid month", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const expiry = Date.parse("2026-11-05T00:08:42.107Z"),
    recovered = expiry + 120000;
  vi.setSystemTime(recovered);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        sub("usage", {
          previous_billing_date: new Date(expiry).toISOString(),
          next_billing_date: "2026-12-05T00:08:42.107Z",
        }),
      ),
    ),
  );
  await reconcileSubscription(env, "usage", new Date(recovered).toISOString());
  db.database
    .prepare(
      "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES('renewal','b','completed',?,?)",
    )
    .run(
      new Date(expiry).toISOString(),
      new Date(recovered + 60000).toISOString(),
    );
  db.database
    .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
    .run(
      "renewal",
      "b",
      expiry,
      recovered + 60000,
      180000,
      new Date(recovered).toISOString(),
    );
  expect(
    (await getBillingView(env, "b", recovered + 120000)).usage.durationMs,
  ).toBe(60000);
  expect(
    db.database
      .prepare("SELECT count(*) n FROM commercial_billing_periods")
      .get(),
  ).toEqual({ n: 2 });
});
it("retains delivered coverage when the cancellation scheduler confirms the stop later", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  const initial = Date.parse(at),
    cutoff = new Date(initial + 60000).toISOString();
  db.database
    .prepare("INSERT INTO commercial_cancellations VALUES('b',?,'scheduled',?)")
    .run(cutoff, at);
  db.database
    .prepare(
      "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES('cutoff','b','completed',?,?)",
    )
    .run(at, cutoff);
  db.database
    .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
    .run("cutoff", "b", initial, initial + 60000, 60000, cutoff);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(sub(url.split("/").pop(), { status: "cancelled" })),
    ),
  );
  await maintainCommercialBilling(env, initial + 90000);
  expect(
    (await getBillingView(env, "b", initial + 120000)).usage.durationMs,
  ).toBe(60000);
});
it("keeps owned invoice history readable while deletion awaits reconciliation", async () => {
  await reconcileSubscription(env, "base", at);
  await reconcileSubscription(env, "usage", at);
  db.exec("INSERT INTO commercial_deletion_jobs VALUES('b','2026-10-05',NULL)");
  const { listCommercialInvoices } = await import("../src/commercial-payment");
  expect(await listCommercialInvoices(env, "b")).toEqual({ invoices: [] });
});
