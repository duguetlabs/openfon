import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureUsageCapture, type UsageObservation } from "../src/usage.js";
import { UsageOutbox } from "../src/usage-outbox.js";
const started = (id = "s1") => ({
  type: "session.updated",
  session: {
    id,
    audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } },
  },
});
const completed = {
  type: "conversation.item.input_audio_transcription.completed",
  item_id: "item1",
  content_index: 0,
  transcript: "synthetic-private-transcript",
  usage: {
    type: "tokens",
    input_tokens: 15,
    input_token_details: { audio_tokens: 12, text_tokens: 3 },
    output_tokens: 4,
    total_tokens: 19,
  },
};
const setup = () => {
  const observations: UsageObservation[] = [];
  const capture = new AzureUsageCapture(
    "call",
    "job",
    async (o) => {
      observations.push(o);
    },
    () => assert.fail("Usage delivery should succeed"),
    true,
  );
  capture.observe(started());
  return { capture, observations };
};
test("ASR final usage preserves session/item/content/model ownership and deduplicates separately from conversation responses", async () => {
  const { capture, observations } = setup();
  capture.observe(completed);
  capture.observe({ ...completed, event_id: "different_provider_event" });
  capture.observe({ ...completed, item_id: "item2" });
  capture.observe({ ...completed, content_index: 1 });
  capture.observe({
    type: "response.done",
    response: {
      id: "item1",
      status: "completed",
      usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
    },
  });
  capture.observe(started("s2"));
  capture.observe(completed);
  await capture.flush();
  const asr = observations.filter((x) => x.source === "azure_transcription");
  assert.equal(asr.length, 4);
  assert.equal(asr[0].model, "gpt-4o-mini-transcribe");
  assert.equal(asr[0].providerItemId, "item1");
  assert.equal(asr[0].providerContentIndex, 0);
  assert.equal(asr[0].providerResponseId, undefined);
  assert.equal(asr[3].providerSessionId, "s2");
  assert.equal(asr[0].callId, "call");
  assert.equal(asr[0].jobId, "job");
  assert.equal(asr[0].final, true);
  assert.deepEqual(asr[0].metrics, {
    inputTokens: 15,
    outputTokens: 4,
    totalTokens: 19,
    inputAudioTokens: 12,
    inputTextTokens: 3,
  });
  assert.equal(
    observations.find((x) => x.source === "azure_realtime")?.metrics
      .totalTokens,
    60,
  );
  assert.ok(
    !JSON.stringify(observations).includes("synthetic-private-transcript"),
  );
});
test("missing or failed ASR usage remains unknown; duration uses a separate precise unit", async () => {
  const { capture, observations } = setup();
  capture.observe({ ...completed, usage: undefined });
  capture.observe({
    ...completed,
    item_id: "failed",
    type: "conversation.item.input_audio_transcription.failed",
    usage: undefined,
  });
  capture.observe({
    ...completed,
    item_id: "duration",
    usage: { type: "duration", seconds: 1.125000001 },
  });
  capture.observe({
    ...completed,
    item_id: "invalid",
    usage: {
      type: "tokens",
      input_tokens: -1,
      output_tokens: Infinity,
      total_tokens: "8",
    },
  });
  await capture.flush();
  assert.deepEqual(observations[0].metrics, {});
  assert.deepEqual(observations[1].metrics, {});
  assert.deepEqual(observations[2].metrics, {
    transcriptionSeconds: "1.125000001",
  });
  assert.deepEqual(observations[3].metrics, {});
});
test("ASR capture requires a current Mini session and valid provider item/content identities", async () => {
  const observations: UsageObservation[] = [];
  const legacy = new AzureUsageCapture(
    "call",
    "job",
    async (o) => {
      observations.push(o);
    },
    () => assert.fail(),
  );
  legacy.observe({ type: "session.started", session: { id: "legacy" } });
  legacy.observe(completed);
  await legacy.flush();
  assert.equal(observations.length, 0);
  const { capture, observations: mini } = setup();
  for (const override of [
    { item_id: "" },
    { content_index: -1 },
    { content_index: 1.5 },
    { content_index: 1025 },
  ])
    capture.observe({ ...completed, ...override });
  await capture.flush();
  assert.equal(mini.length, 0);
});
test("ASR observations survive the existing durable outbox unchanged without transcript storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openfon-asr-usage-"));
  try {
    const outbox = new UsageOutbox(
      dir,
      "https://synthetic.example",
      "synthetic-key",
      async () => {
        throw Error("synthetic offline");
      },
    );
    const capture = new AzureUsageCapture(
      "call",
      "job",
      (o) =>
        outbox.send({
          callId: "call",
          jobId: "job",
          room: "room",
          callback: "synthetic-callback",
          observation: o,
        }),
      () => {},
      true,
    );
    capture.observe(started());
    capture.observe(completed);
    await assert.rejects(capture.flush());
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
    assert.equal(names.length, 1);
    const raw = await readFile(join(dir, names[0]), "utf8");
    assert.ok(!raw.includes(completed.transcript));
    const stored = JSON.parse(raw).value.observation;
    assert.equal(stored.providerItemId, "item1");
    assert.equal(stored.source, "azure_transcription");
    const received: UsageObservation[] = [];
    const replay = new UsageOutbox(
      dir,
      "https://synthetic.example",
      "synthetic-key",
      async (v) => {
        received.push(v.observation);
      },
    );
    assert.equal((await replay.replay()).sent, 1);
    assert.deepEqual(received, [stored]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
