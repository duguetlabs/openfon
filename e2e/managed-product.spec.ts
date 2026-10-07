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

test('an unassigned rented phone number accepts an explicit sole replacement before enabling calls', async ({ page }) => {
  await signup(page, 'phone-reassignment');
  const { assistant } = await createWorkspace(page, 'Phone reassignment workshop');
  let assigned: string | null = null;
  let enabled = false;
  const writes: unknown[] = [];
  await page.route('**/api/me/phone', route => route.fulfill({ json: {
    provisioningAvailable: true,
    numbers: [{ id: 'owned-rental', number: '+431234567890', status: 'active', assistantId: assigned, enabled }],
  } }));
  await page.route('**/api/me/phone/numbers/owned-rental', route => {
    const body = route.request().postDataJSON();
    writes.push(body); assigned = body.assistantId; enabled = body.enabled;
    return route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Phone number', exact: true }).click();
  const rental = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '+431234567890', exact: true }) });
  const select = rental.getByRole('combobox', { name: 'Assistant who answers' });
  await expect(select).toHaveValue('');
  await expect(rental.getByRole('button', { name: 'Enable phone calls', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
  await select.selectOption(assistant.id);
  await expect.poll(() => writes).toEqual([{ assistantId: assistant.id, enabled: false }]);
  await expect(select).toHaveValue(assistant.id);
  await expect(rental.getByRole('button', { name: 'Enable phone calls', exact: true })).toBeEnabled();
  await rental.getByRole('button', { name: 'Enable phone calls', exact: true }).click();
  await expect.poll(() => writes).toEqual([{ assistantId: assistant.id, enabled: false }, { assistantId: assistant.id, enabled: true }]);
  await expect(rental.getByText('Answering calls', { exact: true })).toBeVisible();
});

test('an unassigned rented phone number explains an empty assistant list without enabling calls', async ({ page }) => {
  await signup(page, 'phone-no-assistants');
  await createWorkspace(page, 'Empty phone workshop');
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  await page.route('**/api/me/bootstrap', route => route.fulfill({ json: { ...bootstrap, assistants: [] } }));
  await page.route('**/api/me/phone', route => route.fulfill({ json: {
    provisioningAvailable: true,
    numbers: [{ id: 'unassigned-rental', number: '+431234567891', status: 'active', assistantId: null, enabled: false }],
  } }));
  await page.goto('/settings/phone');
  const rental = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '+431234567891', exact: true }) });
  await expect(rental.getByRole('combobox', { name: 'Assistant who answers' })).toBeDisabled();
  await expect(rental.getByText('Add an assistant in Settings → Assistants before assigning this number.')).toBeVisible();
  await expect(rental.getByRole('button', { name: 'Enable phone calls', exact: true })).toBeDisabled();
});

