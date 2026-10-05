import type { Hono } from "hono";
import type { Env } from "./types";
type App = Hono<{ Bindings: Env; Variables: { userId: string } }>;
const technical = new Set([
  "engine",
  "realtime_model",
  "realtime_voice",
  "llm_model",
  "llm_base_url",
  "llm_api_key",
  "stt_provider",
  "stt_model",
  "stt_base_url",
  "stt_api_key",
  "tts_provider",
  "tts_model",
  "tts_base_url",
  "tts_api_key",
  "realtime_provider",
  "realtime_base_url",
  "realtime_api_key",
]);
const restricted =
  /^\/api\/me\/(?:provider(?:s|-catalog)?|engine-presets|profiles|summary-settings|call-summaries|business\/[^/]+\/(?:agent|profiles|engine-profiles))(?:\/|$)/;
const assistantFields = [
  "id",
  "business_id",
  "public_slug",
  "state",
  "name",
  "greeting",
  "persona",
  "language",
  "voice",
  "take_messages",
  "custom_instructions",
  "created_at",
  "updated_at",
  "activated_at",
  "collectionIds",
  "essentials_ready",
  "last_live_call_at",
  "last_test_at",
];
const workspaceFields = [
  "id",
  "user_id",
  "slug",
  "name",
  "description",
  "address",
  "phone",
  "website",
  "timezone",
  "hours_json",
  "services_json",
  "faqs_json",
  "closures_json",
  "contact_email",
  "default_language",
  "shared_instructions",
];
const callFields = [
  "id",
  "business_id",
  "assistant_id",
  "assistant_name",
  "assistant_slug",
  "channel",
  "caller_id",
  "environment",
  "direction",
  "status",
  "started_at",
  "ended_at",
  "connected_at",
  "duration_s",
  "summary",
  "intent",
  "message_json",
  "outcome",
  "unanswered_json",
  "turns",
];
const diagnosticWords =
  /provider|model|engine|api.?key|endpoint|kataleptic|azure|openai|livekit|credential|https?:\/\//i;
function pick(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key]]),
  );
}
function assistant(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const out = pick(value, assistantFields);
  if ("realtime_voice" in original)
    out.voice = original.realtime_voice || original.voice || "";
  // Installed iOS 1.0.0 requires these Codable keys. Empty compatibility values
  // reveal no routing configuration; its selectedVoice then uses `voice`.
  if ("greeting" in original) {
    out.engine = "";
    out.realtime_voice = "";
  }
  return out;
}
export function customerCall(value: unknown): Record<string, unknown> {
  const original = value as Record<string, unknown>;
  const out = pick(value, callFields);
  if (out.channel === "telnyx") out.channel = "phone";
  if (out.channel === "asterisk") out.channel = "business_phone";
  out.failure_code = null;
  out.failure_message = original.failure_message
    ? "The call could not complete. Please try again."
    : null;
  if (
    original.status === "failed" &&
    typeof original.summary === "string" &&
    diagnosticWords.test(original.summary)
  )
    out.summary =
      "The call could not complete. Review its transcript for any captured conversation.";
  return out;
}
function customerError(value: unknown, status: number): string {
  const message = typeof value === "string" ? value : "";
  if (message && !diagnosticWords.test(message) && message.length <= 600)
    return message;
  return status === 409
    ? "The saved details changed. Refresh and try again."
    : "This action could not complete. Please try again.";
}
/** Operator-controlled customer boundary. Saved routing remains private. */
export function registerManagedWebBoundary(app: App) {
  for (const path of ["/api/public/*", "/ws/call/*"])
    app.use(path, async (c, next) => {
      await next();
      if (
        c.env.OPENFON_MANAGED_WEB !== "true" ||
        c.res.ok ||
        !c.res.headers.get("content-type")?.includes("application/json")
      )
        return;
      const data = (await c.res
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(
        JSON.stringify({ error: customerError(data?.error, c.res.status) }),
        { status: c.res.status, headers },
      );
    });
  app.use("/api/me/*", async (c, next) => {
    if (c.env.OPENFON_MANAGED_WEB !== "true") return next();
    const path = c.req.path;
    if (restricted.test(path))
      return c.json({ error: "This setting is unavailable." }, 404);
    const assistantRoute = /^\/api\/me\/assistants(?:\/[^/]+)?$/.test(path);
    if (assistantRoute && ["POST", "PUT"].includes(c.req.method)) {
      const body = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      if (
        body &&
        typeof body === "object" &&
        Object.keys(body).some((key) => technical.has(key))
      )
        return c.json(
          { error: "Only assistant details can be changed here." },
          400,
        );
    }
    await next();
    if (!c.res.headers.get("content-type")?.includes("application/json"))
      return;
    const data = (await c.res.clone().json()) as Record<string, unknown> | null;
    let output: unknown = data;
    if (!c.res.ok) {
      console.warn("managed_customer_error", { path, status: c.res.status });
      output = { error: customerError(data?.error, c.res.status) };
    } else if (data) {
      if (assistantRoute && c.req.method !== "DELETE")
        output = Array.isArray(data) ? data.map(assistant) : assistant(data);
      if (path === "/api/me/business") {
        output = {
          ...pick(data, workspaceFields),
          ...("agent" in data ? { agent: assistant(data.agent) } : {}),
        };
      }
      if (path === "/api/me/bootstrap")
        output = {
          account: pick(data.account, ["id", "email", "created_at"]),
          workspace: data.workspace
            ? pick(data.workspace, workspaceFields)
            : null,
          assistants: Array.isArray(data.assistants)
            ? data.assistants.map(assistant)
            : [],
          setup: pick(data.setup, [
            "account",
            "workspace",
            "firstAssistant",
            "firstTest",
          ]),
          readiness: pick(data.readiness, ["liveAssistantCount"]),
        };
      if (path === "/api/me/calls")
        output = {
          items: Array.isArray(data.items) ? data.items.map(customerCall) : [],
          nextCursor: data.nextCursor ?? null,
        };
      if (/^\/api\/me\/calls\/[^/]+$/.test(path)) output = customerCall(data);
      if (
        /^\/api\/me\/business\/[^/]+\/calls$/.test(path) &&
        Array.isArray(data)
      )
        output = data.map(customerCall);
      if (path === "/api/me/overview")
        output = {
          ...data,
          recentCalls: Array.isArray(data.recentCalls)
            ? data.recentCalls.map(customerCall)
            : [],
        };
    }
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(output), {
      status: c.res.status,
      headers,
    });
  });
}
