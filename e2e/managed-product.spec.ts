import { signup, createWorkspace, whoAnswers } from "./cleanroom-helpers";
import { test, expect } from "./fixtures";

// Real local Worker, migrations, account ownership and managed flag. Payment and
// telephone availability fixtures are synthetic; no provider, card or carrier call.
test("managed customer navigation, isolation and API responses hide technical routing", async ({
  page,
  browser,
}) => {
  await signup(page, "managed");
  const { assistant } = await createWorkspace(page, "Managed workshop");
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button"),
  ).toHaveText([
    "Home",
    "Messages & to-dos",
    "Call logs",
    "Settings",
    "Billing",
  ]);
  await whoAnswers(page);
  await expect(
    page.getByRole("combobox", { name: "Voice", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Play voice sample" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("managed-assistant-desktop.png"),
    fullPage: true,
  });
  const customer = await (
    await page.request.get(`/api/me/assistants/${assistant.id}`)
  ).json();
  expect(customer.engine).toBe("");
  expect(customer.realtime_voice).toBe("");
  for (const field of [
    "realtime_model",
    "llm_model",
    "provider_id",
    "llm_base_url",
    "llm_api_key",
  ])
    expect(customer[field]).toBeUndefined();
  for (const path of [
    "/api/me/provider",
    "/api/me/engine-presets",
    "/api/me/call-summaries",
  ])
    expect((await page.request.get(path)).status()).toBe(404);
  expect(
    (
      await page.request.put(`/api/me/assistants/${assistant.id}`, {
        data: { engine: "pipeline" },
      })
    ).status(),
  ).toBe(400);
  await page.getByLabel("Receptionist name", { exact: true }).fill("Ada");
  await page
    .getByLabel("Their first words")
    .fill("Hello from our managed workshop.");
  await page.getByRole("combobox", { name: "Voice", exact: true }).selectOption("cedar");
  const saveRequest = page.waitForRequest((request) =>
    request.method() === "PUT" && request.url().endsWith(`/api/me/assistants/${assistant.id}`));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saveRequest).postDataJSON()).toEqual({
    name: "Ada", greeting: "Hello from our managed workshop.", voice: "cedar",
  });
  await expect(
    page.getByText("Saved. Your next conversation will use this brief."),
  ).toBeVisible();
  const peer = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const other = await peer.newPage();
  try {
    await signup(other, "managed-peer");
    await createWorkspace(other, "Other workshop");
    expect(
      (await other.request.get(`/api/me/assistants/${assistant.id}`)).status(),
    ).toBe(404);
  } finally {
    await peer.close();
  }
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your reception, at a glance." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /0 Calls this week/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /0 Booking requests/ }).click();
  await expect(page).toHaveURL(/kind=booking_request/);
  await expect(
    page.getByRole("heading", { name: "Messages & to-dos" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Call logs", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Call logs", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page.getByLabel("Business name", { exact: true })).toHaveValue(
    "Managed workshop",
  );
  await page
    .getByLabel("Contact email", { exact: true })
    .fill("contact@example.invalid");
  await page
    .getByRole("button", { name: "Save business details", exact: true })
    .click();
  await expect(page.getByText("Business details saved.")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("managed-business-mobile.png"),
    fullPage: true,
  });
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(
    /Kataleptic|Azure|gpt-|engine|provider|endpoint|API key/i,
  );
});

