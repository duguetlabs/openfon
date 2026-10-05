import {
  prepareUsageSettlement,
  approveUsageSettlement,
} from "../src/commercial-settlement";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  reconcileSubscription,
  prepareCommercialDeletion,
  type CommercialEnv,
} from "../src/commercial-dodo";
import {
  exportCurrentUsage,
  maintainCurrentUsage,
} from "../src/commercial-export";
import { maintainCommercialBilling } from "../src/commercial-cancellation";
let db: SqliteD1,
  env: CommercialEnv,
  posts: Record<string, any>[],
  remoteStatus: string,
  ingestedCount: number;
const start = "2026-10-05T00:00:00.000Z",
  end = "2026-11-05T00:00:00.000Z",
  activated = "2026-10-05T00:10:00.000Z",
  now = "2026-10-05T00:12:00.000Z";
const sub = () => ({
  subscription_id: "usage",
  product_id: "product",
  metadata: { openfon_checkout_id: "intent" },
  customer: { customer_id: "customer" },
  currency: "EUR",
  quantity: 1,
  on_demand: false,
  trial_period_days: 0,
  recurring_pre_tax_amount: 1900,
  tax_inclusive: false,
  payment_frequency_count: 1,
  payment_frequency_interval: "Month",
  previous_billing_date: start,
  next_billing_date: end,
  meters: [{ meter_id: "meter", price_per_unit: 1, free_threshold: 0 }],
  status: remoteStatus,
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(activated);
  db = new SqliteD1();
  applyMigrations(db);
  db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
  db.exec(
    `INSERT INTO users(id,email,password_hash) VALUES('u','synthetic@example.invalid','hash');INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B');INSERT INTO sessions VALUES('session','u','2999-01-01');INSERT INTO commercial_checkout_intents(id,business_id,provider_mode,plan_id,cadence,product_id,usage_product_id,meter_id,event_name,created_at) VALUES('intent','b','test','flex','monthly','product','product','meter','cents','2026-10-05');`,
  );
  env = {
    DB: db,
    DODO_MODE: "test",
    DODO_API_KEY: "synthetic",
    DODO_WEBHOOK_SECRET: "synthetic",
    COMMERCIAL_BILLING_VERIFIED: "true",
    COMMERCIAL_CHARGING_ENABLED: "true",
    COMMERCIAL_TAX_POLICY: "exclusive",
    DODO_PRODUCTS_JSON: JSON.stringify({ "flex:monthly": "product" }),
    DODO_METERS_JSON: JSON.stringify({
      "flex:monthly": { id: "meter", event: "cents" },
    }),
  } as unknown as CommercialEnv;
  posts = [];
  remoteStatus = "active";
  ingestedCount = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/subscriptions/usage") return Response.json(sub());
      if (path === "/events/ingest") {
        posts.push(JSON.parse(init.body as string).events[0]);
        return Response.json({ ingested_count: ingestedCount });
      }
      if (path.startsWith("/events/"))
        return Response.json(
          posts.find((x) => x.event_id === path.split("/").pop()),
        );
      throw Error("Unexpected request");
    }),
  );
  await reconcileSubscription(env, "usage", activated);
  vi.setSystemTime(now);
  vi.mocked(fetch).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  db.close();
});
function call(id = "call", from = Date.parse(activated), to = from + 60000) {
  db.database
    .prepare(
      "INSERT INTO calls(id,business_id,status,connected_at,ended_at) VALUES(?,'b','completed',?,?)",
    )
    .run(id, new Date(from).toISOString(), new Date(to).toISOString());
  db.database
    .prepare("INSERT INTO commercial_call_usage VALUES(?,?,?,?,?,?)")
    .run(id, "b", from, to, to - from, new Date(to).toISOString());
}
it("exports cumulative rounded finalized cents once and advances without duplicating earlier usage", async () => {
  call();
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "ingested",
    overageMinor: 16,
  });
  expect(posts[0].metadata).toEqual({ cents: 16 });
  expect(posts[0].timestamp).toBe(now);
  vi.mocked(fetch).mockClear();
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "unchanged",
  });
  expect(fetch).not.toHaveBeenCalled();
  call("second", Date.parse(activated) + 60000, Date.parse(now));
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "ingested",
    overageMinor: 32,
  });
  expect(posts.map((x) => x.metadata.cents)).toEqual([16, 32]);
  expect(new Set(posts.map((x) => x.event_id)).size).toBe(2);
});
it("retains a single writer when concurrent scheduler runs overlap a provider POST", async () => {
  call();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (reached = r));
  vi.mocked(fetch).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("/events/ingest")) {
      reached();
      await held;
    }
    return original(...args);
  });
  const first = exportCurrentUsage(env, "b", start);
  await ready;
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "reconciliation_required",
    reason: "provider_confirmation_pending",
  });
  await expect(
    prepareCommercialDeletion(env, "b", {
      userId: "u",
      passwordHash: "hash",
      sessionToken: "session",
    }),
  ).rejects.toThrow("reconciliation");
  release();
  expect(await first).toEqual({ state: "ingested", overageMinor: 16 });
  expect(posts).toHaveLength(1);
});
it("excludes unfinished/future call intervals instead of sending provisional duration", async () => {
  call("future", Date.parse(now), Date.parse(now) + 60000);
  db.exec(
    "INSERT INTO calls(id,business_id,status,connected_at) VALUES('ongoing','b','active','2026-10-05T00:10:00Z')",
  );
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "unchanged",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it("requires exact event readback when ingestion reports a duplicate", async () => {
  call();
  ingestedCount = 0;
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "ingested",
    overageMinor: 16,
  });
  expect(
    vi
      .mocked(fetch)
      .mock.calls.some(([url]) =>
        String(url).includes("/events/openfon-live-"),
      ),
  ).toBe(true);
});
it("holds an uncertain POST for reconciliation without retrying or starting a replacement", async () => {
  call();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (...args) =>
    String(args[0]).endsWith("/events/ingest")
      ? new Response(null, { status: 503 })
      : original(...args),
  );
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "reconciliation_required",
    reason: "provider_result_uncertain",
  });
  vi.mocked(fetch).mockClear();
  await exportCurrentUsage(env, "b", start);
  expect(fetch).not.toHaveBeenCalled();
  expect(
    db.database.prepare("SELECT state FROM commercial_usage_snapshots").get(),
  ).toEqual({ state: "reconciliation_required" });
});
it.each(["late", "adjustment", "downward"])(
  "routes %s changes to review without moving or overwriting charges",
  async (kind) => {
    call();
    await exportCurrentUsage(env, "b", start);
    vi.mocked(fetch).mockClear();
    if (kind === "late") vi.setSystemTime(Date.parse(end) + 60000);
    if (kind === "adjustment")
      db.database
        .prepare(
          "INSERT INTO commercial_usage_adjustments VALUES('adjustment','b','call',-1,?,?,'verified','2026-10-05','operator')",
        )
        .run(start, end);
    if (kind === "downward")
      db.exec(
        "INSERT INTO commercial_qa_calls VALUES('call','operator','2026-10-05')",
      );
    expect((await exportCurrentUsage(env, "b", start)).state).toBe(
      "reconciliation_required",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
    expect(posts[0].metadata.cents).toBe(16);
    expect(posts[0].timestamp).toBe(now);
  },
);
it("revalidates the current mandate before publishing even if the local account was active", async () => {
  call();
  remoteStatus = "on_hold";
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "pending",
    reason: "coverage_pending",
  });
  expect(posts).toHaveLength(0);
});
it("checks a newly inserted cancellation boundary at the actual outbox claim", async () => {
  call();
  let changed = false;
  db.hook = (sql) => {
    if (
      !changed &&
      sql.startsWith("UPDATE commercial_usage_snapshots SET state='sending'")
    ) {
      changed = true;
      db.database
        .prepare(
          "INSERT INTO commercial_cancellations VALUES('b',?,'scheduled',?)",
        )
        .run(now, now);
    }
  };
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "pending",
    reason: "snapshot_changed",
  });
  expect(posts).toHaveLength(0);
});
it("runs through the existing minute maintenance but performs no export when verification is disabled", async () => {
  call();
  env.COMMERCIAL_BILLING_VERIFIED = undefined;
  expect((await maintainCommercialBilling(env)).usage.disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  env.COMMERCIAL_BILLING_VERIFIED = "true";
  expect((await maintainCommercialBilling(env)).usage.checked).toBe(1);
  expect(posts).toHaveLength(1);
});
it("limits each maintenance invocation to five periods", async () => {
  for (let i = 1; i <= 7; i++) {
    const uid = "u" + i,
      bid = "b" + i;
    db.database
      .prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)")
      .run(uid, uid + "@example.invalid", "hash");
    db.database
      .prepare("INSERT INTO businesses(id,user_id,slug,name) VALUES(?,?,?,?)")
      .run(bid, uid, bid, bid);
    db.database
      .prepare(
        "INSERT INTO commercial_checkout_intents(id,business_id,provider_mode,plan_id,cadence,product_id,meter_id,event_name,created_at) VALUES(?,?,'test','flex','monthly','product','meter','cents',?)",
      )
      .run("intent" + i, bid, activated);
    db.database
      .prepare(
        "INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,status,activated_at,subscription_id) VALUES(?,'test',?,'active',?,?)",
      )
      .run(bid, "customer" + i, activated, "intent" + i);
    db.database
      .prepare(
        "INSERT INTO commercial_billing_periods VALUES(?,?,?,?,'flex','monthly',?)",
      )
      .run(bid, "subscription" + i, start, end, activated);
  }
  expect((await maintainCurrentUsage(env)).checked).toBe(5);
  expect((await maintainCurrentUsage(env)).checked).toBe(5);
  expect(
    db.database
      .prepare("SELECT COUNT(*) n FROM commercial_usage_streams")
      .get(),
  ).toEqual({ n: 8 });
});

