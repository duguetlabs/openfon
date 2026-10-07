import { approvedPhoneSelection, phoneEligibility, CURRENT_PHONE_APPROVAL, QUOTED_PHONE_APPROVAL } from './commercial-phone-eligibility';
import { validBusinessCountry } from './countries';
import {
  BillingError,
  providerId,
  type CommercialEnv,
} from "./commercial-dodo";
import { readLivekitBody } from "./livekit-body";

const e164 = (v: unknown): v is string =>
  typeof v === "string" && /^\+[1-9]\d{1,14}$/.test(v);
export function phoneProvisioningReady(env: CommercialEnv) {
  return (
    env.TELNYX_PURCHASES_ENABLED === "true" &&
    env.TELNYX_CARRIER_VERIFIED === "true" &&
    env.TELNYX_ENABLED === "true" &&
    !!env.TELNYX_API_KEY &&
    !!env.TELNYX_CONNECTION_ID &&
    Boolean(env.TELNYX_PURCHASE_COUNTRY && validBusinessCountry(env.TELNYX_PURCHASE_COUNTRY)) &&
    /^\d+$/.test(env.TELNYX_MAX_SETUP_MINOR ?? "") &&
    /^\d+$/.test(env.TELNYX_MAX_MONTHLY_MINOR ?? "") &&
    /^[A-Z]{3}$/.test(env.TELNYX_PURCHASE_CURRENCY ?? "")
  );
}
export async function phoneRequest(
  env: CommercialEnv,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  if (!env.TELNYX_API_KEY || !path.startsWith("/"))
    throw new BillingError("Phone service is not configured.");
  let response: Response;
  try {
    response = await fetch("https://api.telnyx.com/v2" + path, {
      method,
      redirect: "manual", // Workers-compatible; non-2xx responses, including redirects, are rejected.
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.TELNYX_API_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new BillingError(
      "Phone service could not be reached. Please retry later.",
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    void response.body?.cancel();
    throw new BillingError(
      "Phone service could not complete this request. Please retry later.",
    );
  }
  if (response.status === 204) return {};
  try {
    return JSON.parse(
      await readLivekitBody({ body: response.body } as Request),
    );
  } catch {
    throw new BillingError("Phone service returned an unexpected response.");
  }
}
export function quotedMinor(value: unknown): number {
  if (typeof value !== "string" || value.length > 32 || !/^\d{1,7}(\.\d{1,2}0*)?$/.test(value))
    throw new BillingError("This number needs a new price quote.");
  const [w, f = ""] = value.split(".");
  return Number(w) * 100 + Number(f.slice(0, 2).padEnd(2, "0"));
}
export async function getPhoneView(env: CommercialEnv, businessId: string) {
  const { results } = await env.DB.prepare(
    `SELECT o.id,o.phone_number AS number,COALESCE(r.assistant_id,a.id) AS assistantId,o.state AS status,COALESCE(r.enabled,0) AS enabled
    FROM commercial_phone_orders o LEFT JOIN telnyx_number_routes r ON r.connection_id=o.connection_id AND r.phone_number=o.phone_number AND r.business_id=o.business_id
    LEFT JOIN assistants a ON a.id=o.assistant_id AND a.business_id=o.business_id
    WHERE o.business_id=? AND o.state<>'released' ORDER BY o.created_at`,
  )
    .bind(businessId)
    .all();
  return {
    numbers: results.map((row) => ({ ...row, enabled: row.enabled === 1 })),
    ...await phoneEligibility(env, businessId, phoneProvisioningReady(env)),
  };
}
export async function quotePhoneNumbers(
  env: CommercialEnv,
  businessId: string,
  input: Record<string, unknown>,
) {
  if (
    Object.keys(input).some(
      (k) => !["country", "areaCode", "type"].includes(k),
    ) ||
    typeof input.country !== "string" ||
    !validBusinessCountry(input.country) ||
    !["local", "toll_free"].includes(input.type as string) ||
    (input.areaCode !== undefined &&
      (typeof input.areaCode !== "string" || !/^\d{1,6}$/.test(input.areaCode)))
  )
    throw new BillingError("Choose a valid country and number type.", 400);
  if (
    !phoneProvisioningReady(env) ||
    input.country !== env.TELNYX_PURCHASE_COUNTRY
  )
    throw new BillingError(
      "Phone setup is not available for this country yet.",
      409,
    );
  const area = typeof input.areaCode === "string" ? input.areaCode : null;
  const approval = await approvedPhoneSelection(env,businessId,input.country,input.type as string,area);
  const params = new URLSearchParams({
    "filter[country_code]": input.country,
    "filter[phone_number_type]": input.type as string,
    "filter[limit]": "5",
  });
  if (input.areaCode)
    params.set("filter[national_destination_code]", input.areaCode as string);
  const response = await phoneRequest(
    env,
    "/available_phone_numbers?" + params,
  );
  if (!Array.isArray(response?.data))
    throw new BillingError("No phone numbers could be checked.");
  const quotes = [];
  for (const n of response.data.slice(0, 5)) {
    if (!e164(n.phone_number) || !n.cost_information) continue;
    // Reject explicit mismatches. Area-scoped reviews additionally require the
    // carrier to identify the returned destination code; a filter is not proof.
    const country = n.country_code ?? n.region_information?.find((r:any)=>r.region_type==='country_code')?.region_name;
    const numberType = n.phone_number_type;
    const destination = n.national_destination_code;
    if ((country !== undefined && country !== input.country) || (numberType !== undefined && numberType !== input.type) ||
        (approval.area_code !== null && String(destination ?? '') !== approval.area_code) ||
        (destination !== undefined && area !== null && String(destination) !== area)) continue;
    const setupMinor = quotedMinor(n.cost_information.upfront_cost),
      monthlyMinor = quotedMinor(n.cost_information.monthly_cost),
      currency = n.cost_information.currency;
    if (
      currency !== env.TELNYX_PURCHASE_CURRENCY ||
      setupMinor > Number(env.TELNYX_MAX_SETUP_MINOR) ||
      monthlyMinor > Number(env.TELNYX_MAX_MONTHLY_MINOR)
    )
      continue;
    const id = crypto.randomUUID(),
      expiresAt = new Date(Date.now() + 300000).toISOString();
    // Do not accept identity documents in this API. Regulatory review stays pending.
    const requirements = [
      "Business and identity requirements may apply before activation.",
    ];
    const inserted = await env.DB.prepare(
      `INSERT INTO commercial_phone_quotes(id,business_id,phone_number,country,number_type,currency,setup_minor,monthly_minor,requirements_json,expires_at,approval_id,approval_revision,area_code)
       SELECT ?,b.id,?,?,?,?,?,?,?,?,a.id,a.revision,? FROM commercial_phone_approvals a JOIN businesses b ON b.id=a.business_id
       WHERE a.id=? AND a.revision=? AND b.id=? AND ${CURRENT_PHONE_APPROVAL}
       AND a.country=? AND a.number_type=? AND (a.area_code IS NULL OR a.area_code IS ?)`
    ).bind(id,n.phone_number,input.country,input.type,currency,setupMinor,monthlyMinor,JSON.stringify(requirements),expiresAt,area,
      approval.id,approval.revision,businessId,input.country,input.type,area).run();
    if(inserted.meta.changes!==1)throw new BillingError('Your business details or phone review changed. Check your details and search again.',409);
    quotes.push({
      id,
      number: n.phone_number,
      country: input.country,
      type: input.type,
      monthlyMinor,
      setupMinor,
      currency,
      requirements,
      expiresAt,
    });
  }
  return { quotes };
}
export async function orderPhoneNumber(
  env: CommercialEnv,
  businessId: string,
  quoteId: unknown,
  assistantId: unknown,
) {
  if (!providerId(quoteId) || !providerId(assistantId))
    throw new BillingError("Choose a number and assistant.", 400);
  const existing = await env.DB.prepare(
    "SELECT id,state AS status FROM commercial_phone_orders WHERE quote_id=? AND business_id=?",
  )
    .bind(quoteId, businessId)
    .first();
  if (existing) return existing;
  if (!phoneProvisioningReady(env))
    throw new BillingError("Phone setup is not available yet.", 409);
  const quote = await env.DB.prepare(
    `SELECT q.* FROM commercial_phone_quotes q WHERE q.id=? AND q.business_id=? AND q.used_at IS NULL AND q.expires_at>? AND ${QUOTED_PHONE_APPROVAL}`,
  )
    .bind(quoteId, businessId, new Date().toISOString())
    .first<any>();
  if (
    !quote ||
    quote.country !== env.TELNYX_PURCHASE_COUNTRY ||
    quote.currency !== env.TELNYX_PURCHASE_CURRENCY ||
    quote.setup_minor > Number(env.TELNYX_MAX_SETUP_MINOR) ||
    quote.monthly_minor > Number(env.TELNYX_MAX_MONTHLY_MINOR)
  )
    throw new BillingError(
      "This quote expired. Please choose a number again.",
      409,
    );
  const assistant = await env.DB.prepare(
    "SELECT id FROM assistants WHERE id=? AND business_id=?",
  )
    .bind(assistantId, businessId)
    .first();
  if (!assistant) throw new BillingError("Choose one of your assistants.", 400);
  if (
    await env.DB.prepare(
      "SELECT business_id FROM commercial_deletion_jobs WHERE business_id=?",
    )
      .bind(businessId)
      .first()
  )
    throw new BillingError("Account deletion is in progress.", 409);
  const account = await env.DB.prepare(
    "SELECT business_id FROM commercial_accounts WHERE business_id=? AND status='active'",
  )
    .bind(businessId)
    .first();
  if (!account)
    throw new BillingError(
      "Activate your subscription before ordering a number.",
      409,
    );
  const id = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO commercial_phone_orders(id,business_id,assistant_id,quote_id,phone_number,connection_id,created_at)
        SELECT ?,?,?,q.id,q.phone_number,?,? FROM commercial_phone_quotes q
        WHERE q.id=? AND q.business_id=? AND q.used_at IS NULL AND julianday(q.expires_at)>julianday('now')
        AND q.phone_number=? AND q.country=? AND q.currency=? AND q.setup_minor<=? AND q.monthly_minor<=?
        AND ${QUOTED_PHONE_APPROVAL}
        AND EXISTS(SELECT 1 FROM assistants WHERE id=? AND business_id=?)
        AND EXISTS(SELECT 1 FROM commercial_accounts WHERE business_id=? AND status='active'
          AND activated_at IS NOT NULL AND julianday(paid_through)>julianday('now')
          AND (retail_stopped_at IS NULL OR julianday(retail_stopped_at)>julianday('now')))
        AND NOT EXISTS(SELECT 1 FROM commercial_cancellations WHERE business_id=? AND julianday(term_end)<=julianday('now'))
        AND NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)`,
      ).bind(
        id,
        businessId,
        assistantId,
        env.TELNYX_CONNECTION_ID!,
        new Date().toISOString(),
        quoteId,
        businessId,
        quote.phone_number,
        env.TELNYX_PURCHASE_COUNTRY!,
        env.TELNYX_PURCHASE_CURRENCY!,
        Number(env.TELNYX_MAX_SETUP_MINOR),
        Number(env.TELNYX_MAX_MONTHLY_MINOR),
        assistantId,
        businessId,
        businessId,
        businessId,
        businessId,
      ),
      env.DB.prepare(
        "UPDATE commercial_phone_quotes SET used_at=? WHERE id=? AND business_id=? AND used_at IS NULL AND EXISTS(SELECT 1 FROM commercial_phone_orders WHERE id=? AND business_id=? AND quote_id=commercial_phone_quotes.id)",
      ).bind(new Date().toISOString(), quoteId, businessId, id, businessId),
    ]);
  } catch {
    throw new BillingError(
      "This number is already being ordered. Refresh its status.",
      409,
    );
  }
  const reserved = await env.DB.prepare(
    "SELECT id FROM commercial_phone_orders WHERE id=? AND business_id=?",
  )
    .bind(id, businessId)
    .first();
  if (!reserved)
    throw new BillingError(
      "This order changed or account deletion started. Refresh its status.",
      409,
    );
  const eligible = await env.DB.prepare(
    `SELECT o.id FROM commercial_phone_orders o JOIN commercial_accounts a ON a.business_id=o.business_id
    JOIN commercial_phone_quotes q ON q.id=o.quote_id AND q.business_id=o.business_id
    WHERE o.id=? AND o.business_id=? AND o.state='pending' AND a.status='active' AND a.activated_at IS NOT NULL
    AND julianday(a.paid_through)>julianday('now') AND (a.retail_stopped_at IS NULL OR julianday(a.retail_stopped_at)>julianday('now'))
    AND NOT EXISTS(SELECT 1 FROM commercial_cancellations c WHERE c.business_id=o.business_id AND julianday(c.term_end)<=julianday('now'))
    AND NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs d WHERE d.business_id=o.business_id)
    AND EXISTS(SELECT 1 FROM assistants ass WHERE ass.id=o.assistant_id AND ass.business_id=o.business_id)
    AND q.country=? AND q.currency=? AND q.setup_minor<=? AND q.monthly_minor<=? AND julianday(q.expires_at)>julianday('now')
    AND ${QUOTED_PHONE_APPROVAL}`,
  )
    .bind(id, businessId, env.TELNYX_PURCHASE_COUNTRY!, env.TELNYX_PURCHASE_CURRENCY!, Number(env.TELNYX_MAX_SETUP_MINOR), Number(env.TELNYX_MAX_MONTHLY_MINOR))
    .first();
  if (!eligible) {
    // No provider request was made: this reservation is safe to fail locally.
    await env.DB.prepare(
      "UPDATE commercial_phone_orders SET state='failed' WHERE id=? AND business_id=? AND state='pending' AND provider_order_id IS NULL AND provider_number_id IS NULL",
    )
      .bind(id, businessId)
      .run();
    throw new BillingError(
      "Your subscription or account changed before ordering. Refresh billing settings.",
      409,
    );
  }
  // Never retry an ambiguous rental POST. The durable reference supports reconciliation.
  const response = await phoneRequest(env, "/number_orders", "POST", {
    phone_numbers: [{ phone_number: quote.phone_number }],
    connection_id: env.TELNYX_CONNECTION_ID,
    customer_reference: id,
  });
  if (!providerId(response?.data?.id))
    throw new BillingError(
      "Your number order is being reconciled. Do not order it again.",
      409,
    );
  await env.DB.prepare(
    "UPDATE commercial_phone_orders SET provider_order_id=?,state='review' WHERE id=? AND business_id=?",
  )
    .bind(response.data.id, id, businessId)
    .run();
  return { id, status: "review" };
}
export async function assignPhoneNumber(
  env: CommercialEnv,
  businessId: string,
  id: string,
  assistantId: unknown,
  enabled: unknown,
) {
  if (!providerId(assistantId) || typeof enabled !== "boolean")
    throw new BillingError("Choose a valid assistant and availability.", 400);
  if (enabled && !phoneProvisioningReady(env))
    throw new BillingError("Phone calls are not enabled yet.", 409);
  const order = await env.DB.prepare(
    "SELECT phone_number,connection_id FROM commercial_phone_orders WHERE id=? AND business_id=? AND state='active'",
  )
    .bind(id, businessId)
    .first<{ phone_number: string; connection_id: string }>();
  if (!order) throw new BillingError("This number is not active yet.", 409);
  const statements = [
    env.DB.prepare(
      `INSERT INTO telnyx_number_routes(connection_id,phone_number,business_id,assistant_id,enabled)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM assistants WHERE id=? AND business_id=?)
      AND EXISTS(SELECT 1 FROM commercial_phone_orders WHERE id=? AND business_id=? AND state='active' AND provider_number_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)
      ON CONFLICT(connection_id,phone_number) DO UPDATE SET assistant_id=excluded.assistant_id,enabled=excluded.enabled
      WHERE telnyx_number_routes.business_id=excluded.business_id`,
    ).bind(
      order.connection_id,
      order.phone_number,
      businessId,
      assistantId,
      enabled ? 1 : 0,
      assistantId,
      businessId,
      id,
      businessId,
      businessId,
    ),
    env.DB.prepare(
      "UPDATE commercial_phone_orders SET assistant_id=? WHERE id=? AND business_id=? AND EXISTS(SELECT 1 FROM telnyx_number_routes WHERE connection_id=? AND phone_number=? AND business_id=? AND assistant_id=?)",
    ).bind(
      assistantId,
      id,
      businessId,
      order.connection_id,
      order.phone_number,
      businessId,
      assistantId,
    ),
  ];
  const result = await env.DB.batch(statements);
  if (!result[0].meta.changes || !result[1].meta.changes)
    throw new BillingError("The number could not be updated.", 409);
  return { saved: true };
}
/** Only confirmed, owned rentals can be released. Uncertainty retains their mappings. */
export async function releaseBusinessPhones(
  env: CommercialEnv,
  businessId: string,
) {
  const { results: orders } = await env.DB.prepare(
    "SELECT id,state,phone_number,provider_number_id,connection_id FROM commercial_phone_orders WHERE business_id=? AND state NOT IN ('released','failed')",
  )
    .bind(businessId)
    .all<{
      id: string;
      state: string;
      phone_number: string;
      provider_number_id: string | null;
      connection_id: string;
    }>();
  for (const order of orders) {
    if (!providerId(order.provider_number_id)) {
      // Read-only carrier reconciliation must remain usable after deletion reserves
      // the account; it records cleanup identity without creating a usable route.
      await reconcilePhoneOrder(env, businessId, order.id);
      const refreshed = await env.DB.prepare(
        "SELECT provider_number_id,state FROM commercial_phone_orders WHERE id=? AND business_id=?",
      )
        .bind(order.id, businessId)
        .first<{ provider_number_id: string | null; state: string }>();
      if (refreshed?.state === "failed" || refreshed?.state === "released")
        continue;
      order.provider_number_id = refreshed?.provider_number_id ?? null;
    }
    if (!providerId(order.provider_number_id) || !order.connection_id)
      throw new BillingError(
        "Your pending phone order needs reconciliation before deletion. Please contact support.",
        409,
      );
    const current = await phoneRequest(
      env,
      "/phone_numbers/" + order.provider_number_id,
    );
    if (
      current &&
      (current.data?.phone_number !== order.phone_number ||
        current.data?.connection_id !== order.connection_id)
    )
      throw new BillingError(
        "Phone ownership needs verification before deletion.",
        409,
      );
    await env.DB.prepare(
      "UPDATE telnyx_number_routes SET enabled=0 WHERE business_id=? AND connection_id=? AND phone_number=?",
    )
      .bind(businessId, order.connection_id, order.phone_number)
      .run();
    if (current)
      await phoneRequest(
        env,
        "/phone_numbers/" + order.provider_number_id,
        "DELETE",
      );
    if (await phoneRequest(env, "/phone_numbers/" + order.provider_number_id))
      throw new BillingError(
        "Phone release is pending. Please retry deletion.",
        409,
      );
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM telnyx_number_routes WHERE business_id=? AND connection_id=? AND phone_number=?",
      ).bind(businessId, order.connection_id, order.phone_number),
      env.DB.prepare(
        "UPDATE commercial_phone_orders SET state='released' WHERE id=? AND business_id=?",
      ).bind(order.id, businessId),
    ]);
  }
}

/** Carrier completion is verified separately from accepting an order. */
export async function reconcilePhoneOrder(
  env: CommercialEnv,
  businessId: string,
  id: string,
) {
  const order = await env.DB.prepare(
    "SELECT * FROM commercial_phone_orders WHERE id=? AND business_id=?",
  )
    .bind(id, businessId)
    .first<any>();
  if (!order) throw new BillingError("Number order not found.", 400);
  if (["released", "failed", "active"].includes(order.state))
    return { id, status: order.state };
  if (!providerId(order.provider_order_id)) {
    // A lost POST response must be recovered by the durable customer reference,
    // never by buying again. Reject incomplete or ambiguous filtered listings.
    const query = new URLSearchParams({
      "filter[customer_reference]": id,
      "page[number]": "1",
      "page[size]": "2",
    });
    const discovered = await phoneRequest(env, "/number_orders?" + query);
    const candidate = discovered?.data?.[0];
    if (
      !Array.isArray(discovered?.data) ||
      discovered.data.length !== 1 ||
      discovered.meta?.total_results !== 1 ||
      discovered.meta?.total_pages !== 1 ||
      discovered.meta?.page_number !== 1 ||
      !providerId(candidate?.id) ||
      candidate.customer_reference !== id ||
      candidate.connection_id !== order.connection_id ||
      candidate.phone_numbers_count !== 1 ||
      !Array.isArray(candidate.phone_numbers) ||
      candidate.phone_numbers.length !== 1 ||
      candidate.phone_numbers[0]?.phone_number !== order.phone_number
    )
      throw new BillingError(
        "This number order needs support to reconcile. It will not be purchased again.",
        409,
      );
    await env.DB.prepare(
      "UPDATE commercial_phone_orders SET provider_order_id=?,state='review' WHERE id=? AND business_id=? AND provider_order_id IS NULL AND state IN ('pending','review')",
    )
      .bind(candidate.id, id, businessId)
      .run();
    const stored = await env.DB.prepare(
      "SELECT provider_order_id FROM commercial_phone_orders WHERE id=? AND business_id=?",
    )
      .bind(id, businessId)
      .first<{ provider_order_id: string | null }>();
    if (stored?.provider_order_id !== candidate.id)
      throw new BillingError(
        "Number order identity changed. Please contact support.",
        409,
      );
    order.provider_order_id = candidate.id;
  }
  const remote = await phoneRequest(
    env,
    "/number_orders/" + order.provider_order_id,
  );
  if (
    !remote?.data ||
    remote.data.id !== order.provider_order_id ||
    remote.data.customer_reference !== id
  )
    throw new BillingError("The number order could not be verified.", 409);
  if (remote.data.status === "failure") {
    if (order.provider_number_id) return { id, status: "review" };
    const query = new URLSearchParams({
      "filter[phone_number]": order.phone_number,
      "page[number]": "1",
      "page[size]": "100",
    });
    const inventory = await phoneRequest(env, "/phone_numbers?" + query);
    if (
      !Array.isArray(inventory?.data) ||
      inventory.meta?.page_number !== 1 ||
      !Number.isInteger(inventory.meta?.total_results) ||
      inventory.meta.total_results !== inventory.data.length ||
      !Number.isInteger(inventory.meta?.total_pages) ||
      inventory.meta.total_pages > 1 ||
      inventory.data.some(
        (number: any) => number.phone_number === order.phone_number,
      )
    )
      throw new BillingError(
        "The unsuccessful order still needs rental reconciliation. Please contact support.",
        409,
      );
    await env.DB.prepare(
      `UPDATE commercial_phone_orders SET state='failed' WHERE id=? AND business_id=?
      AND provider_order_id=? AND provider_number_id IS NULL AND state IN ('pending','review')
      AND NOT EXISTS(SELECT 1 FROM telnyx_number_routes WHERE business_id=? AND phone_number=?)`,
    )
      .bind(
        id,
        businessId,
        order.provider_order_id,
        businessId,
        order.phone_number,
      )
      .run();
    const failed = await env.DB.prepare(
      "SELECT state FROM commercial_phone_orders WHERE id=? AND business_id=?",
    )
      .bind(id, businessId)
      .first<{ state: string }>();
    if (failed?.state !== "failed")
      throw new BillingError(
        "The unsuccessful order still needs reconciliation.",
        409,
      );
    return { id, status: "failed" };
  }
  if (remote.data.status !== "success") return { id, status: "review" };
  const query = new URLSearchParams({
    "filter[phone_number]": order.phone_number,
    "page[size]": "100",
  });
  const list = await phoneRequest(env, "/phone_numbers?" + query);
  const matches = Array.isArray(list?.data)
    ? list.data.filter(
        (p: any) =>
          p.phone_number === order.phone_number &&
          p.connection_id === order.connection_id &&
          p.status === "active",
      )
    : [];
  if (matches.length !== 1 || !providerId(matches[0].id))
    throw new BillingError("Phone activation is still being checked.", 409);
  // The route starts disabled; testing and publication remain separate actions.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO telnyx_number_routes(connection_id,phone_number,business_id,assistant_id,enabled)
    SELECT ?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)
    AND EXISTS(SELECT 1 FROM assistants WHERE id=? AND business_id=?)
    ON CONFLICT(connection_id,phone_number) DO NOTHING`,
    ).bind(
      order.connection_id,
      order.phone_number,
      businessId,
      order.assistant_id,
      businessId,
      order.assistant_id,
      businessId,
    ),
    env.DB.prepare(
      `UPDATE commercial_phone_orders SET provider_number_id=?,state='active' WHERE id=? AND business_id=? AND state IN ('pending','review')
    AND (EXISTS(SELECT 1 FROM telnyx_number_routes WHERE connection_id=? AND phone_number=? AND business_id=? AND assistant_id=?)
    OR EXISTS(SELECT 1 FROM commercial_deletion_jobs WHERE business_id=?)
    OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=? AND business_id=?))`,
    ).bind(
      matches[0].id,
      id,
      businessId,
      order.connection_id,
      order.phone_number,
      businessId,
      order.assistant_id,
      businessId,
      order.assistant_id,
      businessId,
    ),
  ]);
  const stored = await env.DB.prepare(
    "SELECT state FROM commercial_phone_orders WHERE id=? AND business_id=?",
  )
    .bind(id, businessId)
    .first<{ state: string }>();
  if (stored?.state !== "active")
    throw new BillingError(
      "This number cannot be assigned. Please contact support.",
      409,
    );
  return { id, status: "active" };
}
