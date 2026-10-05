/** Public recordings contain audio, never an operator's configuration or events. */
export function customerRecording(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set(
    "content-disposition",
    'attachment; filename="openfon-recording.ndjson"',
  );
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const project = (line: string): string => {
    if (!line) return "";
    const row = JSON.parse(line) as Record<string, unknown>;
    let keys: string[];
    if (row.kind === "manifest")
      keys = [
        "kind",
        "version",
        "callId",
        "startedAt",
        "finishedAt",
        "expiresAt",
        "partial",
        "interrupted",
      ];
    else if (row.kind === "audio")
      keys = [
        "kind",
        "seq",
        "ms",
        "track",
        "format",
        "frame",
        "offset",
        "total",
        "data",
      ];
    else if (row.kind === "end") keys = ["kind"];
    else return "";
    return (
      JSON.stringify(
        Object.fromEntries(
          keys.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]]),
        ),
      ) + "\n"
    );
  };
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (newline > 100_000)
            throw new Error("Recording entry exceeds the export limit.");
          const safe = project(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (safe) controller.enqueue(encoder.encode(safe));
        }
        if (pending.length > 100_000)
          throw new Error("Recording entry exceeds the export limit.");
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(project(pending)));
      },
    }),
  );
  return new Response(stream, { status: response.status, headers });
}
