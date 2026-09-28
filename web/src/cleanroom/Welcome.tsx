/**
 * THESIS: A warm welcome becomes a clear next step, using the user-selected identity page.
 * OWN-WORLD: Blue spread, exact inverse wordmark, Lilita400, Nunito Sans, butter message slip.
 * STORY: Teach the business, try a browser conversation, review what callers needed.
 * FIRST VIEWPORT: Headline and setup left; caller, open curve and illustrative message right.
 * FORM: Direct adaptation of docs/brand/identity/index.html; no new design selection.
 */
import { useState, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./ui";
import { Icon } from "./icons";
import "./welcome.css";

const stages = [
  {
    label: "You keep doing your thing",
    short: "Your work",
    title: "Hands busy. Door open.",
    description:
      "A customer has a question while you’re in the middle of helping someone else.",
  },
  {
    label: "OpenFon handles the hello",
    short: "The conversation",
    title: "Your details. A helpful answer.",
    description:
      "Your AI voice receptionist answers from the business information you provide, then offers to take a message.",
  },
  {
    label: "You get the next step",
    short: "Your follow-up",
    title: "The important part, waiting for you.",
    description:
      "The caller’s request becomes a message you can review and follow up on when you’re ready.",
  },
];
export function WorkshopImage({
  className = "",
  eager = false,
}: {
  className?: string;
  eager?: boolean;
}) {
  return (
    <picture className={className}>
      <source
        type="image/webp"
        srcSet="/media/openfon/workshop-hero-480.webp 480w, /media/openfon/workshop-hero-768.webp 768w, /media/openfon/workshop-hero-1200.webp 1200w, /media/openfon/workshop-hero-1536.webp 1536w"
        sizes="(max-width:720px) 100vw, 65vw"
      />
      <img
        src="/media/openfon/workshop-hero-1200.webp"
        alt="A bicycle mechanic keeps working with both hands on a bicycle wheel in her sunlit workshop."
        width={1536}
        height={1024}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}

export function VisualStory({ compact = false }: { compact?: boolean }) {
  const [stage, setStage] = useState(0);
  const [changed, setChanged] = useState(false);
  const steps = useRef<(HTMLButtonElement | null)[]>([]);
  function select(next: number, moveFocus = false) {
    setStage(next);
    setChanged(true);
    if (moveFocus) steps.current[next]?.focus();
  }
  return (
    <section
      className={`of-visual-story ${compact ? "compact" : ""}`}
      aria-label="How OpenFon works"
    >
      <div className="of-story-rail">
        <span className="of-story-example">
          <i />
          Illustrative example
        </span>
        <span>Harbour Bicycle Workshop</span>
      </div>
      <div
        className={`of-story-scene step-${stage} ${changed ? "has-changed" : ""}`}
      >
        <div className="of-story-photo">
          <WorkshopImage eager />
          <div className="of-owner-caption">
            <span>Meanwhile, at the workshop</span>
            <strong>The work keeps moving.</strong>
          </div>
          <div className="of-caller-prompt">
            <span className="of-caller-symbol">
              <Icon name="phone" size={21} />
            </span>
            <div>
              <small>A customer asks</small>
              <p>“Can I bring my bike in on Saturday?”</p>
            </div>
          </div>
        </div>
        <div className="of-story-conversation">
          <div className="of-story-brand">
            <img className="of-story-wave" src="/brand/openfon-mark-inverse.svg" width="26" height="26" alt="" />
            OpenFon<span>AI voice receptionist</span>
          </div>
          <div className="of-story-content" key={stage} aria-live="polite">
            <div className="of-story-current">
              <span>
                {stage === 0
                  ? "The moment"
                  : stage === 1
                    ? "From question to answer"
                    : "From conversation to follow-up"}
              </span>
              <h2>{stages[stage].title}</h2>
            </div>
            {stage === 0 ? (
              <div className="of-story-incoming">
                <div className="of-business-note">
                  <Icon name="book" />
                  <div>
                    <strong>The business brief</strong>
                    <p>
                      Saturday · 9am–1pm
                      <br />
                      Bicycle servicing & repairs
                    </p>
                  </div>
                </div>
                <p className="of-story-explainer">
                  You give OpenFon the details a helpful colleague would need.
                </p>
                <button
                  className="of-story-next"
                  onClick={() => select(1, true)}
                >
                  See how it answers
                  <Icon name="arrow" size={18} />
                </button>
              </div>
            ) : stage === 1 ? (
              <>
                <div className="of-fact-citation">
                  <Icon name="book" size={16} />
                  <span>
                    From the brief: <strong>Saturday, 9am–1pm</strong>
                  </span>
                </div>
                <div className="of-example-answer">
                  <p>
                    “Yes, we’re open Saturday from 9am to 1pm. Would you like me
                    to take a message for the team?”
                  </p>
                </div>
                <div className="of-customer-reply">
                  <span>The caller</span>“Please ask them to call me about a
                  brake service.”
                </div>
                <button
                  className="of-story-next"
                  onClick={() => select(2, true)}
                >
                  See the message
                  <Icon name="arrow" size={18} />
                </button>
              </>
            ) : (
              <div className="of-message-paper">
                <div>
                  <Icon name="message" size={21} />
                  <span>Message for the team</span>
                </div>
                <h3>Alex would like a call back.</h3>
                <p>Asking about a brake service this Saturday.</p>
                <dl>
                  <dt>Caller</dt>
                  <dd>Alex Morgan</dd>
                  <dt>Next step</dt>
                  <dd>Return their call</dd>
                  <dt>Callback</dt>
                  <dd>+43 ••• ••• 482</dd>
                </dl>
                <span className="of-example-footnote">
                  Example message · no real call was made
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="of-story-steps">
        {stages.map((item, index) => (
          <button
            ref={(element) => {
              steps.current[index] = element;
            }}
            key={item.short}
            className={stage === index ? "selected" : ""}
            aria-pressed={stage === index}
            onClick={() => select(index)}
          >
            <span className="of-step-track">
              <i>
                {index < stage ? <Icon name="check" size={15} /> : index + 1}
              </i>
              <b />
            </span>
            <span>
              <strong>{item.short}</strong>
              <small>{item.label}</small>
            </span>
          </button>
        ))}
      </div>
      <p className="of-story-caption">{stages[stage].description}</p>
    </section>
  );
}

export function WelcomeMessage() {
  return (
    <div className="of-welcome-example">
      <p className="of-welcome-question">“Can you help<br />with a repair?”</p>
      <svg className="of-welcome-connection" viewBox="0 0 300 95" aria-hidden="true"><path d="M20 4C20 91 263 0 263 83M248 70L263 84L280 71" /></svg>
      <article className="of-welcome-slip">
        <h2>A message, clearly left.</h2>
        <p>“My bike needs a repair. Please call me back this afternoon.”</p>
        <div><span>Callback requested</span><Icon name="arrow" size={20} /></div>
      </article>
      <p className="of-welcome-example-note">Illustrative example · A request, not a completed callback.</p>
    </div>
  );
}

export function Welcome({ brand, onCreate, onSignIn, onBack, inApp = false }: {
  brand: ReactNode;
  onCreate: () => void;
  onSignIn?: () => void;
  onBack?: () => void;
  inApp?: boolean;
}) {
  const Content = inApp ? "div" : "main";
  return (
    <div className={`of-welcome ${inApp ? "in-app" : ""}`}>
      {!inApp && <header className="of-welcome-nav">
        {brand}
        <nav aria-label="Welcome navigation">
          <a href="#how-openfon-works">How it works</a>
          <button className="of-welcome-signin" onClick={onSignIn}>Sign in</button>
        </nav>
      </header>}
      <Content className="of-welcome-main">
        <section className="of-welcome-lead" aria-labelledby="welcome-title">
          <div className="of-welcome-copy">
            {inApp ? <button className="of-welcome-return" onClick={onBack}><Icon name="back" size={18} />Back to your desk</button> : <p className="of-welcome-kicker">A little help at the front desk</p>}
            <h1 id="welcome-title">A warm welcome.<br /><span>A clear next step.</span></h1>
            <p className="of-welcome-descriptor">An AI receptionist for small businesses.<br />A little room to focus on the work in front of you.</p>
            <Button onClick={onCreate}>{inApp ? "Back to my receptionist" : "Create your receptionist"}<Icon name="arrow" size={18} /></Button>
            <p className="of-welcome-detail">Teach it your business. Try a conversation in your browser.</p>
          </div>
          <WelcomeMessage />
        </section>
        <div className="of-welcome-principles"><span>Your business, in your own words.</span><span>Try it before you share it.</span><span>See what callers needed.</span></div>
        <section className="of-welcome-explanation" id="how-openfon-works" aria-labelledby="work-title">
          <div className="of-welcome-section-heading"><div><p className="of-section-label">For the people doing the work</p><h2 id="work-title">Keep your hands<br />on your business.</h2></div><p>Give your receptionist the details callers ask about. An answer from your business information can become a message for you to follow up.</p></div>
          <VisualStory />
          <p className="of-workshop-disclosure">AI-generated workshop scene and illustrative dialogue. No customer or live call is depicted.</p>
        </section>
        <section className="of-welcome-close">
          <div><p className="of-section-label">Set it up around the business</p><h2>Your business.<br />Your way of saying hello.</h2><p>Choose the welcome, add the information callers need, then try your receptionist before sharing its web call link.</p></div>
          <div className="of-portable-note"><h3>Your setup comes with you.</h3><p>Choose compatible text and voice providers, including Kataleptic. Export your receptionist’s behavior and voice choices as a portable recipe.</p><button className="of-text-button" onClick={onCreate}>{inApp ? "Return to your receptionist" : "Get started"}<Icon name="arrow" size={18} /></button></div>
        </section>
        {!inApp && <footer className="of-welcome-footer"><img className="of-brand" src="/brand/openfon-logo.svg" width="247" height="80" alt="OpenFon" /><span>A warm welcome. A clear next step.</span><button onClick={onSignIn}>Already have an account? Sign in<Icon name="arrow" size={16} /></button></footer>}
      </Content>
    </div>
  );
}

export function DeskIntroduction({ onStory, onDismiss, stateLabel }: { onStory: () => void; onDismiss: () => void; stateLabel: string }) {
  return <div className="of-desk-introduction">
    <div className="of-intro-copy"><span className="of-intro-label">Your reception desk</span><h1>More time for your business.</h1><p>Teach your receptionist. Try a conversation. Review what callers needed.</p><div className="of-intro-actions"><button className="of-intro-link" onClick={onStory}>See how OpenFon works<Icon name="arrow" size={16} /></button><span className="of-state-tag">{stateLabel}</span></div></div>
    <div className="of-intro-note"><span>A clear next step.</span><p>Start with the details<br />you know by heart.</p><Icon name="arrow" size={25} /></div>
    <button className="of-intro-dismiss" aria-label="Hide introduction" onClick={onDismiss}><Icon name="close" size={16} /></button>
  </div>;
}
