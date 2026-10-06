import { it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  azureConfig,
  managedVoiceCatalog,
  savedManagedVoice,
} from "../src/managed-azure";
import { managedBrowserSettings } from "../src/livekit-settings";
import { resolveSummary } from "../src/summary-settings";
import { generateManagedVoicePreview } from "../src/voice-preview";
import { ingestProviderUsage, normalizeUsage } from "../src/commercial-usage";
import type { Env, AgentSettings } from "../src/types";
import { SqliteD1, applyMigrations } from "./sqlite-d1";
const env = {
  OPENFON_MANAGED_WEB: "true",
  AZURE_OPENAI_ENDPOINT: "https://unit.openai.azure.com/",
  AZURE_OPENAI_API_KEY: "synthetic",
  AZURE_OPENAI_LIVE_DEPLOYMENT: "gpt-realtime-2.1-mini",
} as Env;
afterEach(() => vi.unstubAllGlobals());
it("operator Mini selection changes only calling and compatible catalog; saved voices and summary remain explicit", () => {
  expect(azureConfig(env).liveModel).toBe("gpt-realtime-2.1-mini");
  expect(
    azureConfig({ ...env, AZURE_OPENAI_LIVE_DEPLOYMENT: undefined }).liveModel,
  ).toBe("gpt-live-1");
  const settings = {
    voice: "cedar",
    realtime_voice: "",
    realtime_model: "customer-model",
    realtime_api_key: "private",
    engine: "pipeline",
  } as AgentSettings;
  expect(managedBrowserSettings(env, settings)).toMatchObject({
    realtime_model: "gpt-realtime-2.1-mini",
    realtime_voice: "cedar",
    realtime_api_key: "",
  });
  expect(settings.realtime_api_key).toBe("private");
  expect(managedVoiceCatalog(env).voices).toHaveLength(10);
  expect(JSON.stringify(managedVoiceCatalog(env))).not.toMatch(
    /azure|model|engine|key/,
  );
  expect(() =>
    savedManagedVoice({ ...settings, voice: "breeze" }, env),
  ).toThrow("Choose");
  expect(
    savedManagedVoice({ ...settings, voice: "", realtime_voice: "" }, env),
  ).toBe("marin");
  expect(resolveSummary(env, null, null, null)).toMatchObject({
    model: "gpt-5.4-mini",
    apiKey: "synthetic",
  });
});
it("Realtime response token evidence remains separately scoped and additive across responses and reconnects", async () => {
  const db = new SqliteD1();
  try {
    applyMigrations(db);
    db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
    db.exec(
      "INSERT INTO users(id,email,password_hash)VALUES('u','u@example.invalid','x');INSERT INTO businesses(id,user_id,slug,name)VALUES('b','u','b','B');INSERT INTO calls(id,business_id,connected_at)VALUES('c','b',CURRENT_TIMESTAMP)",
    );
    const e = { ...env, DB: db } as unknown as Env,
      scope = { callId: "c", jobId: "j", businessId: "b" };
    const usage = {
      ...scope,
      eventId: "one",
      source: "azure_realtime" as const,
      providerSessionId: "s1",
      providerResponseId: "r1",
      observedAt: "2026-10-06T12:00:00Z",
      final: true,
      model: "gpt-realtime-2.1-mini",
      metrics: {
        inputTokens: 20,
        inputAudioTokens: 15,
        inputTextTokens: 5,
        cachedInputTokens: 3,
        cachedAudioTokens: 3,
        outputTokens: 5,
        totalTokens: 25,
      },
    };
    await ingestProviderUsage(e, scope, usage);
    await ingestProviderUsage(e, scope, usage);
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "two",
      providerResponseId: "r2",
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "three",
      providerSessionId: "s2",
    });
    expect(
      db.database
        .prepare(
          "SELECT SUM(value) n FROM commercial_provider_metrics WHERE metric='totalTokens'",
        )
        .get(),
    ).toEqual({ n: 75 });
    expect(
      db.database
        .prepare("SELECT count(*) n FROM commercial_provider_observations")
        .get(),
    ).toEqual({ n: 3 });
    await expect(
      ingestProviderUsage(e, { ...scope, businessId: "foreign" }, usage),
    ).rejects.toThrow();
    expect(() =>
      normalizeUsage({
        ...usage,
        metrics: { inputTokens: 2, inputAudioTokens: 3 },
      }),
    ).toThrow();
  } finally {
    db.close();
  }
});
class Socket {
  listeners = new Map<string, Function[]>();
  sent: any[] = [];
  accept() {}
  send(v: string) {
    this.sent.push(JSON.parse(v));
  }
  close() {
    for (const f of this.listeners.get("close") ?? []) f({});
  }
  addEventListener(n: string, f: Function) {
    this.listeners.set(n, [...(this.listeners.get(n) ?? []), f]);
  }
  receive(v: any) {
    for (const f of this.listeners.get("message") ?? [])
      f({ data: JSON.stringify(v) });
  }
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
for (const status of ["completed", "incomplete"])
  it(`Mini preview uses chosen GA speech path and records ${status} response usage`, async () => {
    const db = new SqliteD1(),
      socket = new Socket();
    try {
      applyMigrations(db);
      db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
      db.exec(
        "INSERT INTO users(id,email,password_hash)VALUES('u','u@example.invalid','x');INSERT INTO businesses(id,user_id,slug,name)VALUES('b','u','b','B')",
      );
      const fetcher = vi.fn(async () => ({ status: 101, webSocket: socket }));
      vi.stubGlobal("fetch", fetcher);
      const promise = generateManagedVoicePreview(
        { ...env, DB: db } as unknown as Env,
        { voice: "cedar", language: "de" },
        new AbortController().signal,
        { businessId: "b", operationId: "preview" },
      );
      const result = promise.then(
        (x) => x,
        () => null,
      );
      await tick();
      expect(fetcher.mock.calls[0][0]).toBe(
        "https://unit.openai.azure.com/openai/v1/realtime?model=gpt-realtime-2.1-mini",
      );
      expect(socket.sent[0].session.audio.output.voice).toBe("cedar");
      expect(socket.sent[0].session.tools).toEqual([]);
      socket.receive({
        type: "session.updated",
        session: {
          id: "preview_session",
          model: "gpt-realtime-2.1-mini",
          audio: {
            output: {
              voice: "cedar",
              format: { type: "audio/pcm", rate: 24000 },
            },
          },
        },
      });
      socket.receive({
        type: "response.created",
        response: { id: "response" },
      });
      socket.receive({
        type: "response.output_audio.delta",
        response_id: "response",
        delta: Buffer.from([1, 0, 0, 0, 2, 0]).toString("base64"),
      });
      socket.receive({
        type: "response.done",
        response: {
          id: "response",
          status,
          usage: {
            input_tokens: 2,
            output_tokens: 3,
            total_tokens: 5,
            input_token_details: { text_tokens: 2 },
            output_token_details: { audio_tokens: 3 },
          },
        },
      });
      const audio = await result;
      if (status === "completed")
        expect(new Uint8Array(audio!).slice(44)).toEqual(
          new Uint8Array([1, 0, 0, 0, 2, 0]),
        );
      else expect(audio).toBeNull();
      expect(
        db.database
          .prepare("SELECT source,model FROM commercial_provider_observations")
          .get(),
      ).toEqual({ source: "azure_realtime", model: "gpt-realtime-2.1-mini" });
      expect(
        db.database
          .prepare(
            "SELECT value FROM commercial_provider_metrics WHERE metric='totalTokens'",
          )
          .get(),
      ).toEqual({ value: 5 });
    } finally {
      db.close();
    }
  });
it("transcription usage aggregates per session/item/content independently of Realtime, with scoped replay and no retail interval", async () => {
  const db = new SqliteD1();
  try {
    applyMigrations(db);
    db.exec(readFileSync("migrations/0027_commercial.sql", "utf8"));
    db.exec(
      "INSERT INTO users(id,email,password_hash)VALUES('u','u@example.invalid','x');INSERT INTO businesses(id,user_id,slug,name)VALUES('b','u','b','B');INSERT INTO calls(id,business_id,connected_at)VALUES('c','b',CURRENT_TIMESTAMP)",
    );
    const e = { ...env, DB: db } as unknown as Env,
      scope = { callId: "c", jobId: "j", businessId: "b" };
    const usage = {
      ...scope,
      eventId: "asr1",
      source: "azure_transcription" as const,
      providerSessionId: "s1",
      providerItemId: "i1",
      providerContentIndex: 0,
      model: "gpt-4o-mini-transcribe",
      observedAt: "2026-10-06T12:00:00Z",
      final: true,
      metrics: {
        inputTokens: 15,
        inputAudioTokens: 12,
        inputTextTokens: 3,
        outputTokens: 4,
        totalTokens: 19,
      },
    };
    await ingestProviderUsage(e, scope, usage);
    await ingestProviderUsage(e, scope, usage);
    await ingestProviderUsage(e, scope, { ...usage, eventId: "asr-repeat" });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "asr2",
      providerItemId: "i2",
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "asr-content",
      providerContentIndex: 1,
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "asr-reconnect",
      providerSessionId: "s2",
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "asr-unknown",
      providerItemId: "unknown",
      metrics: {},
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "asr-duration",
      providerItemId: "duration",
      metrics: { transcriptionSeconds: "1.125000001" },
    });
    await ingestProviderUsage(e, scope, {
      ...usage,
      eventId: "conversation",
      source: "azure_realtime",
      providerItemId: undefined,
      providerContentIndex: undefined,
      providerResponseId: "i1",
      model: "gpt-realtime-2.1-mini",
      metrics: { totalTokens: 60 },
    });
    expect(
      db.database
        .prepare(
          "SELECT source,SUM(value) n FROM commercial_provider_metrics WHERE metric='totalTokens' GROUP BY source ORDER BY source",
        )
        .all(),
    ).toEqual([
      { source: "azure_realtime", n: 60 },
      { source: "azure_transcription", n: 76 },
    ]);
    expect(
      db.database
        .prepare(
          "SELECT value FROM commercial_provider_metrics WHERE metric='transcriptionNanoseconds'",
        )
        .get(),
    ).toEqual({ value: 1125000001 });
    expect(
      db.database
        .prepare(
          "SELECT count(*) n FROM commercial_provider_metrics WHERE usage_key LIKE '%unknown%'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db.database.prepare("SELECT count(*) n FROM commercial_call_usage").get(),
    ).toEqual({ n: 0 });
    const row = db.database
      .prepare(
        "SELECT source,model,usage_key FROM commercial_provider_observations WHERE event_id='asr1'",
      )
      .get() as any;
    expect(row).toEqual({
      source: "azure_transcription",
      model: "gpt-4o-mini-transcribe",
      usage_key: JSON.stringify(["s1", "i1", 0, "gpt-4o-mini-transcribe"]),
    });
    await expect(
      ingestProviderUsage(e, { ...scope, businessId: "foreign" }, usage),
    ).rejects.toThrow();
    await expect(
      ingestProviderUsage(e, scope, { ...usage, jobId: "foreign" }),
    ).rejects.toThrow();
    await expect(
      ingestProviderUsage(e, scope, { ...usage, callId: "foreign" }),
    ).rejects.toThrow();
    await expect(
      ingestProviderUsage(e, scope, { ...usage, metrics: { totalTokens: 99 } }),
    ).rejects.toThrow("Conflicting");
    for (const invalid of [
      { providerResponseId: "fake" },
      { providerItemId: undefined },
      { providerContentIndex: -1 },
      { metrics: { inputTokens: 1, inputAudioTokens: 2 } },
      { metrics: { voiceSessionSeconds: "1" } },
    ])
      expect(() => normalizeUsage({ ...usage, ...invalid })).toThrow();
    expect(() =>
      normalizeUsage({
        ...usage,
        source: "azure_realtime",
        providerResponseId: "r",
      }),
    ).toThrow();
  } finally {
    db.close();
  }
});
