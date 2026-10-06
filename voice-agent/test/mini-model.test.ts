import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initializeLogger, llm, voice } from "@livekit/agents";
import { AudioFrame } from "@livekit/rtc-node";
import {
  MiniModel,
  MiniSession,
  miniSessionConfig,
  MINI_MODEL,
} from "../src/mini-model.js";
import { BoundedStream } from "../src/mini-stream.js";
import { PendingTypedInput, submitTypedInput } from "../src/typed-input.js";
import { ResponseUnavailable, successfulPlayout } from "../src/playout.js";
import { AzureUsageCapture } from "../src/usage.js";
initializeLogger({ pretty: false, level: "silent" });
const tick = () => new Promise<void>((r) => setImmediate(r));
const context = {
  callId: "call",
  room: "room",
  caller: "caller",
  callback: "callback",
  instructions: "Only sell dentistry. Never invent a booking.",
  greeting: "Hallo",
  voice: "marin",
  language: "de",
};
class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  terminated = false;
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  terminate() {
    this.terminated = true;
  }
  message(s: any) {
    this.emit("message", Buffer.from(JSON.stringify(s)));
  }
}
async function fixture(reason?: any) {
  const sockets: Socket[] = [];
  const model = new MiniModel({
    baseURL: "https://unit.openai.azure.com/openai/v1",
    apiKey: "synthetic",
    context,
    reason,
    socketFactory: (url, options) => {
      assert.equal(
        url,
        "wss://unit.openai.azure.com/openai/v1/realtime?model=" + MINI_MODEL,
      );
      assert.deepEqual(options.headers, { "api-key": "synthetic" });
      const ws = new Socket();
      sockets.push(ws);
      return ws as any;
    },
  });
  const session = model.session();
  const errors: any[] = [];
  const warnings: string[] = [];
  session.on("error", (e) => errors.push(e));
  session.on("warning", (e) => warnings.push(e));
  await tick();
  const socket = sockets[0];
  socket.emit("open");
  const ready = (ws = socket, sid = "session") =>
    ws.message({
      type: "session.updated",
      session: { ...miniSessionConfig(context), id: sid },
    });
  ready();
  return { model, session, socket, sockets, ready, errors, warnings };
}
async function generation(
  f: Awaited<ReturnType<typeof fixture>>,
  rid = "response",
) {
  const promise = f.session.generateReply();
  await tick();
  const request = f.socket.sent.at(-1);
  f.socket.message({
    type: "response.created",
    response: { id: rid, metadata: request.response.metadata },
  });
  return await promise;
}
test("GA session uses selected Azure Mini, natural business prompt, transcription and bounded VAD without live dialect", async () => {
  const f = await fixture();
  try {
    const s = f.socket.sent[0];
    assert.equal(s.type, "session.update");
    assert.equal(s.session.model, MINI_MODEL);
    assert.equal(
      s.session.audio.input.transcription.model,
      "gpt-4o-mini-transcribe",
    );
    assert.equal(s.session.audio.input.turn_detection.silence_duration_ms, 550);
    assert.match(s.session.instructions, /Only sell dentistry/);
    assert.equal(s.session.tools[0].name, "think");
    f.session.pushAudio(new AudioFrame(new Int16Array(480), 24000, 1, 480));
    assert.equal(f.socket.sent.at(-1).type, "input_audio_buffer.append");
  } finally {
    await f.session.close();
  }
});
for (const status of ["failed", "incomplete", "cancelled"])
  test(`${status} response stays local, skips partial tools, continues microphone and next response`, async () => {
    let reasonCalls = 0;
    const f = await fixture(async () => {
      reasonCalls++;
      return "wrong";
    });
    try {
      const g = await generation(f);
      f.socket.message({
        type: "response.done",
        response: {
          id: g.responseId,
          status,
          status_details: { reason: "content_filter" },
          output: [
            {
              type: "function_call",
              name: "think",
              call_id: "partial",
              arguments: "{}",
            },
          ],
        },
      });
      assert.equal(reasonCalls, 0);
      assert.deepEqual(f.errors, []);
      assert.ok(f.warnings.includes("response_filtered"));
      assert.equal(f.socket.terminated, false);
      assert.equal((await g.functionStream.getReader().read()).done, true);
      f.session.pushAudio(new AudioFrame(new Int16Array(480), 24000, 1, 480));
      assert.equal(f.socket.sent.at(-1).type, "input_audio_buffer.append");
      const next = await generation(f, "next");
      assert.equal(next.responseId, "next");
    } finally {
      await f.session.close();
    }
  });
