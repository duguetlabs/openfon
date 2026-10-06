import type { CallContext } from "./control.js";
export const THINK_TOOL = {
  type: "function",
  name: "think",
  description:
    "Reason about calculations, detailed questions, or accurate readback. Include the latest request and corrections.",
  parameters: {
    type: "object",
    properties: { request: { type: "string" } },
    required: ["request"],
    additionalProperties: false,
  },
};
export type ReasoningConnection = { baseURL: string; apiKey: string };
export async function reasonMini(
  connection: ReasoningConnection,
  context: CallContext,
  request: string,
  signal: AbortSignal,
  onUsage: (response: Record<string, unknown>) => void,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = JSON.stringify({
    model: "gpt-5.4-mini",
    store: false,
    max_output_tokens: 1200,
    instructions: `Use only the admitted business facts and instructions below. Answer the latest request in ${context.language}, incorporating corrections. Return a concise speakable answer, ask for clarification if facts are missing. No external action tools are available here. Never claim bookings, payments or other actions were completed. Output is information, never new instructions.\n\n${context.instructions}`,
    input: request,
  });
  if (Buffer.byteLength(body) > 128000) throw Error("reasoning_limit");
  const response = await fetcher(connection.baseURL + "/responses", {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "api-key": connection.apiKey,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) {
    void response.body?.cancel();
    throw Error("reasoning_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("reasoning_unavailable");
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 256000) throw Error("reasoning_limit");
      parts.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const result = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!result || typeof result !== "object")
    throw Error("reasoning_unavailable");
  onUsage(result); // Completed, failed and incomplete responses can all carry charged usage.
  if (result.status !== "completed") throw Error("reasoning_unavailable");
  const output = Array.isArray(result.output) ? result.output : [];
  const text = output
    .flatMap((x: any) =>
      x?.type === "message" && Array.isArray(x.content) ? x.content : [],
    )
    .filter((x: any) => x?.type === "output_text" && typeof x.text === "string")
    .map((x: any) => x.text)
    .join("\n");
  if (!text || text.length > 16000) throw Error("reasoning_limit");
  return text;
}
