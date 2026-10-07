import { readFileSync } from "node:fs";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
import {
  createCheckout,
  prepareCommercialDeletion,
  type CommercialEnv,
} from "../src/commercial-dodo";
import { orderPhoneNumber } from "../src/commercial-phone";
import {
  beginPaymentMethodUpdate,
  reconcilePaymentMethodUpdate,
} from "../src/commercial-payment";
let db: SqliteD1, env: CommercialEnv;
const auth = { userId: "u", passwordHash: "hash", sessionToken: "session" };
beforeEach(() => {
  db = new SqliteD1();
  applyMigrations(db);
  db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
  db.exec(readFileSync("migrations/0028_business_country.sql", "utf8"));
  db.exec(readFileSync("migrations/0029_phone_eligibility.sql", "utf8"));
  db.exec(`INSERT INTO users(id,email,password_hash) VALUES('u','synthetic@example.invalid','hash');
 INSERT INTO businesses(id,user_id,slug,name) VALUES('b','u','b','Business');
 INSERT INTO sessions(token,user_id,expires_at) VALUES('session','u','2999-01-01');
 INSERT INTO assistants(id,business_id,public_slug,name) VALUES('assistant','b','assistant','Assistant');
 INSERT INTO commercial_accounts(business_id,provider_mode,customer_id,status,activated_at,paid_through) VALUES('b','test','customer','active','2026-01-01','2999-01-01');
 INSERT INTO commercial_phone_quotes(id,business_id,phone_number,country,number_type,currency,setup_minor,monthly_minor,requirements_json,expires_at) VALUES('quote','b','+431234567','AT','local','USD',100,100,'[]','2999-01-01');`);
  db.exec("UPDATE businesses SET country='AT',address='Reviewed address' WHERE id='b'; INSERT INTO commercial_phone_approvals(id,business_id,country,number_type,status,business_name,business_address,business_country,reviewed_at,expires_at) SELECT 'approval',id,'AT','local','approved',name,address,country,'2026-01-01','2999-01-01' FROM businesses WHERE id='b'; UPDATE commercial_phone_quotes SET approval_id='approval',approval_revision=1 WHERE id='quote';");
  env = {
    DB: db,
    TELNYX_PURCHASES_ENABLED: "true",
    TELNYX_CARRIER_VERIFIED: "true",
    TELNYX_ENABLED: "true",
    TELNYX_API_KEY: "synthetic",
    TELNYX_CONNECTION_ID: "connection",
    TELNYX_PURCHASE_COUNTRY: "AT",
    TELNYX_MAX_SETUP_MINOR: "100",
    TELNYX_MAX_MONTHLY_MINOR: "100",
    TELNYX_PURCHASE_CURRENCY: "USD",
    DODO_MODE: "test",
    DODO_API_KEY: "synthetic",
  } as unknown as CommercialEnv;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});