test('inbox preserves the explicit all-calls environment across filtering and reload', async ({ page }) => {
  const reads: string[] = [];
  await page.route('**/api/me/actions?*', route => {
    const environment = new URL(route.request().url()).searchParams.get('environment') || 'live';
    reads.push(environment);
    return route.fulfill({ json: { hasMore: false, items: environment === 'all' ? [{
      id: 'private-action', call_id: 'private-call', kind: 'message', content: 'Private test message',
      caller_name: '', caller_phone: '', assistant_name: 'Reception', status: 'open', urgent: 0,
      due_at: null, created_at: '2026-10-05T00:00:00Z', environment: 'test',
    }] : [] } });
  });
  await signup(page, 'inbox-all');
  await createWorkspace(page, 'Inbox all calls');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Messages & to-dos', exact: true }).click();
  await page.getByRole('combobox', { name: 'Calls', exact: true }).selectOption('all');
  await expect(page).toHaveURL(/environment=all/);
  await expect(page.getByText('Private test message', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption('message');
  await expect(page).toHaveURL(/environment=all/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Calls', exact: true })).toHaveValue('all');
  await expect(page.getByText('Private test message', { exact: true })).toBeVisible();
  expect(reads).toContain('all');
});

test('phone settings discovers a later assistant with retry for rental and purchase selectors', async ({ page }) => {
  await signup(page, 'phone-pagination');
  const { assistant } = await createWorkspace(page, 'Phone pagination');
  const bootstrap = await (await page.request.get('/api/me/bootstrap')).json();
  const primary = bootstrap.assistants[0];
  const firstPage = Array.from({ length: 32 }, (_, index) => ({ ...primary, id: index ? `page-${index}` : assistant.id, state: 'draft' }));
  const later = { ...primary, id: 'later-owned-assistant', name: 'Later phone assistant', state: 'active' };
  await page.route('**/api/me/bootstrap', route => route.fulfill({ json: { ...bootstrap, assistants: firstPage } }));
  let fail = true;
  const offsets: string[] = [];
  await page.route(/\/api\/me\/assistants(?:\?.*)?$/, route => {
    const offset = new URL(route.request().url()).searchParams.get('offset') || '0';
    offsets.push(offset);
    if (offset === '0') return route.fulfill({ json: firstPage });
    if (fail) { fail = false; return route.fulfill({ status: 503, json: { error: 'Assistant page unavailable' } }); }
    return route.fulfill({ json: [primary, later] });
  });
  let assigned: string | null = null;
  const writes: unknown[] = [];
  await page.route('**/api/me/phone', route => route.fulfill({ json: { provisioningAvailable: true,
    numbers: [{ id: 'paged-rental', number: '+431234567892', status: 'active', assistantId: assigned, enabled: false }],
  } }));
  await page.route('**/api/me/phone/numbers/paged-rental', route => {
    const body = route.request().postDataJSON(); writes.push(body); assigned = body.assistantId;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/settings/phone');
  const more = page.getByRole('button', { name: 'Find more assistants', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.getByRole('alert')).toContainText('Assistant page unavailable');
  await more.click();
  const rental = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '+431234567892', exact: true }) });
  const rentalSelect = rental.getByRole('combobox', { name: 'Assistant who answers' });
  await expect(rentalSelect.locator(`option[value="${later.id}"]`)).toHaveCount(1);
  await expect(rentalSelect.locator(`option[value="${assistant.id}"]`)).toHaveCount(1);
  await rentalSelect.selectOption(later.id);
  await expect.poll(() => writes).toEqual([{ assistantId: later.id, enabled: false }]);
  const purchaseSelect = page.locator('.of-filter-bar').getByRole('combobox', { name: 'Assistant who answers' });
  await purchaseSelect.selectOption(later.id);
  await expect(purchaseSelect).toHaveValue(later.id);
  expect(offsets).toContain('32');
  await expect(more).toHaveCount(0);
});

test('dashboard Add assistant opens the named creation flow and keeps a cancelled choice unchanged', async ({ page }) => {
  await signup(page, 'dashboard-add');
  const { assistant: original } = await createWorkspace(page, 'Dashboard assistant creation');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  let prompts = 0;
  const creates: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/me/assistants') creates.push(request.postDataJSON());
  });
  page.once('dialog', async dialog => { prompts++; await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Add assistant', exact: true }).click();
  await expect.poll(() => prompts).toBe(1);
  expect(creates).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Your reception, at a glance.' })).toBeVisible();
  page.once('dialog', async dialog => { prompts++; await dialog.accept('Evening receptionist'); });
  await page.getByRole('button', { name: 'Add assistant', exact: true }).click();
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveValue('Evening receptionist');
  expect(creates).toEqual([{ name: 'Evening receptionist' }]);
  const assistants = await (await page.request.get('/api/me/assistants')).json();
  const made = assistants.find((item: any) => item.name === 'Evening receptionist');
  expect(made.state).toBe('draft');
  expect(assistants.some((item: any) => item.id === original.id)).toBe(true);
  expect(assistants).toHaveLength(2);
  await expect(page.getByLabel('Assistant', { exact: true })).toHaveValue(made.id);
});

// Country/eligibility and catalog controls use the real local account/application;
// only commercial availability and a historical catalog selection are projected.
test('business country stays explicit and preserves a later draft during save refresh', async ({ page }) => {
  await signup(page, 'country-draft');
  const country = page.getByRole('combobox', { name: /^Business country/ });
  await expect(country).toHaveValue('');
  await country.selectOption('AT');
  const { business } = await createWorkspace(page, 'Country workshop');
  expect(business.country).toBe('AT');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(country).toHaveValue('AT');
  await country.selectOption('DE');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let refreshSeen = false;
  await page.route('**/api/me/bootstrap', async route => {
    const response = await route.fetch();
    refreshSeen = true;
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect.poll(() => refreshSeen).toBe(true);
  await country.selectOption('CH');
  release();
  await expect(page.getByText('Business details saved.')).toBeVisible();
  await expect(country).toHaveValue('CH');
  expect((await (await page.request.get('/api/me/bootstrap')).json()).workspace.country).toBe('DE');
  await page.unroute('**/api/me/bootstrap');
  await page.getByRole('button', { name: 'Save business details', exact: true }).click();
  await expect.poll(async () => (await (await page.request.get('/api/me/bootstrap')).json()).workspace.country).toBe('CH');
});

test('phone market comes from server and area approval gates new searches', async ({ page }) => {
  await signup(page, 'phone-country');
  await createWorkspace(page, 'Phone country workshop');
  await page.route('**/api/me/phone', route => route.fulfill({ json: {
    provisioningAvailable: true, businessCountry: 'AT', numbers: [],
    offers: [{ country: 'DE', type: 'local', areaCode: '30', status: 'approved', canSearch: true }],
  } }));
  const searches: unknown[] = [];
  await page.route('**/api/me/phone/quotes', route => {
    searches.push(route.request().postDataJSON());
    return route.fulfill({ json: { quotes: [] } });
  });
  await page.goto('/settings/phone');
  const country = page.getByRole('combobox', { name: 'Number country', exact: true });
  await expect(country).toHaveValue('');
  await expect(country.locator('option')).toHaveText(['Choose a number country', 'Germany']);
  await country.selectOption('DE');
  const find = page.getByRole('button', { name: 'Find a number', exact: true });
  await expect(find).toBeDisabled();
  await page.getByLabel(/^Area code/).fill('30');
  await expect(find).toBeEnabled();
  await find.click();
  await expect.poll(() => searches).toEqual([{ country: 'DE', type: 'local', areaCode: '30' }]);
  await page.getByLabel(/^Area code/).fill('40');
  await expect(find).toBeDisabled();
});

test('unsupported saved voice requires an acknowledged save before testing or publishing', async ({ page }) => {
  await signup(page, 'saved-voice');
  const { assistant } = await createWorkspace(page, 'Saved voice workshop');
  expect((await page.request.put(`/api/me/assistants/${assistant.id}`, { data: { name: 'Reception', persona: 'Warm and helpful', language: 'en' } })).ok()).toBe(true);
  await page.route('**/api/me/voices', route => route.fulfill({ json: { voices: ['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar'].map(id => ({ id, label: id })), defaultVoice: 'marin' } }));
  let saved = false;
  const writes: unknown[] = [];
  await page.route(`**/api/me/assistants/${assistant.id}`, async route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      const response = await route.fetch();
      saved = response.ok();
      await route.fulfill({ response });
    } else {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), ...(saved ? {} : { voice: 'arbor' }) } });
    }
  });
  await page.goto(`/assistants/${assistant.id}`);
  const start = page.getByRole('button', { name: 'Start browser conversation', exact: true });
  const publish = page.getByRole('button', { name: 'Enable web calls', exact: true });
  await expect(page.getByText('Choose an available voice in ‘Who answers’ and save it before testing or publishing.', { exact: true }).first()).toBeVisible();
  await expect(start).toBeDisabled();
  await expect(publish).toBeDisabled();
  await whoAnswers(page);
  const voice = page.getByRole('combobox', { name: 'Voice', exact: true });
  await expect(voice).toHaveValue('arbor');
  expect(writes).toEqual([]);
  await voice.selectOption('cedar');
  await expect(start).toBeDisabled();
  await expect(publish).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(start).toBeEnabled();
  await expect(publish).toBeEnabled();
  expect(writes).toEqual([{ voice: 'cedar' }]);
});