it("keeps an inserted export payload immutable even during recovery", async () => {
  call();
  await exportCurrentUsage(env, "b", start);
  expect(() =>
    db.exec("UPDATE commercial_usage_snapshots SET overage_minor=999"),
  ).toThrow("immutable");
  expect(
    db.database
      .prepare("SELECT overage_minor FROM commercial_usage_snapshots")
      .get(),
  ).toEqual({ overage_minor: 16 });
});

it("does not treat a lower closed-period settlement as undoing automatic MAX ingestion", async () => {
  call();
  await exportCurrentUsage(env, "b", start);
  db.exec(
    "INSERT INTO commercial_qa_calls VALUES('call','operator','2026-10-05')",
  );
  vi.setSystemTime(Date.parse(end) + 60000);
  const settlement = await prepareUsageSettlement(env, "b", start);
  expect(settlement.state).toBe("reconciliation_required");
  expect(settlement.previousOverageMinor).toBe(16);
  expect(settlement.overageMinor).toBe(0);
  await expect(
    approveUsageSettlement(env, settlement.id, settlement.computedHash),
  ).rejects.toThrow();
});
it("defensively fences direct-database QA drift at the export claim, outside supported QA API behavior", async () => {
  call();
  let marked = false;
  db.hook = (sql) => {
    if (
      !marked &&
      sql.startsWith("UPDATE commercial_usage_snapshots SET state='sending'")
    ) {
      marked = true;
      db.database.exec(
        "INSERT INTO commercial_qa_calls VALUES('call','operator','2026-10-05')",
      );
    }
  };
  expect(await exportCurrentUsage(env, "b", start)).toEqual({
    state: "pending",
    reason: "snapshot_changed",
  });
  expect(posts).toHaveLength(0);
});
it.each(["unsnapshotted", "prepared", "ingested"])(
  "keeps %s outstanding retail usage before irreversible deletion cleanup",
  async (kind) => {
    call();
    if (kind === "ingested") await exportCurrentUsage(env, "b", start);
    if (kind === "prepared") {
      db.database
        .prepare(
          "INSERT INTO commercial_usage_streams(business_id,cycle_start,cycle_end,last_checked_at) VALUES(?,?,?,?)",
        )
        .run("b", start, end, now);
      db.database
        .prepare(
          "INSERT INTO commercial_usage_snapshots VALUES('prepared','b',?,?,'usage','customer','test','cents',?,60000,16,'prepared',?,NULL)",
        )
        .run(start, end, now, now);
    }
    vi.mocked(fetch).mockClear();
    await expect(
      prepareCommercialDeletion(env, "b", {
        userId: "u",
        passwordHash: "hash",
        sessionToken: "session",
      }),
    ).rejects.toThrow("reconciliation");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      db.database
        .prepare("SELECT completed_at FROM commercial_deletion_jobs")
        .get(),
    ).toEqual({ completed_at: null });
    expect(
      db.database.prepare("SELECT COUNT(*) n FROM commercial_call_usage").get(),
    ).toEqual({ n: 1 });
  },
);
it.each(["no_due", "invoice_reconciled", "outbox_reconciled"])(
  "allows an idempotent clean deletion retry after %s evidence",
  async (kind) => {
    if (kind !== "no_due") {
      call();
      if (kind === "outbox_reconciled") {
        db.database
          .prepare(
            "INSERT INTO commercial_usage_streams(business_id,cycle_start,cycle_end,last_checked_at) VALUES(?,?,?,?)",
          )
          .run("b", start, end, now);
        db.database
          .prepare(
            "INSERT INTO commercial_usage_snapshots VALUES('prepared','b',?,?,'usage','customer','test','cents',?,60000,16,'prepared',?,NULL)",
          )
          .run(start, end, now, now);
      }
      await expect(
        prepareCommercialDeletion(env, "b", {
          userId: "u",
          passwordHash: "hash",
          sessionToken: "session",
        }),
      ).rejects.toThrow();
      if (kind === "outbox_reconciled")
        db.exec("UPDATE commercial_usage_snapshots SET state='reconciled'");
      db.database
        .prepare(
          "INSERT INTO commercial_usage_exports VALUES('settlement','b',?,?,60000,16,'invoice_reconciled','operator-verified','synthetic-hash',?)",
        )
        .run(start, end, now);
    }
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") canceled = true;
        return Response.json({
          ...sub(),
          status: canceled ? "cancelled" : "active",
        });
      }),
    );
    await prepareCommercialDeletion(env, "b", {
      userId: "u",
      passwordHash: "hash",
      sessionToken: "session",
    });
    expect(
      db.database
        .prepare("SELECT completed_at FROM commercial_deletion_jobs")
        .get()?.completed_at,
    ).toBeTruthy();
    expect(canceled).toBe(true);
  },
);
