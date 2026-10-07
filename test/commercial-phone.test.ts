import { readFileSync } from "node:fs";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  getPhoneView,
  orderPhoneNumber,
  releaseBusinessPhones,
  reconcilePhoneOrder,
  quotedMinor,
  assignPhoneNumber,
} from "../src/commercial-phone";
import type { CommercialEnv } from "../src/commercial-dodo";
let db: SqliteD1, env: CommercialEnv;
beforeEach(() => {
  db = new SqliteD1();
  applyMigrations(db);
  db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
  db.exec(readFileSync("migrations/0028_business_country.sql", "utf8"));
  db.exec(readFileSync("migrations/0029_phone_eligibility.sql", "utf8"));
  db.exec(
    "INSERT INTO users(id,email,password_hash) VALUES('u','u@example.invalid','x'); INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','B'); INSERT INTO assistants(id,business_id,public_slug,name) VALUES('asst','b','asst','A'); INSERT INTO commercial_phone_quotes(id,business_id,phone_number,country,number_type,currency,setup_minor,monthly_minor,requirements_json,expires_at) VALUES('quote','b','+431234567','AT','local','USD',100,100,'[]','2028-01-01');",
  );
  env = {
    DB: db,
    TELNYX_API_KEY: "synthetic",
    TELNYX_CONNECTION_ID: "connection",
  } as unknown as CommercialEnv;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});
const order = (state = "active") =>
  db.database
    .prepare(
      "INSERT INTO commercial_phone_orders(id,business_id,assistant_id,quote_id,phone_number,state,created_at,provider_order_id,provider_number_id,connection_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "order",
      "b",
      "asst",
      "quote",
      "+431234567",
      state,
      "2026-10-05",
      "remoteorder",
      "number",
      "connection",
    );
it("keeps unverified phone setup gated before a rental request", async () => {
  expect((await getPhoneView(env, "b")).provisioningAvailable).toBe(false);
  await expect(orderPhoneNumber(env, "b", "quote", "asst")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("retains number mapping on release uncertainty and finishes a verified retry", async () => {
  order();
  db.exec(
    "INSERT INTO telnyx_number_routes VALUES('connection','+431234567','b','asst',1)",
  );
  let removed = false,
    fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        if (fail) return new Response("", { status: 503 });
        removed = true;
        return new Response(null, { status: 204 });
      }
      return removed
        ? new Response("", { status: 404 })
        : Response.json({
            data: {
              id: "number",
              phone_number: "+431234567",
              connection_id: "connection",
            },
          });
    }),
  );
  await expect(releaseBusinessPhones(env, "b")).rejects.toThrow();
  expect(
    db.database.prepare("SELECT enabled FROM telnyx_number_routes").get(),
  ).toEqual({ enabled: 0 });
  expect(
    db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
  ).toEqual({ state: "active" });
  fail = false;
  await releaseBusinessPhones(env, "b");
  expect(
    db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
  ).toEqual({ state: "released" });
  expect(
    db.database.prepare("SELECT count(*) n FROM telnyx_number_routes").get(),
  ).toEqual({ n: 0 });
});
it("never releases an unrelated carrier number", async () => {
  order();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: { phone_number: "+1999999999", connection_id: "connection" },
      }),
    ),
  );
  await expect(releaseBusinessPhones(env, "b")).rejects.toThrow("ownership");
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
});
it("keeps incomplete order in review and confirms assigned number before disabled route", async () => {
  order("review");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/number_orders/")
        ? Response.json({
            data: {
              id: "remoteorder",
              status: "success",
              customer_reference: "order",
            },
          })
        : Response.json({
            data: [
              {
                id: "number",
                phone_number: "+431234567",
                connection_id: "connection",
                status: "active",
              },
            ],
          }),
    ),
  );
  expect(await reconcilePhoneOrder(env, "b", "order")).toEqual({
    id: "order",
    status: "active",
  });
  expect(
    db.database
      .prepare(
        "SELECT business_id,assistant_id,enabled FROM telnyx_number_routes",
      )
      .get(),
  ).toEqual({ business_id: "b", assistant_id: "asst", enabled: 0 });
});
it("persists verified cleanup identity without a route after deletion reserves the account", async () => {
  order("review");
  db.exec(
    "INSERT INTO commercial_deletion_jobs VALUES('b','2026-10-05',NULL); UPDATE commercial_phone_orders SET provider_number_id=NULL",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/number_orders/")
        ? Response.json({
            data: {
              id: "remoteorder",
              status: "success",
              customer_reference: "order",
            },
          })
        : Response.json({
            data: [
              {
                id: "number",
                phone_number: "+431234567",
                connection_id: "connection",
                status: "active",
              },
            ],
          }),
    ),
  );
  expect(await reconcilePhoneOrder(env, "b", "order")).toEqual({
    id: "order",
    status: "active",
  });
  expect(
    db.database
      .prepare("SELECT provider_number_id FROM commercial_phone_orders")
      .get(),
  ).toEqual({ provider_number_id: "number" });
  expect(
    db.database.prepare("SELECT count(*) n FROM telnyx_number_routes").get(),
  ).toEqual({ n: 0 });
});
it("does not round or parse ambiguous carrier quotes", () => {
  expect(quotedMinor("3.21")).toBe(321);
  expect(quotedMinor("0")).toBe(0);
  expect(() => quotedMinor("1.234")).toThrow();
  expect(() => quotedMinor("1e2")).toThrow();
});

