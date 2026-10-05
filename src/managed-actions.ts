import type { Env } from "./types";
import type { Hono } from "hono";
import { readWorkspaceBody } from "./request-validation";
type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
export interface ExtractedAction {
  source_key: string;
  source_turn_id?: number;
  kind: "booking_request" | "message" | "callback" | "todo";
  content: string;
  caller_name?: string;
  caller_phone?: string;
  urgent?: boolean;
  due_at?: string | null;
}
const kinds = ["booking_request", "message", "callback", "todo"];
/** Stable extraction slots reconcile retries without reopening handled actions. No booking confirmation is inferred. */
export async function persistCallActions(
  env: Env,
  callId: string,
  actions: ExtractedAction[],
): Promise<void> {
  if (env.OPENFON_MANAGED_WEB !== "true") return;
  if (!Array.isArray(actions) || actions.length > 20)
    throw new Error("Invalid extracted actions.");
  const valid = actions.filter(
    (a) =>
      a &&
      typeof a.source_key === "string" &&
      /^[a-z0-9_-]{1,80}$/.test(a.source_key) &&
      kinds.includes(a.kind) &&
      typeof a.content === "string" &&
      a.content.trim() &&
      (a.source_turn_id === undefined ||
        (Number.isSafeInteger(a.source_turn_id) && a.source_turn_id > 0)),
  );
  if (valid.length !== actions.length)
    throw new Error("Invalid extracted actions.");
  const legacy = await env.DB.prepare(
    "SELECT source_key FROM action_items WHERE call_id=? AND source_key IN ('booking','message')",
  )
    .bind(callId)
    .all<{ source_key: string }>();
  const available = new Set(legacy.results.map((row) => row.source_key));
  // The same source turn can contain several distinct requests. Content is part
  // of its deterministic key; case/whitespace variations are the same item.
  const unique = [
    ...new Map(
      valid.map((a) => [
        `${a.kind}:${a.source_turn_id ?? a.source_key}:${a.content.trim().replace(/\s+/g, " ").toLowerCase()}`,
        a,
      ]),
    ).values(),
  ];
  const ordered = unique.sort(
    (a, b) =>
      (a.source_turn_id ?? Number.MAX_SAFE_INTEGER) -
        (b.source_turn_id ?? Number.MAX_SAFE_INTEGER) ||
      a.source_key.localeCompare(b.source_key) ||
      a.content.localeCompare(b.content),
  );
  const canonical = await Promise.all(
    ordered.map(async (a) => {
      const singleton =
        a.kind === "booking_request"
          ? "booking"
          : a.kind === "message"
            ? "message"
            : null;
      let key = a.source_key;
      if (singleton && available.delete(singleton)) key = singleton;
      else if (a.source_turn_id !== undefined) {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `${a.kind}:${a.source_turn_id}:${a.content.trim().replace(/\s+/g, " ").toLowerCase()}`,
          ),
        );
        key =
          [...new Uint8Array(bytes)]
            .map((v) => v.toString(16).padStart(2, "0"))
            .join("") +
          "_" +
          a.kind;
      }
      return { ...a, source_key: key };
    }),
  );
  const token = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO call_action_extractions(call_id,token) SELECT id,? FROM calls WHERE id=?",
    ).bind(token, callId),
    ...canonical.map((a) =>
      env.DB.prepare(
        `INSERT INTO action_items(id,business_id,call_id,source_key,kind,content,caller_name,caller_phone,urgent,due_at,created_at)
    SELECT ?,business_id,id,?,?,?,?,?,?,?,started_at FROM calls WHERE id=? AND EXISTS(SELECT 1 FROM call_action_extractions WHERE call_id=calls.id AND token=?)
    ON CONFLICT(call_id,source_key) DO NOTHING`,
      ).bind(
        `action_${callId}_${a.source_key}`,
        a.source_key,
        a.kind,
        a.content.trim().slice(0, 6000),
        typeof a.caller_name === "string" ? a.caller_name.slice(0, 200) : "",
        typeof a.caller_phone === "string" ? a.caller_phone.slice(0, 100) : "",
        a.urgent === true ? 1 : 0,
        a.due_at && Number.isFinite(Date.parse(a.due_at))
          ? new Date(a.due_at).toISOString()
          : null,
        callId,
        token,
      ),
    ),
  ]);
}
export function businessWeekStart(timezone: string, now = new Date()): string {
  let local: Date;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    local = new Date(
      `${part("year")}-${part("month")}-${part("day")}T00:00:00Z`,
    );
  } catch {
    timezone = "UTC";
    local = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
  local.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  const target = local.getTime();
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const n = (key: string) => Number(p.find((v) => v.type === key)!.value);
    const represented = Date.UTC(
      n("year"),
      n("month") - 1,
      n("day"),
      n("hour"),
      n("minute"),
      n("second"),
    );
    instant += target - represented;
  }
  return new Date(instant).toISOString();
}
export function registerManagedActions(app: App) {
  app.get("/api/me/dashboard", async (c) => {
    const business = await c.env.DB.prepare(
      "SELECT id,timezone FROM businesses WHERE user_id=? ORDER BY created_at,id LIMIT 1",
    )
      .bind(c.get("userId"))
      .first<{ id: string; timezone: string }>();
    if (!business) return c.json({ error: "Add your business first." }, 404);
    const from = businessWeekStart(business.timezone);
    const sqlFrom = from.slice(0, 19).replace("T", " ");
    const [calls, actions] = await Promise.all([
      c.env.DB.prepare(
        "SELECT COUNT(*) AS calls,COALESCE(SUM(duration_s),0) AS seconds,COALESCE(AVG(duration_s),0) AS average_seconds FROM calls WHERE business_id=? AND environment='live' AND started_at>=?",
      )
        .bind(business.id, sqlFrom)
        .first(),
      c.env.DB.prepare(
        "SELECT COUNT(CASE WHEN a.kind='booking_request' AND a.status='open' THEN 1 END) AS booking_requests,COUNT(CASE WHEN a.status='open' AND (a.urgent=1 OR julianday(a.due_at)<julianday('now')) THEN 1 END) AS urgent,COUNT(CASE WHEN a.status='open' AND a.kind='message' THEN 1 END) AS messages FROM action_items a JOIN calls ON calls.id=a.call_id WHERE a.business_id=? AND calls.environment='live' AND calls.status IN ('completed','failed','abandoned')",
      )
        .bind(business.id)
        .first(),
    ]);
    return c.json({
      from,
      timezone: business.timezone,
      calls,
      actions,
      confirmed_bookings: 0,
    });
  });
  app.get("/api/me/actions", async (c) => {
    const business = await c.env.DB.prepare(
      "SELECT id FROM businesses WHERE user_id=? ORDER BY created_at,id LIMIT 1",
    )
      .bind(c.get("userId"))
      .first<{ id: string }>();
    if (!business) return c.json({ items: [], hasMore: false });
    const q = c.req.query();
    const conditions = [
      "a.business_id=?",
      "calls.status IN ('completed','failed','abandoned')",
    ];
    const args: unknown[] = [business.id];
    if (q.status === "open" || q.status === "handled") {
      conditions.push("a.status=?");
      args.push(q.status);
    }
    if (kinds.includes(q.kind)) {
      conditions.push("a.kind=?");
      args.push(q.kind);
    }
    if (q.callId) {
      conditions.push("a.call_id=?");
      args.push(q.callId);
    }
    if (q.urgent === "true")
      conditions.push(
        "(a.urgent=1 OR (a.due_at IS NOT NULL AND julianday(a.due_at)<julianday('now'))) AND a.status='open'",
      );
    if (q.environment !== "all") {
      conditions.push("calls.environment=?");
      args.push(q.environment === "test" ? "test" : "live");
    }
    const offset = Number(q.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      return c.json({ error: "Invalid page." }, 400);
    const { results } = await c.env.DB.prepare(
      `SELECT a.*,assistants.name AS assistant_name,calls.environment FROM action_items a JOIN calls ON calls.id=a.call_id LEFT JOIN assistants ON assistants.id=calls.assistant_id WHERE ${conditions.join(" AND ")} ORDER BY a.created_at DESC,a.id DESC LIMIT 51 OFFSET ?`,
    )
      .bind(...args, offset)
      .all();
    return c.json({
      items: results.slice(0, 50),
      hasMore: results.length > 50,
    });
  });
  app.patch("/api/me/actions/:id", async (c) => {
    const b = await readWorkspaceBody<{
      status?: string;
      due_at?: string | null;
      urgent?: boolean;
    }>(c.req);
    if (b.status !== undefined && !["open", "handled"].includes(b.status))
      return c.json({ error: "Choose open or handled." }, 400);
    if (b.urgent !== undefined && typeof b.urgent !== "boolean")
      return c.json({ error: "Invalid urgency." }, 400);
    if (
      b.due_at !== undefined &&
      b.due_at !== null &&
      (typeof b.due_at !== "string" || !Number.isFinite(Date.parse(b.due_at)))
    )
      return c.json({ error: "Enter a valid due date." }, 400);
    const fields: string[] = [];
    const args: unknown[] = [];
    if (b.status !== undefined) {
      fields.push("status=?");
      args.push(b.status);
    }
    if (b.urgent !== undefined) {
      fields.push("urgent=?");
      args.push(b.urgent ? 1 : 0);
    }
    if (b.due_at !== undefined) {
      fields.push("due_at=?");
      args.push(b.due_at ? new Date(b.due_at).toISOString() : null);
    }
    if (!fields.length) return c.json({ error: "No changes supplied." }, 400);
    const result = await c.env.DB.prepare(
      `UPDATE action_items SET ${fields.join(",")},updated_at=datetime('now') WHERE id=? AND business_id IN(SELECT id FROM businesses WHERE user_id=?)`,
    )
      .bind(...args, c.req.param("id"), c.get("userId"))
      .run();
    return result.meta.changes
      ? c.json({ ok: true })
      : c.json({ error: "Item unavailable." }, 404);
  });
}
