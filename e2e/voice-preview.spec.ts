import { signup, createWorkspace, whoAnswers } from "./cleanroom-helpers";
import { test, expect } from "./fixtures";
import { pcmWav } from "../src/voice-preview";

test("voice samples preserve selected identity, cancel stale audio, cache lazily and never save the draft", async ({
  page,
}) => {
  await page.route("**/api/me/voices", (route) =>
    route.fulfill({
      json: {
        voices: ["marin", "cedar", "ash"].map((id) => ({
          id,
          label: id[0].toUpperCase() + id.slice(1),
        })),
        defaultVoice: "marin",
      },
    }),
  );
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    (window as any).sampleAudio = [];
    window.Audio = class extends NativeAudio {
      constructor(src?: string) {
        super(src);
        (window as any).sampleAudio.push(this);
      }
    };
  });
  await signup(page, "preview");
  const { assistant } = await createWorkspace(page, "Voice sample workshop");
  const baseline = await (
    await page.request.get(`/api/me/assistants/${assistant.id}`)
  ).json();
  const requests: any[] = [];
  let held: (() => Promise<void>) | undefined;
  let mode = "held";
  const pcm = new Uint8Array(48000 * 4),
    view = new DataView(pcm.buffer);
  for (let i = 0; i < pcm.length / 2; i++)
    view.setInt16(i * 2, Math.sin((i * 2 * Math.PI * 440) / 24000) * 200, true);
  const wav = Buffer.from(pcmWav(pcm));
  await page.route("**/voice-preview", async (route) => {
    requests.push(route.request().postDataJSON());
    const fulfill = () =>
      route
        .fulfill({ status: 200, contentType: "audio/wav", body: wav })
        .catch(() => {});
    if (mode === "held") held = fulfill;
    else if (mode === "error")
      await route.fulfill({
        status: 502,
        json: { error: "Sample temporarily unavailable." },
      });
    else if (mode === "oversize")
      await route.fulfill({
        status: 200,
        contentType: "audio/wav",
        body: Buffer.alloc(960045),
      });
    else await fulfill();
  });
  await whoAnswers(page);
  const voice = page.getByRole("combobox", { name: "Voice", exact: true });
  const play = page.getByRole("button", {
    name: "Play voice sample",
    exact: true,
  });
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("de");
  await voice.selectOption("marin");
  await page.waitForTimeout(300);
  expect(requests).toHaveLength(0);
  await play.click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ voice: "marin", language: "de" });
  await page.getByRole("button", { name: "Cancel voice sample" }).click();
  await held!();
  await expect(play).toBeEnabled();
  expect(await page.evaluate(() => (window as any).sampleAudio.length)).toBe(0);
  mode = "success";
  await play.click();
  await expect.poll(() => requests.length).toBe(2);
  await expect(
    page.getByRole("button", { name: "Stop voice sample" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).sampleAudio[0]?.currentTime || 0),
    )
    .toBeGreaterThan(0);
  await voice.selectOption("cedar");
  expect(await page.evaluate(() => (window as any).sampleAudio[0].paused)).toBe(
    true,
  );
  await play.click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toEqual({ voice: "cedar", language: "de" });
  await page.getByRole("button", { name: "Stop voice sample" }).click();
  await play.click();
  await page.getByRole("button", { name: "Stop voice sample" }).click();
  expect(requests).toHaveLength(3); // repeat playback reuses selected sample
  mode = "held";
  await voice.selectOption("ash");
  await play.click();
  await expect.poll(() => requests.length).toBe(4);
  await voice.selectOption("marin");
  await held!();
  await expect(play).toBeEnabled();
  expect(await page.evaluate(() => (window as any).sampleAudio[0].paused)).toBe(
    true,
  );
  // A new language is a new sample; failures and oversized responses are never cached.
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("fr");
  mode = "error";
  await play.click();
  await expect(page.getByRole("alert")).toContainText(
    "Sample temporarily unavailable",
  );
  mode = "oversize";
  await play.click();
  await expect(page.getByRole("alert")).toContainText(
    "Voice sample is too large",
  );
  mode = "success";
  await play.click();
  await expect(
    page.getByRole("button", { name: "Stop voice sample" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("voice-sample-mobile.png"),
    fullPage: true,
  });
  expect(
    await (await page.request.get(`/api/me/assistants/${assistant.id}`)).json(),
  ).toEqual(baseline);
  await expect(voice.locator('option[value="marin"]')).toHaveText("Marin");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Call logs", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).sampleAudio[0].paused)).toBe(
    true,
  );
});

test("nonmanaged deployments retain provider-aware choices and full preview payload", async ({
  page,
}) => {
  await page.route("**/api/me/voices", (r) =>
    r.fulfill({ json: { native: [], azure: [], hdDefault: "" } }),
  );
  await page.route("**/api/me/provider/catalog", (r) =>
    r.fulfill({
      json: {
        models: [],
        live: false,
        voices: {
          native: [],
          realtime: {},
          cataloguedModels: [],
          azure: [],
          hdDefault: "",
        },
        backends: [],
        routing: {},
      },
    }),
  );
  await signup(page, "legacy-preview");
  const { assistant } = await createWorkspace(page, "Legacy preview");
  expect(
    (
      await page.request.put(`/api/me/assistants/${assistant.id}`, {
        data: {
          name: "Legacy receptionist",
          engine: "realtime",
          realtime_model: "gpt-realtime-2.1-mini",
          realtime_voice: "cedar",
        },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await whoAnswers(page);
  await expect(
    page.getByRole("combobox", { name: "Voice", exact: true }),
  ).toHaveValue("cedar");
  let payload: any;
  await page.route("**/voice-preview", (r) => {
    payload = r.request().postDataJSON();
    return r.fulfill({
      status: 503,
      json: { error: "Synthetic legacy preview boundary" },
    });
  });
  await page
    .getByRole("combobox", { name: "Voice", exact: true })
    .selectOption("marin");
  await page
    .getByRole("button", { name: "Listen to a sample", exact: true })
    .click();
  await expect.poll(() => payload?.realtime_voice).toBe("marin");
  expect(payload).toMatchObject({
    engine: "realtime",
    realtime_model: "gpt-realtime-2.1-mini",
    realtime_voice: "marin",
    language: "en",
  });
  expect(Object.keys(payload).sort()).toEqual([
    "engine",
    "language",
    "realtime_model",
    "realtime_voice",
    "voice",
  ]);
  expect(
    (
      await (
        await page.request.get(`/api/me/assistants/${assistant.id}`)
      ).json()
    ).realtime_voice,
  ).toBe("cedar");
  // A voice-only change must be admitted by dirty tracking and persist for calls.
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toBeEnabled();
  const savedRequest = page.waitForRequest((request) =>
    request.method() === "PUT" && request.url().endsWith(`/api/me/assistants/${assistant.id}`));
  await save.click();
  expect((await savedRequest).postDataJSON()).toEqual({ realtime_voice: "marin" });
  await expect(page.getByText("Saved. Your next conversation will use this brief.")).toBeVisible();
  await page.reload();
  await whoAnswers(page);
  await expect(page.getByRole("combobox", { name: "Voice", exact: true })).toHaveValue("marin");
});
