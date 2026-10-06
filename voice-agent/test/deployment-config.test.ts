import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertVoicePairing } from "../src/config.js";
test("Worker and Node deployment must agree before provider transport admission", () => {
  for (const model of ["gpt-live-1", "gpt-realtime-2.1-mini"] as const) {
    assert.doesNotThrow(() =>
      assertVoicePairing(
        { voiceModel: model },
        { AZURE_OPENAI_LIVE_DEPLOYMENT: model },
      ),
    );
    assert.throws(() =>
      assertVoicePairing(
        { voiceModel: model },
        {
          AZURE_OPENAI_LIVE_DEPLOYMENT:
            model === "gpt-live-1" ? "gpt-realtime-2.1-mini" : "gpt-live-1",
        },
      ),
    );
  }
  assert.doesNotThrow(() => assertVoicePairing({}, {}));
  assert.throws(() =>
    assertVoicePairing(
      {},
      { AZURE_OPENAI_LIVE_DEPLOYMENT: "gpt-realtime-2.1-mini" },
    ),
  );
  assert.throws(() =>
    assertVoicePairing(
      { voiceModel: "custom" as any },
      { AZURE_OPENAI_LIVE_DEPLOYMENT: "custom" },
    ),
  );
});
test("actual renderer propagates explicit Mini and preserves default rollback, credentials and separated callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfon-render-test-"));
  try {
    const credentials = {
      LIVEKIT_API_KEY: "synthetic-lk-key",
      LIVEKIT_API_SECRET: "synthetic-lk-secret",
      OPENFON_AGENT_SERVICE_TOKEN: "synthetic-service-key",
      AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com/",
      AZURE_OPENAI_API_KEY: "synthetic-azure-key",
    };
    const credentialPath = join(directory, "credentials.json");
    await writeFile(credentialPath, JSON.stringify(credentials), {
      mode: 0o600,
    });
    const renderer = fileURLToPath(
      new URL("../deploy/render-config.py", import.meta.url),
    );
    const run = (args: string[]) =>
      spawnSync(
        "python3",
        [
          "-c",
          "import os,runpy,sys;os.chown=lambda *args:None;sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",
          renderer,
          "--environment",
          "staging",
          "--credentials",
          credentialPath,
          "--agent-image",
          "sha256:" + "a".repeat(64),
          "--root",
          join(directory, "out"),
          ...args,
        ],
        { encoding: "utf8" },
      );
    for (const args of [[], ["--voice-model", "gpt-realtime-2.1-mini"]]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes("synthetic-"));
      const file = join(directory, "out", "staging", "agent.env");
      const raw = await readFile(file, "utf8");
      const config = Object.fromEntries(
        raw
          .trim()
          .split("\n")
          .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      assert.equal(
        config.AZURE_OPENAI_LIVE_DEPLOYMENT,
        args.length ? "gpt-realtime-2.1-mini" : "gpt-live-1",
      );
      assert.equal(config.AZURE_OPENAI_TEXT_DEPLOYMENT, "gpt-5.4-mini");
      assert.equal(
        config.OPENFON_API_URL,
        "https://openfon-staging.duguetlabs.workers.dev",
      );
      assert.equal(config.LK_OPENAI_DEBUG, "0");
      for (const [key, value] of Object.entries(credentials))
        assert.equal(config[key], value);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.notEqual(run(["--voice-model", "custom"]).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