test("only matching truncate and cancel errors are nonterminal", async () => {
  const f = await fixture();
  try {
    await f.session.truncate({ messageId: "item", audioEndMs: 25 });
    const request = f.socket.sent.at(-1);
    f.socket.message({
      type: "error",
      error: { event_id: request.event_id, code: "invalid_value" },
    });
    assert.equal(f.errors.length, 0);
    await generation(f);
    await f.session.interrupt();
    const cancel = f.socket.sent.findLast((x) => x.type === "response.cancel");
    f.socket.message({
      type: "error",
      error: { event_id: cancel.event_id, code: "response_cancel_not_active" },
    });
    assert.equal(f.errors.length, 0);
    f.socket.message({
      type: "error",
      error: { event_id: request.event_id, code: "response_cancel_not_active" },
    });
    assert.equal(f.errors.length, 1);
  } finally {
    await f.session.close();
  }
});
test("reasoning runs in parallel and speech invalidates its late result without closing session", async () => {
  let resolve!: (s: string) => void;
  let signal!: AbortSignal;
  const f = await fixture((_c: any, _ctx: any, _r: any, s: AbortSignal) => {
    signal = s;
    return new Promise((r) => (resolve = r));
  });
  try {
    const g = await generation(f);
    f.socket.message({
      type: "response.done",
      response: {
        id: g.responseId,
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "think",
            call_id: "think1",
            arguments: '{"request":"calculate"}',
          },
        ],
      },
    });
    assert.equal(f.session.reasoningPending, true);
    f.session.pushAudio(new AudioFrame(new Int16Array(480), 24000, 1, 480));
    assert.equal(f.socket.sent.at(-1).type, "input_audio_buffer.append");
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    assert.equal(signal.aborted, true);
    resolve("stale answer");
    await tick();
    assert.equal(
      f.socket.sent.some((x) => x.item?.output === "stale answer"),
      false,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.session.close();
  }
});
test("valid reasoning output returns once and waits until caller and active response end", async () => {
  let resolve!: (s: string) => void;
  const f = await fixture(() => new Promise((r) => (resolve = r)));
  try {
    const g = await generation(f);
    f.socket.message({
      type: "response.done",
      response: {
        id: g.responseId,
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "think",
            call_id: "think1",
            arguments: '{"request":"calculate"}',
          },
        ],
      },
    });
    const active = await generation(f, "ack");
    resolve("thirty");
    await tick();
    assert.equal(f.socket.sent.at(-1).item.output, "thirty");
    f.socket.message({
      type: "response.done",
      response: { id: active.responseId, status: "completed", output: [] },
    });
    assert.equal(f.socket.sent.at(-1).type, "response.create");
    assert.equal(
      f.socket.sent.filter((x) => x.item?.output === "thirty").length,
      1,
    );
  } finally {
    await f.session.close();
  }
});
test("pull-driven PCM queue admits 11.6s exactly and discard cannot consume a new generation", async () => {
  let overflow = 0;
  const queue = new BoundedStream<Buffer>(
    (x) => x.length,
    2880000,
    () => overflow++,
  );
  const pcm = Buffer.alloc(556800, 3);
  queue.push(pcm);
  assert.equal(queue.retainedBytes, pcm.length);
  const reader = queue.stream.getReader();
  assert.deepEqual((await reader.read()).value, pcm);
  assert.equal(queue.retainedBytes, 0);
  queue.discard();
  const next = new BoundedStream<Buffer>(
    (x) => x.length,
    2880000,
    () => overflow++,
  );
  next.push(Buffer.from([1, 0]));
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(
    (await next.stream.getReader().read()).value,
    Buffer.from([1, 0]),
  );
  next.end();
  assert.equal(overflow, 0);
});
test("response burst capacity cancels output without terminating the room or admitting late frames", async () => {
  const f = await fixture();
  try {
    const g = await generation(f);
    for (let n = 0; n < 7; n++)
      f.socket.message({
        type: "response.output_audio.delta",
        response_id: g.responseId,
        item_id: "audio",
        delta: Buffer.alloc(480000).toString("base64"),
      });
    assert.ok(f.warnings.includes("output_limit"));
    assert.equal(f.errors.length, 0);
    f.socket.message({
      type: "response.output_audio.delta",
      response_id: g.responseId,
      item_id: "audio",
      delta: Buffer.alloc(960).toString("base64"),
    });
    assert.equal(f.socket.terminated, false);
  } finally {
    await f.session.close();
  }
});
test("response-local typed failure releases admission without failure or farewell success", async () => {
  const pending = new PendingTypedInput();
  pending.admit("typed");
  let failures = 0;
  const handle = {
    waitForPlayout: async () => {},
    interrupted: false,
    exception: () => new ResponseUnavailable(),
  };
  pending.track("typed", handle, () => failures++);
  assert.equal(await pending.waitUntilIdle(), true);
  assert.equal(failures, 0);
  assert.equal(await successfulPlayout(handle), false);
  pending.close();
});
test("Realtime usage is response-keyed, includes failed counters, separates reasoning and unknown stop", async () => {
  const observations: any[] = [];
  const usage = new AzureUsageCapture(
    "call",
    "job",
    async (o) => {
      observations.push(o);
    },
    () => assert.fail(),
    true,
  );
  usage.observe({ type: "session.updated", session: { id: "s" } });
  for (const rid of ["r1", "r2", "r1"])
    usage.observe({
      type: "response.done",
      response: {
        id: rid,
        status: "incomplete",
        usage: {
          input_tokens: 12,
          output_tokens: 3,
          total_tokens: 15,
          input_token_details: {
            audio_tokens: 10,
            text_tokens: 2,
            cached_tokens: 4,
            cached_tokens_details: { audio_tokens: 4 },
          },
        },
      },
    });
  usage.finish();
  await usage.flush();
  assert.equal(
    observations.filter((o) => o.source === "azure_realtime").length,
    2,
  );
  assert.equal(observations[0].metrics.inputAudioTokens, 10);
  assert.equal(observations[0].metrics.voiceSessionSeconds, undefined);
  assert.equal(observations.at(-1).source, "azure_realtime_session");
  assert.deepEqual(observations.at(-1).metrics, {});
});
test("recovery has only two retries for the whole call, including after successful reconnection", async () => {
  const f = await fixture();
  try {
    f.socket.emit("close", 1006);
    await new Promise((r) => setTimeout(r, 550));
    assert.equal(f.sockets.length, 2);
    f.sockets[1].emit("open");
    f.ready(f.sockets[1], "s2");
    f.sockets[1].emit("close", 1006);
    await new Promise((r) => setTimeout(r, 1050));
    assert.equal(f.sockets.length, 3);
    f.sockets[2].emit("open");
    f.ready(f.sockets[2], "s3");
    f.sockets[2].emit("close", 1006);
    await tick();
    assert.equal(f.errors.length, 1);
    assert.equal(f.sockets.length, 3);
  } finally {
    await f.session.close();
  }
});
test("real AgentSession preserves typed identity and survives a filtered reply before the next turn", async () => {
  const sockets: Socket[] = [];
  let current!: MiniSession;
  class Model extends MiniModel {
    override session() {
      current = super.session();
      current.on("interrupted", () => {
        void session.interrupt().await;
      });
      return current;
    }
  }
  const model = new Model({
    baseURL: "https://unit.openai.azure.com/openai/v1",
    apiKey: "synthetic",
    context,
    socketFactory: () => {
      const s = new Socket();
      sockets.push(s);
      queueMicrotask(() => {
        s.emit("open");
        s.message({
          type: "session.updated",
          session: { ...miniSessionConfig(context), id: "real_sdk" },
        });
      });
      return s as any;
    },
  });
  const session = new voice.AgentSession({
    llm: model,
    vad: null,
    aecWarmupDuration: null,
  });
  const caller: string[] = [];
  let closed = false;
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (e) => {
    if (e.item.type === "message" && e.item.role === "user")
      caller.push(e.item.textContent);
  });
  session.on(voice.AgentSessionEventTypes.Close, () => (closed = true));
  await session.start({
    agent: new voice.Agent({ instructions: "Business facts" }),
  });
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("synthetic SDK wait exceeded");
  };
  try {
    const first = submitTypedInput(session, {
      id: "typed_1",
      text: "First request",
    });
    await wait(() => sockets[0].sent.some((x) => x.type === "response.create"));
    let request = sockets[0].sent.findLast((x) => x.type === "response.create");
    sockets[0].message({
      type: "response.created",
      response: { id: "filtered", metadata: request.response.metadata },
    });
    sockets[0].message({
      type: "response.done",
      response: {
        id: "filtered",
        status: "incomplete",
        status_details: { reason: "content_filter" },
        output: [],
      },
    });
    await first.waitForPlayout();
    assert.equal(closed, false);
    const second = submitTypedInput(session, {
      id: "typed_2",
      text: "Second request",
    });
    await wait(
      () =>
        sockets[0].sent.filter((x) => x.type === "response.create").length ===
        2,
    );
    request = sockets[0].sent.findLast((x) => x.type === "response.create");
    sockets[0].message({
      type: "response.created",
      response: { id: "normal", metadata: request.response.metadata },
    });
    sockets[0].message({
      type: "response.output_audio_transcript.delta",
      response_id: "normal",
      item_id: "spoken",
      delta: "Hello",
    });
    sockets[0].message({
      type: "response.output_audio.delta",
      response_id: "normal",
      item_id: "spoken",
      delta: Buffer.alloc(960, 1).toString("base64"),
    });
    sockets[0].message({
      type: "response.done",
      response: { id: "normal", status: "completed", output: [] },
    });
    await second.waitForPlayout();
    assert.deepEqual(caller, ["First request", "Second request"]);
    assert.equal(closed, false);
    assert.equal(second.exception(), undefined);
  } finally {
    await session.close();
    await model.close();
  }
});
test("typed correction invalidates reasoning and a late generated request cannot revive cancelled output", async () => {
  let resolve!: (s: string) => void;
  const f = await fixture(() => new Promise((r) => (resolve = r)));
  try {
    const g = await generation(f);
    f.socket.message({
      type: "response.done",
      response: {
        id: g.responseId,
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "think",
            call_id: "t",
            arguments: '{"request":"old"}',
          },
        ],
      },
    });
    const chat = new llm.ChatContext();
    chat.addMessage({ role: "user", content: "Correction", id: "typed" });
    await f.session.updateChatCtx(chat);
    resolve("obsolete");
    await tick();
    assert.equal(
      f.socket.sent.some((x) => x.item?.output === "obsolete"),
      false,
    );
    const controller = new AbortController();
    const response = f.session
      .generateReply("ask", { signal: controller.signal })
      .catch((e) => e);
    await tick();
    const request = f.socket.sent.findLast((x) => x.type === "response.create");
    controller.abort();
    assert.ok((await response) instanceof ResponseUnavailable);
    let generated = 0;
    f.session.on("generation_created", () => generated++);
    f.socket.message({
      type: "response.created",
      response: { id: "late", metadata: request.response.metadata },
    });
    assert.equal(generated, 0);
    assert.equal(f.socket.sent.at(-1).type, "response.cancel");
  } finally {
    await f.session.close();
  }
});
test("same response cannot authorize farewell before a pending think, regardless of output order", async () => {
  let resolve!: (s: string) => void;
  const f = await fixture(() => new Promise((r) => (resolve = r)));
  try {
    const g = await generation(f);
    f.socket.message({
      type: "response.done",
      response: {
        id: g.responseId,
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "end_call",
            call_id: "bye",
            arguments: "{}",
          },
          {
            type: "function_call",
            name: "think",
            call_id: "think",
            arguments: '{"request":"pending"}',
          },
        ],
      },
    });
    assert.equal((await g.functionStream.getReader().read()).done, true);
    assert.equal(f.session.closureAllowed, false);
    resolve("done");
    await tick();
  } finally {
    await f.session.close();
  }
});
test("authentication/configuration failures never retry and close cancels an already scheduled reconnect", async () => {
  const f = await fixture();
  f.socket.message({ type: "error", error: { code: "invalid_api_key" } });
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.errors.length, 1);
  await f.session.close();
  const other = await fixture();
  other.socket.emit("close", 1006);
  await other.session.close();
  await new Promise((r) => setTimeout(r, 550));
  assert.equal(other.sockets.length, 1);
});
test("reasoning request body is bounded and records incomplete charged output without speaking it", async () => {
  const { reasonMini } = await import("../src/mini-reasoning.js");
  const recorded: any[] = [];
  let body: any;
  await assert.rejects(
    reasonMini(
      {
        baseURL: "https://unit.openai.azure.com/openai/v1",
        apiKey: "synthetic",
      },
      context,
      "request",
      new AbortController().signal,
      (x) => recorded.push(x),
      async (url, options) => {
        assert.equal(url, "https://unit.openai.azure.com/openai/v1/responses");
        body = JSON.parse(options!.body as string);
        return new Response(
          JSON.stringify({
            id: "r",
            status: "incomplete",
            usage: { input_tokens: 3, output_tokens: 5 },
          }),
        );
      },
    ),
  );
  assert.equal(body.max_output_tokens, 1200);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.match(body.instructions, /Only sell dentistry/);
  assert.equal(recorded[0].status, "incomplete");
});
test("reconnect clears disconnected speech state and obsolete automatic requests cannot answer corrections", async () => {
  const f = await fixture();
  try {
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    f.socket.emit("close", 1006);
    await new Promise((r) => setTimeout(r, 550));
    const next = f.sockets[1];
    next.emit("open");
    f.ready(next, "new_session");
    const request = next.sent.findLast((x) => x.type === "response.create");
    assert.ok(
      request,
      "Recovery must ask to repeat even if speech ended during the outage",
    );
    f.session.invalidateReasoning();
    let generated = 0;
    f.session.on("generation_created", () => generated++);
    next.message({
      type: "response.created",
      response: { id: "obsolete", metadata: request.response.metadata },
    });
    assert.equal(generated, 0);
    assert.equal(next.sent.at(-1).type, "response.cancel");
  } finally {
    await f.session.close();
  }
});
test("synchronous socket construction and WebSocket protocol errors terminate without retry", async () => {
  const errors: any[] = [];
  let attempts = 0;
  const model = new MiniModel({
    baseURL: "https://unit.openai.azure.com/openai/v1",
    apiKey: "synthetic",
    context,
    socketFactory: () => {
      attempts++;
      throw Error("synthetic");
    },
  });
  const session = model.session();
  session.on("error", (e) => errors.push(e));
  await tick();
  assert.equal(errors[0].error.message, "configuration_invalid");
  assert.equal(attempts, 1);
  await session.close();
  const f = await fixture();
  f.socket.emit(
    "error",
    Object.assign(Error("synthetic"), {
      code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
    }),
  );
  assert.equal(f.errors[0].error.message, "protocol_rejected");
  await f.session.close();
});
test("session echo must preserve configured VAD and transcription", async () => {
  for (const mutate of [
    (s: any) => (s.audio.input.turn_detection.threshold = 0.5),
    (s: any) => (s.audio.input.transcription.model = "other"),
  ]) {
    const f = await fixture();
    const session = structuredClone(miniSessionConfig(context));
    mutate(session);
    f.socket.message({
      type: "session.updated",
      session: { ...session, id: "session" },
    });
    assert.equal(f.errors[0].error.message, "configuration_invalid");
    await f.session.close();
  }
});
test("automatic response admission has a deadline and uses the same bounded recovery controller", async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.socket.emit("close", 1006);
    mock.timers.tick(500);
    await tick();
    f.sockets[1].emit("open");
    f.ready(f.sockets[1], "s2");
    assert.ok(f.sockets[1].sent.some((x) => x.type === "response.create"));
    mock.timers.tick(15000);
    mock.timers.tick(1000);
    await tick();
    assert.equal(f.sockets.length, 3);
    f.sockets[2].emit("open");
    f.ready(f.sockets[2], "s3");
    mock.timers.tick(15000);
    assert.equal(f.errors.length, 1);
    assert.equal(f.sockets.length, 3);
  } finally {
    await f.session.close();
    mock.timers.reset();
  }
});
test("installed native output keeps a new segment when an old native capture completes after clear", async () => {
  // Real pinned SDK sink and native AudioSource; only publication and completion timing are synthetic.
  const { TrackPublishOptions, dispose } = await import("@livekit/rtc-node");
  const room = {
    localParticipant: {
      publishTrack: async () => ({
        sid: "synthetic_track",
        waitForSubscription: async () => {},
      }),
    },
  };
  const sink = new voice.ParticipantAudioOutput(room as any, {
    sampleRate: 24000,
    numChannels: 1,
    queueSizeMs: 100,
    trackPublishOptions: new TrackPublishOptions(),
  });
  await sink.start(new AbortController().signal);
  const source = (sink as any).audioSource;
  const capture = source.captureFrame.bind(source);
  let heldResolve!: () => void, capturedResolve!: () => void;
  const held = new Promise<void>((r) => (heldResolve = r)),
    captured = new Promise<void>((r) => (capturedResolve = r));
  let calls = 0;
  source.captureFrame = async (frame: AudioFrame) => {
    await capture(frame);
    if (++calls === 1) {
      capturedResolve();
      await held;
    }
  };
  try {
    const old = sink.captureFrame(
      new AudioFrame(new Int16Array(480).fill(10), 24000, 1, 480),
    );
    await captured;
    sink.clearBuffer();
    const discarded = await sink.waitForPlayout();
    assert.equal(discarded.interrupted, true);
    await sink.captureFrame(new AudioFrame(new Int16Array(480), 24000, 1, 480));
    assert.equal(sink.pendingPlayoutSegments, 1);
    heldResolve();
    await old;
    assert.equal(
      sink.pendingPlayoutSegments,
      1,
      "Late old completion must not finish the new segment",
    );
    sink.flush();
    const played = await sink.waitForPlayout();
    assert.equal(played.interrupted, false);
    assert.equal(
      played.playbackPosition,
      0.02,
      "Quiet new frame remains admitted exactly once",
    );
    assert.equal(calls, 2);
  } finally {
    heldResolve();
    await sink.close();
    await dispose();
  }
});
test("queued replies wait through long active output and caller speech without consuming transport recovery", async () => {
  const f = await fixture();
  const controller = new AbortController();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const active = await generation(f);
    const pending = f.session
      .generateReply("queued", { signal: controller.signal })
      .catch((e) => e);
    await tick();
    mock.timers.tick(16000);
    await tick();
    assert.equal(f.warnings.includes("reconnecting"), false);
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    f.socket.message({
      type: "response.done",
      response: { id: active.responseId, status: "completed", output: [] },
    });
    mock.timers.tick(16000);
    await tick();
    assert.equal(
      f.socket.sent.filter((x) => x.type === "response.create").length,
      1,
    );
    assert.equal(f.sockets.length, 1);
    f.socket.message({ type: "input_audio_buffer.speech_stopped" });
    f.socket.message({
      type: "response.created",
      response: { id: "vad_before_queued" },
    });
    f.socket.message({
      type: "response.done",
      response: { id: "vad_before_queued", status: "completed", output: [] },
    });
    const request = f.socket.sent.at(-1);
    assert.equal(request.type, "response.create");
    f.socket.message({
      type: "response.created",
      response: { id: "queued", metadata: request.response.metadata },
    });
    assert.equal((await pending).responseId, "queued");
    assert.equal(f.errors.length, 0);
  } finally {
    controller.abort();
    await f.session.close();
    mock.timers.reset();
  }
});
test("typed facts enter bounded reconnect history once, without replaying input", async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const chat = new llm.ChatContext();
    chat.addMessage({
      id: "typed_fact",
      role: "user",
      content: "The requested appointment is Tuesday at ten.",
    });
    await f.session.updateChatCtx(chat);
    await f.session.updateChatCtx(chat);
    f.socket.emit("close", 1006);
    mock.timers.tick(500);
    await tick();
    f.sockets[1].emit("open");
    const config = f.sockets[1].sent[0].session;
    assert.equal(
      config.instructions.split("The requested appointment is Tuesday at ten.")
        .length - 1,
      1,
    );
    assert.equal(
      f.sockets[1].sent.some((x) => x.type === "conversation.item.create"),
      false,
    );
  } finally {
    await f.session.close();
    mock.timers.reset();
  }
});
test("queued reply expiry is local while dispatched acknowledgment timeout uses recovery", async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    const queued = f.session.generateReply().catch((e) => e);
    await tick();
    mock.timers.tick(60000);
    await tick();
    assert.ok((await queued) instanceof ResponseUnavailable);
    assert.equal(f.warnings.includes("reconnecting"), false);
    assert.equal(
      f.socket.sent.some((x) => x.type === "response.create"),
      false,
    );
    f.socket.message({ type: "input_audio_buffer.speech_stopped" });
    f.socket.message({
      type: "response.created",
      response: { id: "vad_before_dispatch" },
    });
    f.socket.message({
      type: "response.done",
      response: { id: "vad_before_dispatch", status: "completed", output: [] },
    });
    const dispatched = f.session.generateReply().catch((e) => e);
    await tick();
    mock.timers.tick(15000);
    await tick();
    assert.ok((await dispatched) instanceof ResponseUnavailable);
    assert.equal(f.warnings.includes("reconnecting"), true);
  } finally {
    await f.session.close();
    mock.timers.reset();
  }
});
test("server VAD response reserves admission before a queued typed reply", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    const queued = f.session
      .generateReply("typed", { signal: controller.signal })
      .catch((e) => e);
    await tick();
    f.socket.message({ type: "input_audio_buffer.speech_stopped" });
    assert.equal(
      f.socket.sent.some((x) => x.type === "response.create"),
      false,
    );
    f.socket.message({
      type: "response.created",
      response: { id: "server_vad" },
    });
    assert.equal(
      f.socket.sent.some((x) => x.type === "response.create"),
      false,
    );
    f.socket.message({
      type: "response.done",
      response: { id: "server_vad", status: "completed", output: [] },
    });
    const request = f.socket.sent.at(-1);
    assert.equal(request.type, "response.create");
    f.socket.message({
      type: "response.created",
      response: { id: "typed", metadata: request.response.metadata },
    });
    assert.equal((await queued).responseId, "typed");
    assert.equal(f.errors.length, 0);
  } finally {
    controller.abort();
    await f.session.close();
  }
});
for (const transcript of ["Heard prefix", undefined])
  test(`reconnect history omits unheard assistant suffix with ${transcript ? "known" : "unknown"} playback transcript`, async () => {
    const f = await fixture();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const g = await generation(f);
      f.socket.message({
        type: "response.output_audio_transcript.delta",
        response_id: g.responseId,
        item_id: "answer",
        delta: "Heard prefix. Unheard private suffix.",
      });
      f.socket.message({
        type: "response.output_audio.delta",
        response_id: g.responseId,
        item_id: "answer",
        delta: Buffer.alloc(960).toString("base64"),
      });
      f.socket.message({
        type: "response.done",
        response: { id: g.responseId, status: "completed", output: [] },
      });
      await f.session.truncate({
        messageId: "answer",
        audioEndMs: 10,
        audioTranscript: transcript,
      });
      f.socket.emit("close", 1006);
      mock.timers.tick(500);
      await tick();
      f.sockets[1].emit("open");
      const prompt = f.sockets[1].sent[0].session.instructions;
      assert.equal(prompt.includes("Unheard private suffix"), false);
      assert.equal(prompt.includes("Heard prefix"), false);
    } finally {
      await f.session.close();
      mock.timers.reset();
    }
  });