test("action inbox links each task to its call and billing/phone never imply unavailable services work", async ({
  page,
}) => {
  await signup(page, "managed-actions");
  await createWorkspace(page, "Action workshop");
  const rows = [
    {
      id: "task-one",
      call_id: "source-one",
      kind: "booking_request",
      content: "An appointment for next Monday, not yet confirmed.",
      caller_name: "Ada",
      caller_phone: "+431234567",
      assistant_name: "Reception",
      status: "open",
      urgent: 1,
      due_at: null,
      created_at: "2026-10-05T10:00:00Z",
      environment: "live",
    },
    {
      id: "task-two",
      call_id: "source-one",
      kind: "message",
      content: "Please send the opening hours.",
      caller_name: "Ada",
      caller_phone: "",
      assistant_name: "Reception",
      status: "open",
      urgent: 0,
      due_at: null,
      created_at: "2026-10-05T10:00:00Z",
      environment: "live",
    },
  ];
  let updated = 0;
  await page.route("**/api/me/actions?*", (route) =>
    route.fulfill({ json: { items: rows, hasMore: false } }),
  );
  await page.route("**/api/me/actions/task-one", (route) => {
    updated++;
    expect(route.request().postDataJSON()).toEqual({ status: "handled" });
    return route.fulfill({ json: { ok: true } });
  });
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Messages & to-dos", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "View source call" }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "Mark handled" }).first().click();
  await expect(
    page.getByRole("button", { name: "View source call" }),
  ).toHaveCount(1);
  expect(updated).toBe(1);
  await page.route("**/api/me/calls/source-one", (route) =>
    route.fulfill({
      json: {
        id: "source-one",
        status: "completed",
        channel: "web",
        environment: "live",
        duration_s: 42,
        started_at: "2026-10-05T10:00:00Z",
        summary: "Caller asked about appointments and opening hours.",
        turns: [],
      },
    }),
  );
  await page.getByRole("button", { name: "View source call" }).click();
  await expect(page).toHaveURL(/call=source-one/);
  await expect(
    page.getByRole("heading", { name: "What was said" }),
  ).toBeVisible();
  await page.route("**/api/me/billing", (route) =>
    route.fulfill({
      json: {
        plan: null,
        cadence: null,
        status: "unconfigured",
        currency: "EUR",
        cycle: null,
        usage: {
          durationMs: 0,
          includedMs: 0,
          overageMs: 0,
          overageMinor: 0,
          provisional: true,
        },
        plans: [
          {
            id: "small",
            name: "Small",
            monthlyMinor: 6900,
            annualEquivalentMinor: 5800,
            includedMinutes: 500,
            monthlyOverageMinorPerMinute: 9,
            annualOverageMinorPerMinute: 8,
          },
        ],
        checkoutAvailable: false,
        availableCadences: [],
        portalAvailable: false,
        unavailableReason: "Subscriptions are not available yet.",
      },
    }),
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Billing", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose Small" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Billing schedule" })
    .selectOption("annual");
  await expect(page.getByText(/696.*due upfront/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("managed-billing-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("managed-billing-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(
    page.getByRole("button", { name: "Change payment method" }),
  ).toHaveCount(0);
  await page.route("**/api/me/phone", (route) =>
    route.fulfill({
      json: {
        configured: false,
        numbers: [],
        provisioningAvailable: false,
        unavailableReason: "Phone setup is not available yet.",
      },
    }),
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Phone number", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Find a number" }),
  ).toBeDisabled();
  await expect(page.getByText("No phone number connected yet.")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(
    /Telnyx|Azure|Kataleptic|gpt-|API key|engine|provider/i,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

// Synthetic billing lifecycle responses validate customer recovery and navigation,
// not actual checkout, card update, renewal cancellation or invoice settlement.
test("billing provides explicit cancellation and payment reconciliation without auto-charging", async ({
  page,
}) => {
  await signup(page, "billing-recovery");
  await createWorkspace(page, "Billing workshop");
  let cancellation: null | { termEnd: string; status: string } = null;
  await page.route("**/api/me/billing", (r) =>
    r.fulfill({
      json: {
        plan: "small",
        cadence: "annual",
        status: "active",
        currency: "EUR",
        cycle: null,
        usage: {
          durationMs: 61000,
          includedMs: 30000000,
          overageMs: 0,
          overageMinor: 0,
          provisional: true,
        },
        plans: [],
        checkoutAvailable: false,
        availableCadences: [],
        portalAvailable: false,
        cancellation,
      },
    }),
  );
  let cancels = 0,
    payments = 0;
  await page.route("**/api/me/billing/cancel", (r) => {
    cancels++;
    cancellation = { termEnd: "2027-10-05T00:00:00Z", status: "scheduled" };
    return r.fulfill({
      json: { scheduled: true, termEnd: cancellation.termEnd },
    });
  });
  await page.route("**/api/me/billing/payment-method/reconcile", (r) => {
    payments++;
    return r.fulfill({ json: { updated: false, pending: true } });
  });
  await page.route("**/api/me/billing/invoices", (r) =>
    r.fulfill({
      json: {
        invoices: [
          {
            id: "invoice-safe",
            amountMinor: 69600,
            currency: "EUR",
            date: "2026-10-05T00:00:00Z",
          },
        ],
      },
    }),
  );
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Billing", exact: true })
    .click();
  expect(cancels).toBe(0);
  expect(payments).toBe(0);
  await expect(
    page.getByRole("button", { name: "Billing portal" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "View invoices" }).click();
  await expect(
    page.getByRole("link", { name: /Download invoice/ }),
  ).toHaveAttribute("href", "/api/me/billing/invoices/invoice-safe");
  await page.getByRole("button", { name: "Confirm payment update" }).click();
  await expect(
    page.getByText("Confirmation is still pending. Please try again shortly."),
  ).toBeVisible();
  expect(payments).toBe(1);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Cancel renewal" }).click();
  await expect(page.getByText(/Your paid term ends/)).toBeVisible();
  expect(cancels).toBe(1);
  await expect(
    page.getByRole("button", { name: "Cancel renewal" }),
  ).toBeDisabled();
});

test("inbox pagination retains unseen tasks after handling loaded items", async ({ page }) => {
  const items = Array.from({ length: 175 }, (_, index) => ({
    id: `task-${index + 1}`, call_id: "synthetic-call", kind: "todo",
    content: `Pagination task ${index + 1}`, caller_name: "Caller", caller_phone: "",
    assistant_name: "Reception", status: "open", urgent: 0, due_at: null,
    created_at: "2026-10-05T00:00:00Z", environment: "live",
  }));
  const offsets: number[] = [];
  let holdMutation = false;
  let finishMutation: (() => Promise<void>) | undefined;
  let finishPage: (() => Promise<void>) | undefined;
  await page.route("**/api/me/actions**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH") {
      const item = items.find(item => item.id === url.pathname.split("/").pop())!;
      const finish = async () => {
        Object.assign(item, request.postDataJSON());
        await route.fulfill({ json: { ok: true } });
      };
      if (holdMutation) finishMutation = finish;
      else await finish();
      return;
    }
    const offset = Number(url.searchParams.get("offset") || 0);
    offsets.push(offset);
    const finish = async () => {
      const open = items.filter(item => item.status === "open");
      await route.fulfill({ json: { items: open.slice(offset, offset + 50), hasMore: open.length > offset + 50 } });
    };
    if (holdMutation && offset > 0) finishPage = finish;
    else await finish();
  });
  await signup(page, "inbox-pagination");
  await createWorkspace(page, "Inbox pagination");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Messages & to-dos", exact: true }).click();
  const more = page.getByRole("button", { name: "Load more items" });
  await more.click();
  await expect(page.locator(".of-action-row")).toHaveCount(100);
  await page.getByRole("button", { name: "Mark handled", exact: true }).first().click();
  await expect(page.locator(".of-action-row")).toHaveCount(99);
  await more.click();
  await expect(page.getByText("Pagination task 101", { exact: true })).toBeVisible();
  await expect(page.locator(".of-action-row")).toHaveCount(149);
  expect(offsets).toEqual([0, 50, 99]);

  // Exercise ordinary overlap: a save is slow while the user requests another page.
  holdMutation = true;
  await page.getByRole("button", { name: "Mark handled", exact: true }).first().click();
  await expect.poll(() => Boolean(finishMutation)).toBe(true);
  if (await more.isEnabled()) {
    await more.click();
    await expect.poll(() => Boolean(finishPage)).toBe(true);
    await finishMutation!();
    await finishPage!();
  } else {
    await finishMutation!();
    await expect(page.locator(".of-action-row")).toHaveCount(148);
    holdMutation = false;
    await more.click();
  }
  await expect(more).toHaveCount(0);
  await expect(page.getByText("Pagination task 151", { exact: true })).toBeVisible();
  await expect(page.locator(".of-action-row")).toHaveCount(173);
});

for (const change of ["clear urgency", "move overdue date"] as const) {
  test(`priority pagination uses server membership after ${change}`, async ({ page }) => {
    const past = "2000-01-01T23:59:59.000Z", future = "2099-01-01T23:59:59.000Z";
    const items = Array.from({ length: 75 }, (_, index) => ({
      id: `priority-${index + 1}`, call_id: "synthetic-call", kind: "todo",
      content: `Priority task ${index + 1}`, caller_name: "Caller", caller_phone: "",
      assistant_name: "Reception", status: "open", urgent: index === 0 && change === "move overdue date" ? 0 : 1,
      due_at: index < 2 ? past : future, created_at: "2026-10-05T00:00:00Z", environment: "live",
    }));
    if (change === "clear urgency") items[0].due_at = future;
    await page.route("**/api/me/actions**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === "PATCH") {
        Object.assign(items.find(item => item.id === url.pathname.split("/").pop())!, request.postDataJSON());
        await route.fulfill({ json: { ok: true } });
        return;
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      const selected = items.filter(item => item.status === "open" &&
        (url.searchParams.get("urgent") !== "true" || item.urgent === 1 || Date.parse(item.due_at) < Date.now()));
      await route.fulfill({ json: { items: selected.slice(offset, offset + 50), hasMore: selected.length > offset + 50 } });
    });
    await signup(page, "priority-pagination");
    await createWorkspace(page, "Priority pagination");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Messages & to-dos", exact: true }).click();
    await page.getByRole("combobox", { name: "Priority", exact: true }).selectOption("true");
    const row = (n: number) => page.locator(".of-action-row").filter({ has: page.getByText(`Priority task ${n}`, { exact: true }) });
    const more = page.getByRole("button", { name: "Load more items" });
    await expect(page.locator(".of-action-row")).toHaveCount(50);
    async function mutate(n: number) {
      const response = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(`/priority-${n}`));
      if (change === "clear urgency") await row(n).getByRole("checkbox", { name: "Urgent", exact: true }).click();
      else await row(n).getByLabel("Due date", { exact: true }).fill("2099-01-01");
      await response;
      await expect(more).toBeEnabled();
    }
    // Clearing urgency retains an overdue item; moving a date retains an urgent one.
    await mutate(2);
    await expect(row(2)).toBeVisible();
    await mutate(1);
    await more.click();
    await expect(more).toHaveCount(0);
    await expect(row(51)).toBeVisible();
    await expect(row(1)).toHaveCount(0);
    await expect(row(2)).toBeVisible();
    await expect(page.locator(".of-action-row")).toHaveCount(74);
  });
}
