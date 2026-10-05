import { describe, it, expect } from "vitest";
import { customerRecording } from "../src/customer-recording";

describe("customer recording export", () => {
  it("keeps historical audio and retention facts while dropping operator settings and protocol events", async () => {
    const source = [
      { kind: "manifest", callId: "owned", partial: true, provider: "private" },
      { kind: "config", model: "private", credential: "private" },
      {
        kind: "audio",
        track: "microphone",
        format: "pcm_s16le_24000",
        data: "AA==",
        seq: 1,
        ms: 2,
        model: "private",
      },
      { kind: "caller_event", text: "Private protocol event" },
      { kind: "end", chunks: 5 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const result = customerRecording(new Response(source));
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(
      (await result.text())
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
    ).toEqual([
      { kind: "manifest", callId: "owned", partial: true },
      {
        kind: "audio",
        seq: 1,
        ms: 2,
        track: "microphone",
        format: "pcm_s16le_24000",
        data: "AA==",
      },
      { kind: "end" },
    ]);
  });
  it("handles split records without buffering the complete recording", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        for (const part of [
          '{"kind":"au',
          'dio","data":"AA=="}\n{"kind":"config","model":"secret"}\n',
          '{"kind":"end"}',
        ])
          c.enqueue(new TextEncoder().encode(part));
        c.close();
      },
    });
    expect(await customerRecording(new Response(source)).text()).toBe(
      '{"kind":"audio","data":"AA=="}\n{"kind":"end"}\n',
    );
  });
  it("fails closed on oversized or malformed entries", async () => {
    await expect(
      customerRecording(new Response("a".repeat(100001))).text(),
    ).rejects.toThrow("export limit");
    await expect(
      customerRecording(new Response("not json\n")).text(),
    ).rejects.toThrow();
  });
});