it("does not purchase after deletion wins before the phone intent write", async () => {
  let held = false;
  env.DB = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: any[]) => {
      if (!held) {
        held = true;
        await prepareCommercialDeletion(env, "b", auth);
      }
      return db.batch(statements);
    },
  } as unknown as D1Database;
  await expect(
    orderPhoneNumber(env, "b", "quote", "assistant"),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    db.database.prepare("SELECT count(*) n FROM commercial_phone_orders").get(),
  ).toEqual({ n: 0 });
  expect(
    db.database.prepare("SELECT used_at FROM commercial_phone_quotes").get(),
  ).toEqual({ used_at: null });
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get()?.completed_at,
  ).toBeTruthy();
});
it.each(["expires_at", "status"])(
  "rechecks %s at phone intent admission",
  async (field) => {
    env.DB = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: any[]) => {
        db.exec(
          field === "expires_at"
            ? "UPDATE commercial_phone_quotes SET expires_at='2000-01-01'"
            : "UPDATE commercial_accounts SET status='cancelled'",
        );
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(
      orderPhoneNumber(env, "b", "quote", "assistant"),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      db.database.prepare("SELECT used_at FROM commercial_phone_quotes").get(),
    ).toEqual({ used_at: null });
  },
);
it("keeps deletion pending when the phone intent wins and safely recovers owned rental identity", async () => {
  let deleted = false,
    cleanupStarted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/v2/number_orders" && init.method === "POST") {
        await expect(
          prepareCommercialDeletion(env, "b", auth),
        ).rejects.toThrow();
        expect(
          db.database
            .prepare("SELECT completed_at FROM commercial_deletion_jobs")
            .get(),
        ).toEqual({ completed_at: null });
        return Response.json({ data: { id: "remoteorder" } });
      }
      if (path === "/v2/number_orders")
        return Response.json({
          data: [],
          meta: { total_results: 0, total_pages: 0, page_number: 1 },
        });
      if (path === "/v2/number_orders/remoteorder")
        return Response.json({
          data: {
            id: "remoteorder",
            status: "success",
            customer_reference: db.database
              .prepare("SELECT id FROM commercial_phone_orders")
              .get()!.id,
          },
        });
      if (path === "/v2/phone_numbers")
        return Response.json({
          data: [
            {
              id: "rental",
              phone_number: "+431234567",
              connection_id: "connection",
              status: "active",
            },
          ],
        });
      expect(path).toBe("/v2/phone_numbers/rental");
      if (init.method === "DELETE") {
        cleanupStarted = true;
        expect(
          db.database
            .prepare("SELECT provider_number_id FROM commercial_phone_orders")
            .get(),
        ).toEqual({ provider_number_id: "rental" });
        expect(
          db.database
            .prepare("SELECT count(*) n FROM telnyx_number_routes")
            .get(),
        ).toEqual({ n: 0 });
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return deleted
        ? new Response(null, { status: 404 })
        : Response.json({
            data: {
              id: "rental",
              phone_number: "+431234567",
              connection_id: "connection",
            },
          });
    }),
  );
  await orderPhoneNumber(env, "b", "quote", "assistant");
  await prepareCommercialDeletion(env, "b", auth);
  expect(cleanupStarted).toBe(true);
  expect(
    db.database.prepare("SELECT state FROM commercial_phone_orders").get(),
  ).toEqual({ state: "released" });
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get()?.completed_at,
  ).toBeTruthy();
});
it("does not create a checkout after deletion completes during product validation", async () => {
  db.exec("DELETE FROM commercial_accounts");
  Object.assign(env, {
    DODO_WEBHOOK_SECRET: "synthetic",
    COMMERCIAL_BILLING_VERIFIED: "true",
    COMMERCIAL_CHARGING_ENABLED: "true",
    COMMERCIAL_TAX_POLICY: "exclusive",
    DODO_PRODUCTS_JSON: JSON.stringify({ "flex:monthly": "product" }),
    DODO_METERS_JSON: JSON.stringify({
      "flex:monthly": { id: "meter", event: "cents" },
    }),
  });
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/products/product")
        return Response.json({
          product_id: "product",
          tax_category: "saas",
          price: {
            type: "usage_based_price",
            fixed_price: 1900,
            currency: "EUR",
            payment_frequency_count: 1,
            payment_frequency_interval: "Month",
            tax_inclusive: false,
            meters: [
              { meter_id: "meter", price_per_unit: 1, free_threshold: 0 },
            ],
          },
        });
      if (path === "/meters/meter") {
        await prepareCommercialDeletion(env, "b", auth);
        return Response.json({
          event_name: "cents",
          aggregation: { type: "max", key: "cents" },
        });
      }
      if (init.method === "POST") posts++;
      return Response.json({
        session_id: "checkout",
        checkout_url: "https://checkout.dodopayments.com/synthetic",
      });
    }),
  );
  await expect(
    createCheckout(
      env,
      { id: "b", name: "Business", email: "synthetic@example.invalid" },
      "flex",
      "monthly",
    ),
  ).rejects.toThrow();
  expect(posts).toBe(0);
  expect(
    db.database
      .prepare("SELECT count(*) n FROM commercial_checkout_intents")
      .get(),
  ).toEqual({ n: 0 });
});
function paymentJob() {
  db.exec(`INSERT INTO commercial_subscription_components(business_id,role,provider_mode,subscription_id,customer_id,product_id,status,period_start,period_end,updated_event_at) VALUES('b','usage','test','subscription','customer','product','active','2026-01-01','2999-01-01','2026-01-01');
 INSERT INTO commercial_payment_updates(business_id,id,source_subscription_id,payment_id,state,created_at) VALUES('b','old-job','subscription','old-payment','pending','2026-01-01');`);
}
it("excludes overlapping old reconciliation and replacement authorization until actual completion", async () => {
  paymentJob();
  let reads = 0,
    method = "old-method";
  const mutations: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.startsWith("/payments/"))
        return Response.json({
          customer: { customer_id: "customer" },
          subscription_id: "subscription",
          is_update_payment_method: true,
          status: "succeeded",
          payment_method_id: path.endsWith("/old-payment")
            ? "old-method"
            : "new-method",
        });
      if (path.endsWith("/update-payment-method")) {
        const body = JSON.parse(init.body as string);
        method = body.type === "new" ? "new-method" : body.payment_method_id;
        mutations.push(method);
        return Response.json({
          payment_id: "new-payment",
          payment_link: "https://checkout.dodopayments.com/synthetic",
        });
      }
      reads++;
      if (reads === 2) {
        await expect(reconcilePaymentMethodUpdate(env, "b")).rejects.toThrow();
        await expect(beginPaymentMethodUpdate(env, "b")).rejects.toThrow();
      }
      return Response.json({
        customer: { customer_id: "customer" },
        status: "active",
        product_id: "product",
        payment_method_id: method,
      });
    }),
  );
  expect(await reconcilePaymentMethodUpdate(env, "b")).toEqual({
    updated: true,
  });
  expect(mutations).toEqual([]);
  await beginPaymentMethodUpdate(env, "b");
  expect(await reconcilePaymentMethodUpdate(env, "b")).toEqual({
    updated: true,
  });
  expect(method).toBe("new-method");
  expect(mutations).toEqual(["new-method"]);
  expect(
    db.database
      .prepare("SELECT count(*) n FROM commercial_payment_writers")
      .get(),
  ).toEqual({ n: 0 });
});
it("retains a non-expiring payment writer after an uncertain external mutation", async () => {
  paymentJob();
  db.exec("UPDATE commercial_payment_updates SET state='complete'");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) =>
      init.method === "POST"
        ? new Response(null, { status: 503 })
        : Response.json({
            customer: { customer_id: "customer" },
            status: "active",
          }),
    ),
  );
  await expect(beginPaymentMethodUpdate(env, "b")).rejects.toThrow();
  expect(
    db.database.prepare("SELECT state FROM commercial_payment_writers").get(),
  ).toEqual({ state: "uncertain" });
  vi.mocked(fetch).mockClear();
  await expect(beginPaymentMethodUpdate(env, "b")).rejects.toThrow();
  await expect(reconcilePaymentMethodUpdate(env, "b")).rejects.toThrow();
  await expect(prepareCommercialDeletion(env, "b", auth)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(
    db.database
      .prepare("SELECT completed_at FROM commercial_deletion_jobs")
      .get(),
  ).toEqual({ completed_at: null });
});
it.each(["exact", "unrelated", "incomplete", "multiple", "missing"])(
  "discovers an ambiguous rental only from a complete exact reference result: %s",
  async (kind) => {
    db.exec(
      `INSERT INTO commercial_phone_orders(id,business_id,assistant_id,quote_id,phone_number,connection_id,created_at) VALUES('ambiguous','b','assistant','quote','+431234567','connection','2026-10-05');`,
    );
    let released = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url),
          path = u.pathname;
        expect(init.method).not.toBe("POST");
        if (path === "/v2/number_orders") {
          expect(u.searchParams.get("filter[customer_reference]")).toBe(
            "ambiguous",
          );
          return Response.json({
            data:
              kind === "missing"
                ? []
                : [
                    {
                      id: "remoteorder",
                      customer_reference:
                        kind === "unrelated" ? "other" : "ambiguous",
                      connection_id: "connection",
                      phone_numbers_count: 1,
                      phone_numbers: [{ phone_number: "+431234567" }],
                    },
                  ],
            meta: {
              total_results:
                kind === "multiple" ? 2 : kind === "missing" ? 0 : 1,
              total_pages: kind === "incomplete" ? 2 : 1,
              page_number: 1,
            },
          });
        }
        if (path === "/v2/number_orders/remoteorder")
          return Response.json({
            data: {
              id: "remoteorder",
              customer_reference: "ambiguous",
              status: "success",
            },
          });
        if (path === "/v2/phone_numbers")
          return Response.json({
            data: [
              {
                id: "rental",
                phone_number: "+431234567",
                connection_id: "connection",
                status: "active",
              },
            ],
          });
        expect(path).toBe("/v2/phone_numbers/rental");
        if (init.method === "DELETE") {
          released = true;
          return new Response(null, { status: 204 });
        }
        return released
          ? new Response(null, { status: 404 })
          : Response.json({
              data: { phone_number: "+431234567", connection_id: "connection" },
            });
      }),
    );
    if (kind === "exact") {
      await prepareCommercialDeletion(env, "b", auth);
      expect(released).toBe(true);
      expect(
        db.database
          .prepare(
            "SELECT state,provider_order_id,provider_number_id FROM commercial_phone_orders",
          )
          .get(),
      ).toEqual({
        state: "released",
        provider_order_id: "remoteorder",
        provider_number_id: "rental",
      });
    } else {
      await expect(prepareCommercialDeletion(env, "b", auth)).rejects.toThrow();
      expect(released).toBe(false);
      expect(
        db.database
          .prepare("SELECT provider_order_id FROM commercial_phone_orders")
          .get(),
      ).toEqual({ provider_order_id: null });
    }
    expect(
      db.database.prepare("SELECT count(*) n FROM telnyx_number_routes").get(),
    ).toEqual({ n: 0 });
  },
);
