import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { voice } from "@livekit/agents";
import worker from "../src/worker.js";
import { ControlClient } from "../src/control.js";
import { UsageOutbox } from "../src/usage-outbox.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
for (const scenario of ["closed", "disconnect", "uncertain"] as const) {
  test(`actual worker entry quiesces media before service cutoff: ${scenario}`, async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      OPENFON_API_URL: "https://control.example.invalid",
      OPENFON_AGENT_SERVICE_TOKEN: "synthetic",
      OPENFON_USAGE_DIR: "/synthetic/unused",
      AZURE_OPENAI_ENDPOINT: "https://fixture.cognitiveservices.azure.com",
      AZURE_OPENAI_API_KEY: "synthetic",
    });
    const events: string[] = [];
    let releaseClose!: () => void, releasePost!: () => void;
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const posted = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    const context = {
      callId: "c",
      room: "room",
      caller: "caller",
      callback: "synthetic",
      instructions: "Business",
      greeting: "Hello",
      voice: "marin",
      language: "en",
    };
    mock.method(UsageOutbox.prototype, "assertAvailable", async () => {});
    mock.method(
      ControlClient.prototype,
      "post",
      async (operation: string, body: Record<string, unknown>) => {
        if (operation === "context") return context;
        events.push(String(body.type));
        if (body.type === "service_stopped") await posted;
        return {};
      },
    );
    mock.method(
      voice.AgentSession.prototype,
      "shutdown",
      function (this: voice.AgentSession, options: { drain: boolean }) {
        assert.equal(
          this.input.audioEnabled,
          false,
          "input stopped before session shutdown",
        );
        assert.equal(options.drain, false, "setup error must not drain");
        events.push("shutdown");
      },
    );
    mock.method(voice.AgentSession.prototype, "close", async () => {
      events.push("closing");
      await closed;
      if (scenario !== "closed") throw Error("synthetic close failure");
      events.push("closed");
    });
    const ctx = {
      job: { id: "job", metadata: '{"callId":"c"}', room: { name: "room" } },
      addShutdownCallback: () => {},
      connect: async () => {
        throw Error("synthetic connection failure");
      },
      shutdown: () => {
        events.push("job_shutdown");
      },
      room: {
        name: "room",
        isConnected: true,
        off: () => {},
        disconnect: async () => {
          events.push("disconnect");
          if (scenario === "uncertain")
            throw Error("synthetic disconnect failure");
          events.push("disconnected");
        },
      },
    };
    const entry = worker.entry(ctx as never).catch(() => {});
    try {
      for (let i = 0; i < 5; i++) await tick();
      assert.ok(
        events.includes("shutdown"),
        "shutdown begins while callback is still unresolved",
      );
      assert.ok(
        !events.includes("service_stopped"),
        "no cutoff before session closure",
      );
      releaseClose();
      for (let i = 0; i < 5; i++) await tick();
      if (scenario === "uncertain") {
        assert.ok(
          !events.includes("service_stopped"),
          "unknown media state cannot claim cutoff",
        );
        assert.ok(
          !events.includes("finished"),
          "unknown media state cannot finalize accounting",
        );
      } else {
        assert.ok(events.includes("service_stopped"));
        assert.ok(
          events.indexOf(scenario === "closed" ? "closed" : "disconnected") <
            events.indexOf("service_stopped"),
        );
        assert.ok(
          !events.includes("finished"),
          "callback still held after media stopped",
        );
      }
    } finally {
      releaseClose();
      releasePost();
      await entry.catch(() => {});
      mock.restoreAll();
      process.env = saved;
    }
    assert.ok(events.includes("job_shutdown"));
  });
}