test("server response can arrive before the typed request and a correlated active rejection retries only admission", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const reply = f.session
      .generateReply("typed", { signal: controller.signal })
      .catch((e) => e);
    await tick();
    const rejected = f.socket.sent.at(-1);
    f.socket.message({
      type: "error",
      error: {
        code: "conversation_already_has_active_response",
        event_id: rejected.event_id,
      },
    });
    assert.equal(f.errors.length, 0);
    f.socket.message({
      type: "response.created",
      response: { id: "server_first" },
    });
    assert.equal(
      f.socket.sent.filter((x) => x.type === "response.create").length,
      1,
    );
    f.socket.message({
      type: "response.done",
      response: { id: "server_first", status: "completed", output: [] },
    });
    const dispatched = f.socket.sent.at(-1);
    assert.equal(dispatched.type, "response.create");
    assert.deepEqual(dispatched.response.metadata, rejected.response.metadata);
    f.socket.message({
      type: "response.created",
      response: {
        id: "typed_after_server",
        metadata: dispatched.response.metadata,
      },
    });
    assert.equal((await reply).responseId, "typed_after_server");
    assert.equal(
      f.socket.sent.some((x) => x.type === "conversation.item.create"),
      false,
    );
  } finally {
    controller.abort();
    await f.session.close();
  }
});
test("server-response reservation cleans up on a new turn, timeout and stop", async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    f.socket.message({ type: "input_audio_buffer.speech_stopped" });
    mock.timers.tick(14000);
    f.socket.message({ type: "input_audio_buffer.speech_started" });
    mock.timers.tick(2000);
    assert.equal(f.warnings.includes("reconnecting"), false);
    f.socket.message({ type: "input_audio_buffer.speech_stopped" });
    mock.timers.tick(15000);
    assert.equal(f.warnings.includes("reconnecting"), true);
    await f.session.close();
    mock.timers.tick(60000);
    assert.equal(f.sockets.length, 1);
  } finally {
    await f.session.close();
    mock.timers.reset();
  }
});
test("reconnection retains SDK-confirmed assistant and typed context but omits completed buffered output", async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const chat = new llm.ChatContext();
    chat.addMessage({ id: "typed", role: "user", content: "Caller fact" });
    await f.session.updateChatCtx(chat);
    for (const [rid, text] of [
      ["confirmed", "Played answer"],
      ["buffered", "Unconfirmed answer"],
    ]) {
      const g = await generation(f, rid);
      f.socket.message({
        type: "response.output_audio_transcript.delta",
        response_id: g.responseId,
        item_id: rid,
        delta: text,
      });
      f.socket.message({
        type: "response.done",
        response: { id: g.responseId, status: "completed", output: [] },
      });
    }
    f.session.confirmPlayback("confirmed", "Played answer");
    f.socket.emit("close", 1006);
    f.session.confirmPlayback("buffered", "Unconfirmed answer");
    mock.timers.tick(500);
    await tick();
    f.sockets[1].emit("open");
    const prompt = f.sockets[1].sent[0].session.instructions;
    assert.match(prompt, /Caller fact/);
    assert.match(prompt, /Played answer/);
    assert.equal(prompt.includes("Unconfirmed answer"), false);
    assert.equal(f.session.chatCtx.getById("buffered"), undefined);
  } finally {
    await f.session.close();
    mock.timers.reset();
  }
});
for (const rejectionAfterDone of [true, false]) {
  test(`correlated active rejection ${rejectionAfterDone ? "after" : "before"} competing response completion requeues without phantom wait`, async () => {
    const f = await fixture();
    const controller = new AbortController();
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const reply = f.session.generateReply("typed", { signal: controller.signal }).catch(e => e);
      await tick();
      const original = f.socket.sent.at(-1);
      const rejection = {
        type: "error",
        error: { code: "conversation_already_has_active_response", event_id: original.event_id },
      };
      f.socket.message({ type: "response.created", response: { id: "competing" } });
      if (!rejectionAfterDone) f.socket.message(rejection);
      f.socket.message({ type: "response.done", response: { id: "competing", status: "completed", output: [] } });
      if (rejectionAfterDone) f.socket.message(rejection);
      assert.equal(f.socket.sent.filter(x => x.type === "response.create").length, 2,
        "completed competitor must not reserve a nonexistent next server response");
      const next = f.socket.sent.at(-1);
      f.socket.message({ type: "response.created", response: { id: "admitted", metadata: next.response.metadata } });
      assert.equal((await reply).responseId, "admitted");
      f.socket.message(rejection);
      assert.equal(f.errors.length, 0, "exact duplicate rejected admission must not terminate the accepted retry");
      mock.timers.tick(16000);
      assert.equal(f.warnings.includes("reconnecting"), false);
      assert.equal(f.socket.sent.some(x => x.type === "conversation.item.create"), false);
    } finally {
      controller.abort();
      await f.session.close();
      mock.timers.reset();
    }
  });
}
for (const order of ['cancelled-done', 'competing-rejection'] as const) {
  test(`aborted dispatched request releases queued successor after ${order}`, async () => {
    const f = await fixture(); const a = new AbortController(); const b = new AbortController();
    mock.timers.enable({apis:['setTimeout']});
    try {
      const first = f.session.generateReply('first',{signal:a.signal}).catch(e=>e); await tick();
      const request = f.socket.sent.at(-1);
      const second = f.session.generateReply('second',{signal:b.signal}).catch(e=>e); await tick();
      a.abort(); await first;
      assert.equal(f.socket.sent.filter(e=>e.type==='response.create').length,1);
      if(order==='cancelled-done') {
        f.socket.message({type:'response.created',response:{id:'cancelled',metadata:request.response.metadata}});
        assert.equal(f.socket.sent.filter(e=>e.type==='response.create').length,1);
        f.socket.message({type:'response.done',response:{id:'cancelled',status:'cancelled',output:[]}});
      } else {
        f.socket.message({type:'response.created',response:{id:'competitor'}});
        f.socket.message({type:'error',error:{code:'conversation_already_has_active_response',event_id:request.event_id}});
        f.socket.message({type:'response.done',response:{id:'competitor',status:'completed',output:[]}});
      }
      assert.equal(f.socket.sent.filter(e=>e.type==='response.create').length,2,'queued successor dispatched once after reconciliation');
      const next=f.socket.sent.at(-1);f.socket.message({type:'response.created',response:{id:'second',metadata:next.response.metadata}});
      assert.equal((await second).responseId,'second');
      f.socket.message({type:'response.done',response:{id:'cancelled',status:'cancelled',output:[]}});
      mock.timers.tick(16000);assert.equal(f.warnings.includes('reconnecting'),false);assert.equal(f.errors.length,0);
    } finally {a.abort();b.abort();await f.session.close();mock.timers.reset();}
  });
}
test('typed correction cancels already admitted reasoning reply and pending audio',async()=>{
  let complete!:(value:string)=>void;const f=await fixture(()=>new Promise<string>(r=>complete=r));
  try {
    const g=await generation(f);
    f.socket.message({type:'response.done',response:{id:g.responseId,status:'completed',output:[{type:'function_call',name:'think',call_id:'reason',arguments:'{"request":"old"}'}]}});
    complete('obsolete answer');await tick();const request=f.socket.sent.at(-1);
    f.socket.message({type:'response.created',response:{id:'reasoned',metadata:request.response.metadata}});
    let interrupted=0;f.session.on('interrupted',()=>interrupted++);
    f.session.invalidateReasoning();
    assert.equal(f.socket.sent.some(e=>e.type==='response.cancel'&&e.response_id==='reasoned'),true);
    assert.equal(interrupted,1);
  }finally{await f.session.close();}
});
for (const phase of ['awaiting-ack','completed-buffered'] as const) {
  test(`typed correction retires ${phase} reasoning without stale history or successor loss`,async()=>{
    let complete!:(value:string)=>void;const f=await fixture(()=>new Promise<string>(r=>complete=r));
    const controller=new AbortController();
    try {
      const g=await generation(f);
      f.socket.message({type:'response.done',response:{id:g.responseId,status:'completed',output:[{type:'function_call',name:'think',call_id:'reason',arguments:'{"request":"old"}'}]}});
      complete('obsolete');await tick();const request=f.socket.sent.at(-1);
      if(phase==='completed-buffered') {
        f.socket.message({type:'response.created',response:{id:'obsolete',metadata:request.response.metadata}});
        f.socket.message({type:'response.output_audio_transcript.delta',response_id:'obsolete',item_id:'old-item',delta:'Obsolete answer'});
        f.socket.message({type:'response.done',response:{id:'obsolete',status:'completed',output:[]}});
      }
      let interrupted=0;f.session.on('interrupted',()=>interrupted++);
      const chat=new llm.ChatContext();chat.addMessage({id:'correction',role:'user',content:'Use my corrected request'});
      await f.session.updateChatCtx(chat);
      const next=f.session.generateReply('corrected',{signal:controller.signal}).catch(e=>e);await tick();
      if(phase==='awaiting-ack') {
        f.socket.message({type:'response.created',response:{id:'obsolete',metadata:request.response.metadata}});
        f.socket.message({type:'response.done',response:{id:'obsolete',status:'cancelled',output:[{type:'function_call',name:'end_call',call_id:'late',arguments:'{}'}]}});
      } else assert.equal(interrupted,1);
      const dispatched=f.socket.sent.findLast(e=>e.type==='response.create');
      assert.notEqual(dispatched.response.metadata.openfon_request,request.response.metadata.openfon_request);
      f.socket.message({type:'response.created',response:{id:'corrected',metadata:dispatched.response.metadata}});
      assert.equal((await next).responseId,'corrected');
      assert.equal(f.session.chatCtx.getById('old-item'),undefined);
      assert.equal(f.session.closureAllowed,false);
      assert.equal(f.errors.length,0);
    }finally{controller.abort();await f.session.close();}
  });
}
