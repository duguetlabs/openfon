import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  finishDueCommercialCancellations,
  maintainCommercialBilling,
} from "../src/commercial-cancellation";
import type { CommercialEnv } from "../src/commercial-dodo";

const now = Date.parse("2026-10-05T12:00:00.000Z");
let db: SqliteD1, env: CommercialEnv;
beforeEach(() => {
  db = new SqliteD1();
  applyMigrations(db);
  db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
  env = {
    DB: db,
    DODO_MODE: "test",
    DODO_API_KEY: "synthetic",
  } as unknown as CommercialEnv;
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});
function seed(count: number, phase: "due" | "preparing", offset = 0) {
  for (let i = offset; i < count + offset; i++) {
    const id = "b" + i,
      term = new Date(
        now + (phase === "due" ? -60000 : 60000) + i,
      ).toISOString();
    db.database
      .prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,'hash')")
      .run(id, id + "@example.invalid");
    db.database
      .prepare("INSERT INTO businesses(id,user_id,slug,name) VALUES(?,?,?,?)")
      .run(id, id, id, id);
    db.database
      .prepare(
        "INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,cadence,status) VALUES(?,'test',?,'monthly','active')",
      )
      .run(id, "customer_" + id);
    db.database
      .prepare("INSERT INTO commercial_cancellations VALUES(?,?,?,?)")
      .run(
        id,
        term,
        phase === "due" ? "scheduled" : "preparing",
        new Date(now - 120000 + i).toISOString(),
      );
    db.database
      .prepare(
        "INSERT INTO commercial_subscription_components VALUES(?,'usage','test',?,?,'product','active',?,?,?)",
      )
      .run(
        id,
        "sub_" + id,
        "customer_" + id,
        new Date(now - 3600000).toISOString(),
        term,
        new Date(now - 3600000).toISOString(),
      );
  }
}
it.each(["due", "preparing"] as const)(
  "rotates %s retries beyond five persistent failures across a fresh maintenance context",
  async (phase) => {
    seed(6, phase);
    const attempts: string[] = [],
      patches: string[] = [],
      canceled = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const id = url.split("sub_").pop()!;
        if (init.method === "GET") attempts.push(id);
        if (id !== "b5") return new Response(null, { status: 503 });
        if (init.method === "PATCH") {
          patches.push(id);
          canceled.add(id);
        }
        return Response.json({
          customer: { customer_id: "customer_" + id },
          product_id: "product",
          status: phase === "due" && canceled.has(id) ? "cancelled" : "active",
          cancel_at_next_billing_date: canceled.has(id),
          next_billing_date: new Date(now + 60000 + 5).toISOString(),
        });
      }),
    );
    await maintainCommercialBilling(env, now);
    expect(new Set(attempts)).toEqual(new Set(["b0", "b1", "b2", "b3", "b4"]));
    attempts.length = 0;
    await maintainCommercialBilling({ ...env }, now);
    expect(new Set(attempts).has("b5")).toBe(true);
    expect(patches).toEqual(["b5"]);
    expect(new Set(attempts).size).toBe(5);
    expect(
      db.database
        .prepare(
          "SELECT state FROM commercial_cancellations WHERE business_id='b5'",
        )
        .get(),
    ).toEqual({ state: phase === "due" ? "complete" : "scheduled" });
    expect(
      db.database
        .prepare(
          "SELECT count(*) n FROM commercial_cancellations WHERE business_id<>'b5' AND state=?",
        )
        .get(phase === "due" ? "closing" : "preparing"),
    ).toEqual({ n: 5 });
    if (phase === "due")
      expect(
        db.database
          .prepare(
            "SELECT count(*) n FROM commercial_accounts WHERE retail_stopped_at IS NOT NULL",
          )
          .get(),
      ).toEqual({ n: 6 });
  },
);

it("concurrent maintenance reserves distinct bounded batches before held provider reads", async () => {
  seed(10, "due");
  const attempts: string[] = [];
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      attempts.push(url.split("sub_").pop()!);
      if (attempts.length === 2) entered();
      await held;
      return new Response(null, { status: 503 });
    }),
  );
  const first = finishDueCommercialCancellations(env, now),
    second = finishDueCommercialCancellations({ ...env }, now);
  await ready;
  release();
  expect(await Promise.all([first, second])).toEqual([
    { completed: 0, pending: 5 },
    { completed: 0, pending: 5 },
  ]);
  expect(attempts).toHaveLength(10);
  expect(new Set(attempts).size).toBe(10);
  expect(
    db.database
      .prepare(
        "SELECT count(*) n FROM commercial_cancellations WHERE state='closing'",
      )
      .get(),
  ).toEqual({ n: 10 });
});

it("new arrivals enter by request time without starving earlier retries or losing their own turn", async () => {
  seed(5, "due");
  const attempts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      attempts.push(url.split("sub_").pop()!);
      return new Response(null, { status: 503 });
    }),
  );
  await finishDueCommercialCancellations(env, now);
  seed(1, "due", 5);
  db.database
    .prepare(
      "UPDATE commercial_cancellations SET requested_at=? WHERE business_id='b5'",
    )
    .run(new Date(now + 1).toISOString());
  attempts.length = 0;
  await finishDueCommercialCancellations({ ...env }, now + 2);
  expect(new Set(attempts)).toEqual(new Set(["b0", "b1", "b2", "b3", "b4"]));
  attempts.length = 0;
  await finishDueCommercialCancellations({ ...env }, now + 2);
  expect(attempts).toContain("b5");
  expect(attempts).toHaveLength(5);
});

it("due retries have independent rotation after preparation and metadata cascades with account deletion", async () => {
  seed(6, "preparing");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  await maintainCommercialBilling(env, now);
  db.database
    .prepare("UPDATE commercial_cancellations SET term_end=?")
    .run(new Date(now - 1).toISOString());
  await finishDueCommercialCancellations({ ...env }, now);
  await finishDueCommercialCancellations({ ...env }, now);
  expect(
    db.database
      .prepare(
        "SELECT phase,count(*) n FROM commercial_cancellation_attempts GROUP BY phase ORDER BY phase",
      )
      .all(),
  ).toEqual([
    { phase: "due", n: 6 },
    { phase: "preparing", n: 5 },
  ]);
  expect(
    db.database
      .prepare(
        "SELECT count(*) n FROM commercial_cancellations WHERE state='closing'",
      )
      .get(),
  ).toEqual({ n: 6 });
  db.exec("DELETE FROM businesses WHERE id='b0'");
  expect(
    db.database
      .prepare(
        "SELECT count(*) n FROM commercial_cancellation_attempts WHERE business_id='b0'",
      )
      .get(),
  ).toEqual({ n: 0 });
  expect(
    db.database
      .prepare(
        "SELECT count(*) n FROM commercial_cancellation_attempts WHERE business_id='b1'",
      )
      .get(),
  ).toEqual({ n: 2 });
});
