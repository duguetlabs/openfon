import { PLANS } from "../../../src/commercial-types";
const eur = (minor: number) =>
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: minor % 100 ? 2 : 0,
  }).format(minor / 100);
/** Static public prices share the server's immutable retail plan definition. */
export function PublicPlans() {
  return (
    <section
      className="of-public-plans"
      id="plans"
      aria-labelledby="plans-heading"
    >
      <div className="of-welcome-section-heading">
        <div>
          <p className="of-section-label">Room for your business to grow</p>
          <h2 id="plans-heading">
            A little help.
            <br />A clear price.
          </h2>
        </div>
        <p>
          Choose monthly billing or a 12-month commitment. All prices exclude
          VAT. Your account shows which plans are available to subscribe to.
        </p>
      </div>
      <div className="of-plan-list">
        {PLANS.map((plan) => (
          <article key={plan.id}>
            <h3>{plan.name}</h3>
            <p className="of-plan-price">
              {eur(plan.monthlyMinor)}
              <span> / month</span>
            </p>
            <p>
              {plan.includedMinutes
                ? `${plan.includedMinutes.toLocaleString("en")} minutes included each month`
                : "Pay for actual use"}
            </p>
            <p>
              {eur(plan.monthlyOverageMinorPerMinute)} / minute
              {plan.includedMinutes ? " after included usage" : ""}
            </p>
            <div className="of-plan-annual">
              <strong>Annual commitment</strong>
              <p>
                {eur(plan.annualEquivalentMinor)} / month ·{" "}
                {eur(plan.annualEquivalentMinor * 12)} paid upfront
              </p>
              <p>
                {eur(plan.annualOverageMinorPerMinute)} /{" "}
                {plan.includedMinutes ? "additional minute" : "minute"}
              </p>
            </div>
          </article>
        ))}
      </div>
      <p className="of-help">
        Included minutes reset monthly. Additional usage is calculated monthly,
        including annual plans. Private test calls count towards usage.
        Phone-number rental, where available, is quoted separately before you
        order.
      </p>
    </section>
  );
}