it("distinguishes owned rental availability from actual answering enablement", async () => {
  order();
  db.exec(
    "INSERT INTO telnyx_number_routes VALUES('connection','+431234567','b','asst',0)",
  );
  expect((await getPhoneView(env, "b")).numbers[0]).toMatchObject({
    status: "active",
    enabled: false,
    assistantId: "asst",
  });
  db.exec("UPDATE telnyx_number_routes SET enabled=1");
  expect((await getPhoneView(env, "b")).numbers[0].enabled).toBe(true);
  await assignPhoneNumber(env, "b", "order", "asst", false);
  expect((await getPhoneView(env, "b")).numbers[0].enabled).toBe(false);
});
it.each(["pending", "failed", "released", "review"])(
  "preserves %s rental history when an eligible assistant is deleted",
  async (state) => {
    order(state);
    db.exec("DELETE FROM assistants WHERE id='asst'");
    expect(
      db.database
        .prepare("SELECT assistant_id,state FROM commercial_phone_orders")
        .get(),
    ).toEqual({ assistant_id: "asst", state });
    if (state !== "released")
      expect((await getPhoneView(env, "b")).numbers[0].assistantId).toBeNull();
  },
);
it("recovers and reassigns a rental after its historical assistant was deleted", async () => {
  order("review");
  db.exec(
    "DELETE FROM assistants WHERE id='asst'; INSERT INTO assistants(id,business_id,public_slug,name) VALUES('replacement','b','replacement','New');",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/number_orders/")
        ? Response.json({
            data: {
              id: "remoteorder",
              status: "success",
              customer_reference: "order",
            },
          })
        : Response.json({
            data: [
              {
                id: "number",
                phone_number: "+431234567",
                connection_id: "connection",
                status: "active",
              },
            ],
          }),
    ),
  );
  await reconcilePhoneOrder(env, "b", "order");
  expect(
    db.database.prepare("SELECT count(*) n FROM telnyx_number_routes").get(),
  ).toEqual({ n: 0 });
  await assignPhoneNumber(env, "b", "order", "replacement", false);
  expect(
    db.database
      .prepare("SELECT assistant_id,enabled FROM telnyx_number_routes")
      .get(),
  ).toEqual({ assistant_id: "replacement", enabled: 0 });
});
function paidPhoneAccount() {
  db.exec("UPDATE businesses SET country='AT',address='Reviewed address' WHERE id='b'; INSERT INTO commercial_phone_approvals(id,business_id,country,number_type,status,business_name,business_address,business_country,reviewed_at,expires_at) SELECT 'approval',id,'AT','local','approved',name,address,country,'2026-01-01','2999-01-01' FROM businesses WHERE id='b'; UPDATE commercial_phone_quotes SET approval_id='approval',approval_revision=1 WHERE id='quote';");
  db.exec(
    "INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,status,activated_at,paid_through) VALUES('b','test','customer','active','2026-01-01','2999-01-01')",
  );
  Object.assign(env, {
    TELNYX_PURCHASES_ENABLED: "true",
    TELNYX_CARRIER_VERIFIED: "true",
    TELNYX_ENABLED: "true",
    TELNYX_PURCHASE_COUNTRY: "AT",
    TELNYX_PURCHASE_CURRENCY: "USD",
    TELNYX_MAX_SETUP_MINOR: "100",
    TELNYX_MAX_MONTHLY_MINOR: "100",
  });
}
it.each(["cancellation", "paid_through", "retail_stop"])(
  "rejects a rental when %s eligibility expires at the SQL intent boundary",
  async (boundary) => {
    paidPhoneAccount();
    env.DB = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: any[]) => {
        if (boundary === "cancellation")
          db.exec(
            "INSERT INTO commercial_cancellations VALUES('b','2000-01-01','scheduled','2000-01-01')",
          );
        if (boundary === "paid_through")
          db.exec("UPDATE commercial_accounts SET paid_through='2000-01-01'");
        if (boundary === "retail_stop")
          db.exec(
            "UPDATE commercial_accounts SET retail_stopped_at='2000-01-01'",
          );
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(orderPhoneNumber(env, "b", "quote", "asst")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      db.database
        .prepare("SELECT COUNT(*) n FROM commercial_phone_orders")
        .get(),
    ).toEqual({ n: 0 });
  },
);
it("fails an unsent reserved rental if cancellation arrives before its provider request", async () => {
  paidPhoneAccount();
  let inserted = false;
  db.hook = (sql) => {
    if (
      !inserted &&
      sql.startsWith("SELECT o.id FROM commercial_phone_orders")
    ) {
      inserted = true;
      db.database.exec(
        "INSERT INTO commercial_cancellations VALUES('b','2000-01-01','scheduled','2000-01-01')",
      );
    }
  };
  await expect(orderPhoneNumber(env, "b", "quote", "asst")).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
  ).toEqual({ state: "failed" });
});
it.each(["failure", "pending", "allocated", "wrong_reference"])(
  "retains uncertain rentals and resolves only verified empty failure: %s",
  async (kind) => {
    order("review");
    db.exec("UPDATE commercial_phone_orders SET provider_number_id=NULL");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/number_orders/")
          ? Response.json({
              data: {
                id: "remoteorder",
                customer_reference:
                  kind === "wrong_reference" ? "foreign" : "order",
                status: kind === "pending" ? "pending" : "failure",
              },
            })
          : Response.json({
              data:
                kind === "allocated"
                  ? [
                      {
                        id: "number",
                        phone_number: "+431234567",
                        connection_id: "connection",
                      },
                    ]
                  : [],
              meta: {
                page_number: 1,
                total_pages: 1,
                total_results: kind === "allocated" ? 1 : 0,
              },
            }),
      ),
    );
    if (kind === "failure") {
      await releaseBusinessPhones(env, "b");
      expect(
        db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
      ).toEqual({ state: "failed" });
      vi.mocked(fetch).mockClear();
      await releaseBusinessPhones(env, "b");
      expect(fetch).not.toHaveBeenCalled();
    } else {
      await expect(releaseBusinessPhones(env, "b")).rejects.toThrow();
      expect(
        db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
      ).toEqual({ state: "review" });
    }
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([, init]) => init?.method === "DELETE" || init?.method === "POST",
        ),
    ).toBe(false);
  },
);
it("accepts carrier decimal padding without rounding sub-cent charges",()=>{
 for(const [quote,cents] of [["1.0000000",100],["7.2500000",725],["1.00000",100],["2.0000000",200],["0.0100000",1],["9999999.99000",999999999]] as const)expect(quotedMinor(quote)).toBe(cents);
 for(const quote of ["1.0000001","7.2510000","10000000.00","1.2e1","-1.00","+1.00","1,00"," 1.00","1.","Infinity","0."+"0".repeat(100),1.00,null])expect(()=>quotedMinor(quote)).toThrow();
});
