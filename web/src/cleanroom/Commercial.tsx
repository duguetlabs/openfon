import { countryName } from "./CountrySelect";
import { useEffect, useRef, useState } from "react";
import { request, type AssistantSummary } from "../cleanroom-runtime";
import { Button, Field, Notice, Loading, Empty, errorText } from "./ui";
const money = (minor: number, currency = "EUR") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    minor / 100,
  );
interface Plan {
  id: string;
  name: string;
  monthlyMinor: number;
  annualEquivalentMinor: number;
  includedMinutes: number;
  monthlyOverageMinorPerMinute: number;
  annualOverageMinorPerMinute: number;
}
interface BillingData {
  plan: string | null;
  cadence: string | null;
  status: string;
  currency: string;
  cycle: { start: string; end: string } | null;
  usage: {
    durationMs: number;
    includedMs: number;
    overageMs: number;
    overageMinor: number;
    provisional: boolean;
  };
  plans: Plan[];
  checkoutAvailable: boolean;
  portalAvailable: boolean;
  availableCadences?: string[];
  cancellation?: { termEnd: string; status: string } | null;
  unavailableReason?: string;
}
function openCheckout(url: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname.endsWith(".dodopayments.com")
  )
    throw new Error("The payment page is unavailable. Please try again.");
  location.assign(parsed.href);
}
export function Billing() {
  const [data, setData] = useState<BillingData | null>(null);
  const [cadence, setCadence] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [invoices, setInvoices] = useState<
    { id: string; amountMinor: number; currency: string; date: string }[] | null
  >(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    request<BillingData>("/api/me/billing")
      .then((d) => {
        if (active) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  async function checkout(plan?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ url: string }>(
        plan ? "/api/me/billing/checkout" : "/api/me/billing/portal",
        "POST",
        plan ? { plan, cadence } : {},
      );
      if (mounted.current) openCheckout(result.url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function billingAction(
    action:
      | "cancel"
      | "reconcile"
      | "payment-method"
      | "payment-method/reconcile"
      | "invoices",
  ) {
    if (pending.current) return;
    if (
      action === "cancel" &&
      !confirm(
        "Stop renewing your plan? Your service remains available through your paid term. Annual plans keep monthly usage billing through that term.",
      )
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request<{
        url?: string;
        pending?: boolean;
        termEnd?: string;
        invoices?: {
          id: string;
          amountMinor: number;
          currency: string;
          date: string;
        }[];
      }>(
        `/api/me/billing/${action}`,
        action === "invoices" ? "GET" : "POST",
        action === "invoices" ? undefined : {},
      );
      if (!mounted.current) return;
      if (result.url) openCheckout(result.url);
      else if (action === "invoices") setInvoices(result.invoices || []);
      else {
        setNotice(
          result.pending
            ? "Confirmation is still pending. Please try again shortly."
            : action === "cancel"
              ? "Renewal cancellation requested. Your paid end date appears below."
              : "Billing details refreshed.",
        );
        setRevision((v) => v + 1);
      }
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="of-managed-page">
      <div className="of-page-heading">
        <div>
          <h1>Billing</h1>
          <p>A plan for your business. Prices exclude VAT.</p>
        </div>
        <Button kind="line" onClick={() => setRevision((v) => v + 1)}>
          Refresh
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {!data && !error ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="of-billing-summary">
              <h2>
                {data.plan
                  ? `${data.plans.find((p) => p.id === data.plan)?.name || "Your plan"} · ${data.status}`
                  : "Choose your plan"}
              </h2>
              {data.cycle && (
                <p>
                  {new Date(data.cycle.start).toLocaleDateString()} –{" "}
                  {new Date(data.cycle.end).toLocaleDateString()}
                </p>
              )}
              <dl>
                <dt>
                  Call minutes this billing period, including private tests
                </dt>
                <dd>{(data.usage.durationMs / 60000).toFixed(2)}</dd>
                <dt>Included minutes</dt>
                <dd>{(data.usage.includedMs / 60000).toLocaleString()}</dd>
                <dt>Additional usage</dt>
                <dd>
                  {(data.usage.overageMs / 60000).toFixed(2)} minutes ·{" "}
                  {money(data.usage.overageMinor)}
                </dd>
              </dl>
              {data.usage.provisional && (
                <p className="of-help">
                  Current usage is provisional until the billing period closes.
                </p>
              )}
              {data.cancellation && (
                <Notice>
                  Renewal cancellation{" "}
                  {data.cancellation.status === "complete"
                    ? "completed"
                    : "requested"}
                  . Your paid term ends{" "}
                  {new Date(data.cancellation.termEnd).toLocaleDateString()}.
                  Annual plans keep monthly usage billing until that date.
                </Notice>
              )}
              <div className="of-filter-bar">
                {data.portalAvailable && (
                  <Button
                    kind="line"
                    disabled={busy}
                    onClick={() => void checkout()}
                  >
                    Billing portal
                  </Button>
                )}
                {data.plan && (
                  <>
                    <Button
                      kind="line"
                      disabled={busy}
                      onClick={() => void billingAction("payment-method")}
                    >
                      Change payment method
                    </Button>
                    <Button
                      kind="line"
                      disabled={busy}
                      onClick={() =>
                        void billingAction("payment-method/reconcile")
                      }
                    >
                      Confirm payment update
                    </Button>
                    <Button
                      kind="line"
                      disabled={busy}
                      onClick={() => void billingAction("invoices")}
                    >
                      View invoices
                    </Button>
                    <Button
                      kind="line"
                      disabled={
                        busy ||
                        (!!data.cancellation &&
                          data.cancellation.status !== "preparing")
                      }
                      onClick={() => void billingAction("cancel")}
                    >
                      {data.cancellation?.status === "preparing"
                        ? "Retry cancellation confirmation"
                        : "Cancel renewal"}
                    </Button>
                  </>
                )}
                <Button
                  kind="line"
                  disabled={busy}
                  onClick={() => void billingAction("reconcile")}
                >
                  Check payment status
                </Button>
              </div>
              {invoices && (
                <section aria-label="Invoices">
                  <h3>Invoices</h3>
                  {invoices.length ? (
                    invoices.map((i) => (
                      <p key={i.id}>
                        <a
                          href={`/api/me/billing/invoices/${encodeURIComponent(i.id)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {new Date(i.date).toLocaleDateString()} ·{" "}
                          {money(i.amountMinor, i.currency)} · Download invoice
                        </a>
                      </p>
                    ))
                  ) : (
                    <p>No invoices are available yet.</p>
                  )}
                </section>
              )}
            </section>
            {data.unavailableReason && (
              <Notice>{data.unavailableReason}</Notice>
            )}
            <Field label="Billing schedule">
              <select
                value={cadence}
                disabled={busy}
                onChange={(e) => setCadence(e.target.value)}
              >
                <option value="monthly">Monthly</option>
                <option value="annual">Annual commitment</option>
              </select>
            </Field>
            <div className="of-plan-list">
              {data.plans.map((plan) => (
                <article key={plan.id}>
                  <h2>{plan.name}</h2>
                  <p className="of-plan-price">
                    {money(
                      cadence === "annual"
                        ? plan.annualEquivalentMinor
                        : plan.monthlyMinor,
                    )}
                    <span> / month</span>
                  </p>
                  {cadence === "annual" && (
                    <p>
                      {money(plan.annualEquivalentMinor * 12)} due upfront for
                      12 months, excluding VAT.
                    </p>
                  )}
                  <p>
                    {plan.includedMinutes
                      ? `${plan.includedMinutes.toLocaleString()} minutes included each month`
                      : "Pay for actual use"}
                  </p>
                  <p>
                    {money(
                      cadence === "annual"
                        ? plan.annualOverageMinorPerMinute
                        : plan.monthlyOverageMinorPerMinute,
                    )}{" "}
                    / minute
                    {plan.includedMinutes ? " after included usage" : ""}
                  </p>
                  <Button
                    disabled={
                      busy ||
                      !data.checkoutAvailable ||
                      (!!data.availableCadences &&
                        !data.availableCadences.includes(cadence))
                    }
                    onClick={() => void checkout(plan.id)}
                  >
                    Choose {plan.name}
                  </Button>
                </article>
              ))}
            </div>
            <p className="of-help">
              Prices exclude VAT. Included minutes reset each month, including
              annual plans. Additional usage is calculated monthly. Review the
              payment schedule before subscribing.
            </p>
          </>
        )
      )}
    </section>
  );
}
interface PhoneConfig {
  configured: boolean;
  numbers: {
    id: string;
    number: string;
    assistantId: string | null;
    status: string;
    enabled?: boolean;
  }[];
  provisioningAvailable: boolean;
  businessCountry: string | null;
  offers: { country:string; type:string; areaCode:string|null; status:string; canSearch:boolean }[];
  unavailableReason?: string;
}
interface Quote {
  id: string;
  number: string;
  country: string;
  type: string;
  currency: string;
  setupMinor: number;
  monthlyMinor: number;
  expiresAt: string;
  requirements: string[];
}
export function PhoneNumbers({
  assistants,
  moreAssistants,
  assistantListBusy,
  onMoreAssistants,
}: {
  assistants: AssistantSummary[];
  moreAssistants: boolean;
  assistantListBusy: boolean;
  onMoreAssistants: () => void;
}) {
  const [data, setData] = useState<PhoneConfig | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [assistant, setAssistant] = useState("");
  const [country, setCountry] = useState("");
  const [numberType, setNumberType] = useState("local");
  const [areaCode, setAreaCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    request<PhoneConfig>("/api/me/phone")
      .then((d) => {
        if (active) {
          setData(d);
          setCountry(current => current || (d.businessCountry && (d.offers ?? []).some(o=>o.country===d.businessCountry) ? d.businessCountry : ""));
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  const selectedOffer = data?.offers?.find(o=>o.country===country && o.type===numberType && (o.areaCode===null || o.areaCode===areaCode));
  async function search() {
    if (pending.current || !selectedOffer?.canSearch) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ quotes: Quote[] }>(
        "/api/me/phone/quotes",
        "POST",
        { country, type: numberType, ...(areaCode ? { areaCode } : {}) },
      );
      setQuotes(result.quotes);
      if (!result.quotes.length)
        setNotice("No numbers are available for this country right now.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function order(q: Quote) {
    if (pending.current || !assistant) return;
    if (
      !confirm(
        `Order ${q.number} for ${money(q.monthlyMinor, q.currency)} per month plus ${money(q.setupMinor, q.currency)} setup?`,
      )
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await request("/api/me/phone/orders", "POST", {
        quoteId: q.id,
        assistantId: assistant,
      });
      setQuotes([]);
      setNotice("Number order submitted. Its status appears below.");
      setRevision((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function manageNumber(
    id: string,
    next?: { assistantId: string; enabled: boolean },
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(
        next
          ? `/api/me/phone/numbers/${encodeURIComponent(id)}`
          : `/api/me/phone/orders/${encodeURIComponent(id)}/reconcile`,
        next ? "PUT" : "POST",
        next || {},
      );
      setNotice(next ? "Phone settings saved." : "Number status checked.");
      setRevision((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="of-managed-page">
      <div className="of-page-heading">
        <div>
          <h1>Phone number</h1>
          <p>Let customers reach your assistant by phone.</p>
        </div>
        <Button kind="line" onClick={() => setRevision((v) => v + 1)}>
          Refresh
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {!data && !error ? (
        <Loading />
      ) : (
        data && (
          <>
            {moreAssistants && (
              <Button kind="line" disabled={busy || assistantListBusy} onClick={onMoreAssistants}>
                {assistantListBusy ? "Loading assistants…" : "Find more assistants"}
              </Button>
            )}
            {data.numbers.length ? (
              <div>
                {data.numbers.map((n) => (
                  <article className="of-dashboard-assistant" key={n.id}>
                    <h2>{n.number}</h2>
                    <p>
                      {n.status} ·{" "}
                      {assistants.find((a) => a.id === n.assistantId)?.name ||
                        "Assistant unavailable"}
                    </p>
                    {n.status === "active" && (
                      <>
                        <p>
                          {n.enabled
                            ? "Answering calls"
                            : "Not answering calls"}
                        </p>
                        <Field label="Assistant who answers">
                          <select
                            value={n.assistantId ?? ""}
                            disabled={busy || !assistants.length}
                            onChange={(e) =>
                              void manageNumber(n.id, {
                                assistantId: e.target.value,
                                enabled: n.enabled === true,
                              })
                            }
                          >
                            <option value="" disabled>Choose an assistant</option>
                            {n.assistantId && !assistants.some(a => a.id === n.assistantId) && (
                              <option value={n.assistantId}>Current assistant</option>
                            )}
                            {assistants.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {!assistants.length && !n.assistantId && (
                          <p className="of-help">
                            Add an assistant in Settings → Assistants before assigning this number.{" "}
                            <a href="/settings/assistants">Open Assistants</a>
                          </p>
                        )}
                        <Button
                          kind="line"
                          disabled={
                            busy || !n.assistantId || (!data.provisioningAvailable && !n.enabled)
                          }
                          onClick={() =>
                            n.assistantId && void manageNumber(n.id, {
                              assistantId: n.assistantId,
                              enabled: !n.enabled,
                            })
                          }
                        >
                          {n.enabled
                            ? "Pause phone calls"
                            : "Enable phone calls"}
                        </Button>
                      </>
                    )}
                    {n.status !== "active" && (
                      <Button
                        kind="line"
                        disabled={busy}
                        onClick={() => void manageNumber(n.id)}
                      >
                        Check number status
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <Empty title="No phone number connected yet.">
                Choose a number and the assistant that should answer. Your
                public web links remain available separately.
              </Empty>
            )}
            {data.unavailableReason && (
              <Notice>{data.unavailableReason}</Notice>
            )}
            <div className="of-filter-bar">
              <Field label="Number country">
                <select
                  value={country}
                  disabled={busy}
                  onChange={(e) => {
                    setCountry(e.target.value);
                    setQuotes([]);
                  }}
                >
                  <option value="">Choose a number country</option>
                  {[...new Set((data.offers ?? []).map(o=>o.country))].map(code=><option key={code} value={code}>{countryName(code)}</option>)}
                </select>
              </Field>
              <Field label="Number type">
                <select value={numberType} disabled={busy} onChange={e=>{setNumberType(e.target.value);setQuotes([]);}}>
                  {![...new Set((data.offers ?? []).filter(o => o.country === country).map(o => o.type))].includes(numberType) && <option value={numberType}>Choose a number type</option>}
                  {[...new Set((data.offers ?? []).filter(o => o.country === country).map(o => o.type))].map(type => <option key={type} value={type}>{type === "local" ? "Local number" : "Toll-free number"}</option>)}
                </select>
              </Field>
              <Field label="Area code" hint="If your review is for a specific area, enter that area code.">
                <input inputMode="numeric" value={areaCode} disabled={busy} maxLength={6} pattern="[0-9]{1,6}" onChange={e=>{setAreaCode(e.target.value);setQuotes([]);}} />
              </Field>
              <Field label="Assistant who answers">
                <select
                  value={assistant}
                  disabled={busy}
                  onChange={(e) => setAssistant(e.target.value)}
                >
                  <option value="">Choose an assistant</option>
                  {assistants
                    .filter((a) => a.state === "active")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Button
                disabled={busy || !selectedOffer?.canSearch}
                onClick={() => void search()}
              >
                Find a number
              </Button>
            </div>
            <p className="of-help">
              Publish an assistant first. Phone requirements are reviewed for your business and chosen region before ordering.
              {selectedOffer?.status === 'under-review' && ' Your phone requirements are under review.'}
              {selectedOffer?.status === 'approved' && ' The review for this region is approved; current availability and subscription checks still apply.'}
            </p>
            {quotes.map((q) => (
              <article className="of-dashboard-assistant" key={q.id}>
                <h2>{q.number}</h2>
                <p>
                  {money(q.monthlyMinor, q.currency)} / month ·{" "}
                  {money(q.setupMinor, q.currency)} setup
                </p>
                {q.requirements.map((r) => (
                  <p key={r}>{r}</p>
                ))}
                <Button
                  disabled={
                    busy || !assistant || Date.parse(q.expiresAt) <= Date.now()
                  }
                  onClick={() => void order(q)}
                >
                  Order number
                </Button>
              </article>
            ))}
          </>
        )
      )}
    </section>
  );
}