test('catalog retry preserves edits and an unavailable catalog never prevents pausing', async ({ page }) => {
  await signup(page, 'voice-retry');
  const { assistant } = await createWorkspace(page, 'Voice retry workshop');
  expect((await page.request.put(`/api/me/assistants/${assistant.id}`, { data: { name: 'Reception', persona: 'Warm and helpful', language: 'en' } })).ok()).toBe(true);
  expect((await page.request.post(`/api/me/assistants/${assistant.id}/activate`)).ok()).toBe(true);
  let failures = true;
  await page.route('**/api/me/voices', async route => {
    if (failures) return route.fulfill({ status: 503, json: { error: 'Voice choices unavailable. Retry shortly.' } });
    await route.continue();
  });
  await page.goto(`/assistants/${assistant.id}`);
  await whoAnswers(page);
  await expect(page.getByRole('button', { name: 'Retry voice choices', exact: true })).toBeVisible();
  const pause = page.getByRole('button', { name: 'Pause web calls', exact: true });
  await expect(pause).toBeEnabled();
  await pause.click();
  await expect(page.getByRole('button', { name: 'Enable web calls', exact: true })).toBeDisabled();
  await page.getByLabel('Receptionist name', { exact: true }).fill('Retained draft');
  failures = false;
  await page.getByRole('button', { name: 'Retry voice choices', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Voice', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Receptionist name', { exact: true })).toHaveValue('Retained draft');
  await expect(page.getByRole('button', { name: 'Start browser conversation', exact: true })).toBeDisabled();
});
