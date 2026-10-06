/** Operator-only evidence. Never includes arbitrary provider messages, response bodies or caller text. */
export type ProcessingStage =
  | "configuration"
  | "input"
  | "request"
  | "response_status"
  | "response_body"
  | "response_parse"
  | "response_identity"
  | "transcript_read"
  | "cache_write";
export interface ProcessingDiagnostic {
  stage: ProcessingStage;
  elapsedMs?: number;
  inputTurns?: number;
  inputCharacters?: number;
  httpStatus?: number;
  requestIdHash?: string;
  providerCode?: string;
  providerCodeHash?: string;
  parameter?: string;
  parameterHash?: string;
  failure?: "timeout" | "network";
}
export class ManagedProcessingError extends Error {
  constructor(readonly diagnostic: ProcessingDiagnostic) {
    super("Call notes could not be prepared.");
  }
}
export function processingDiagnostic(
  error: unknown,
  stage: ProcessingStage,
  started?: number,
): ProcessingDiagnostic {
  if (error instanceof ManagedProcessingError) return { ...error.diagnostic };
  return {
    stage,
    ...(started !== undefined
      ? { elapsedMs: Math.min(86400000, Math.max(0, Date.now() - started)) }
      : {}),
    ...(error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
      ? { failure: "timeout" as const }
      : {}),
  };
}
const knownCodes = new Set([
  "invalid_request_error",
  "unsupported_parameter",
  "unsupported_value",
  "invalid_value",
  "model_not_found",
  "deployment_not_found",
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "content_filter",
  "context_length_exceeded",
  "authentication_error",
  "permission_denied",
]);
const knownParameters = new Set([
  "model",
  "store",
  "max_output_tokens",
  "reasoning",
  "reasoning.effort",
  "text",
  "text.format",
  "text.format.type",
  "input",
  "instructions",
]);
async function hash(value: unknown): Promise<string | undefined> {
  if (typeof value !== "string" || !value.length || value.length > 200) return;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
export async function requestProvenance(
  response: Response,
  diagnostic: ProcessingDiagnostic,
): Promise<void> {
  diagnostic.httpStatus = response.status;
  diagnostic.requestIdHash = await hash(
    response.headers.get("apim-request-id") ||
      response.headers.get("x-request-id") ||
      response.headers.get("x-ms-request-id"),
  );
}
/** At most 8 KiB and one second, then cancel without allowing a held cancel to block finalization. */
export async function rejectedResponseDiagnostic(
  response: Response,
  diagnostic: ProcessingDiagnostic,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      (async () => {
        let text = "",
          bytes = 0;
        const decoder = new TextDecoder();
        for (;;) {
          const p = await reader.read();
          if (p.done) return text + decoder.decode();
          if ((bytes += p.value.byteLength) > 8192) throw Error("limit");
          text += decoder.decode(p.value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("deadline")), 1000);
      }),
    ]);
    const parsed = JSON.parse(content);
    const error = parsed?.error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return;
    if (knownCodes.has(error.code)) diagnostic.providerCode = error.code;
    else diagnostic.providerCodeHash = await hash(error.code);
    if (knownParameters.has(error.param)) diagnostic.parameter = error.param;
    else diagnostic.parameterHash = await hash(error.param);
  } catch {
    /* A missing diagnostic never changes the original rejected outcome. */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
