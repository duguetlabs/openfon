/**
 * THESIS: A warm welcome leads to a clear next step, with the selected Brand Identity page as authority.
 * OWN-WORLD: Exact handset-f artwork, Lilita400 short headings, Nunito Sans, blue, butter and paper.
 * STORY: Teach the business, try the saved receptionist, review what callers needed.
 * FIRST VIEWPORT: Spacious reception introduction above an editable brief and clear test sheet.
 * FORM: Owner-selected identity adaptation; provider/runtime and saved-state behavior preserved.
 */
import { useEffect, useState, useRef } from "react";
import { api, ApiError, callbackMessage, onPrivateUnauthorized } from "../cleanroom-runtime";
import type {
  Assistant,
  AssistantFields,
  Bootstrap,
  Call,
  Workspace,
} from "../cleanroom-runtime";
import {
  Button,
  Field,
  Notice,
  Loading,
  Empty,
  errorText,
  canLeave,
  useDirtyGuard,
} from "./ui";
import { Icon } from "./icons";
import { Rehearsal } from "./Rehearsal";
import { Knowledge } from "./Knowledge";
import { CallRows, Conversations } from "./Conversations";
import { Business } from "./Business";
import { Connections } from "./Connections";
import { VoiceChoices } from "./VoiceChoices";
import { Welcome, DeskIntroduction } from "./Welcome";
import { Account } from './Account';
import { PromptExamples } from './PromptExamples';
import { SessionCoordinator, browserLogoutIntentStorage, SignOutRecoveryError,
  SIGN_OUT_PENDING_MESSAGE, SIGN_OUT_UNCONFIRMED_MESSAGE, SIGN_OUT_STORAGE_UNKNOWN_MESSAGE,
  SIGN_OUT_LOCAL_CLEANUP_MESSAGE, type SignOutRecovery } from '../cleanroom-runtime/session';
import "./openfon.css";
function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <img
      className="of-brand"
      src={`/brand/openfon-logo${inverse ? "-inverse" : ""}.svg`}
      width="247"
      height="80"
      alt="OpenFon"
    />
  );
}
function Auth({ onDone, recovery, onRetry }: {
  onDone: () => void;
  recovery: SignOutRecovery | null;
  onRetry: () => void;
}) {
  const [signup, setSignup] = useState(location.pathname === "/signup");
  const [welcome, setWelcome] = useState(
    !["/login", "/signup", "/auth"].includes(location.pathname),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (welcome && !recovery)
    return (
      <Welcome
        brand={<Brand inverse />}
        onCreate={() => {
          setSignup(true);
          setWelcome(false);
          window.scrollTo(0, 0);
        }}
        onSignIn={() => {
          setSignup(false);
          setWelcome(false);
          window.scrollTo(0, 0);
        }}
      />
    );
  return (
    <div className="of-auth">
      <section className="of-auth-story">
        <Brand inverse />
        <div>
          <span className="of-kicker">A little help at the front desk</span>
          <h1>A warm welcome.<br /><span>A clear next step.</span></h1>
          <p>
            An AI receptionist for small businesses. Teach it your business,
            try a conversation, and review what callers needed.
          </p>
          <div className="of-auth-message"><h2>Your business, in your own words.</h2><p>Start with opening hours and the questions you hear most. Then try a conversation in your browser.</p></div>
        </div>
        <span className="of-auth-footer">
          Your business. Your voice. OpenFon.
        </span>
      </section>
      <main className="of-auth-entry">
        <button
          className="of-auth-back"
          disabled={Boolean(recovery)}
          onClick={() => {
            setWelcome(true);
            setError("");
          }}
        >
          <Icon name="back" size={17} />
          About OpenFon
        </button>
        <div className="of-auth-form">
          <h2>{signup ? "Make yourself at home." : "Welcome back."}</h2>
          <p>
            {signup
              ? "Create your account, then introduce your business."
              : "Your reception desk is right where you left it."}
          </p>
          {error && <Notice error>{error}</Notice>}
          {recovery && <Notice error={recovery !== 'pending'}>{recovery === 'pending'
            ? SIGN_OUT_PENDING_MESSAGE : recovery === 'local' ? SIGN_OUT_LOCAL_CLEANUP_MESSAGE
            : recovery === 'unknown' ? SIGN_OUT_STORAGE_UNKNOWN_MESSAGE : SIGN_OUT_UNCONFIRMED_MESSAGE}</Notice>}
          {recovery && recovery !== 'pending' && <Button kind="line" onClick={onRetry}>
            {recovery === 'local' ? 'Retry local cleanup' : 'Retry sign-out'}
          </Button>}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (recovery || busy) return;
              setBusy(true);
              setError("");
              try {
                await (signup
                  ? api.signup(email, password)
                  : api.login(email, password));
                onDone();
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Email address">
              <input
                type="email"
                disabled={Boolean(recovery) || busy}
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
              />
            </Field>
            <Field
              label="Password"
              hint={signup ? "Use at least 8 characters." : undefined}
            >
              <input
                type="password"
                disabled={Boolean(recovery) || busy}
                required
                minLength={signup ? 8 : undefined}
                autoComplete={signup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Button type="submit" disabled={busy || Boolean(recovery)}>
              {busy
                ? "One moment…"
                : signup
                  ? "Create account"
                  : "Open your desk"}
              <Icon name="arrow" size={18} />
            </Button>
          </form>
          <p className="of-auth-switch">
            {signup ? "Already have an account?" : "New to OpenFon?"}{" "}
            <button
              disabled={Boolean(recovery) || busy}
              onClick={() => {
                setSignup(!signup);
                setError("");
              }}
            >
              {signup ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}
function Setup({ onDone }: { onDone: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return (
    <main className="of-setup" id="of-main">
      <div className="of-setup-heading"><span className="of-kicker">A quick introduction</span>
      <h1>
        Who are we
        <br />
        answering for?
      </h1>
      <p>
        Start with the basics. You can teach your receptionist the details as
        you go.
      </p>
      <p className="of-setup-footnote">Your business information stays editable. You choose when to make your receptionist available.</p></div>
      <form
        className="of-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          pending.current = true; setBusy(true); setError("");
          try {
            if (!created) {
              await api.createWorkspace({
              name,
              description,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              });
              if (!mounted.current) return;
              setCreated(true);
            }
            await onDone();
          } catch (err) {
            if (mounted.current) setError(errorText(err));
          } finally {
            pending.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        {error && <Notice error>{error}</Notice>}
        <Field label="Business name">
          <input
            autoFocus
            disabled={busy || created}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your business"
          />
        </Field>
        <Field
          label="What do you do?"
          hint="A sentence or two is plenty for now."
        >
          <textarea
            rows={3}
            disabled={busy || created}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="We’re a local…"
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "Preparing your desk…" : created ? "Retry opening your desk" : "Meet your receptionist"}
          <Icon name="arrow" size={18} />
        </Button>
      </form>
    </main>
  );
}
function Desk({
  assistant,
  setAssistant,
  workspace,
  calls,
  onConversations,
  onConnections,
  onBusiness,
  refreshCalls,
  onStory,
}: {
  assistant: Assistant;
  setAssistant: (a: Assistant) => void;
  workspace: Workspace;
  calls: Call[];
  onConversations: (id?: string) => void;
  onConnections: () => void;
  onBusiness: () => void;
  refreshCalls: () => void;
  onStory: () => void;
}) {
  const [introVisible, setIntroVisible] = useState(() => {
    try {
      return (
        localStorage.getItem(`openfon:introduction:${workspace.id}`) !==
        "hidden"
      );
    } catch {
      return true;
    }
  });
  function dismissIntro() {
    setIntroVisible(false);
    try {
      localStorage.setItem(`openfon:introduction:${workspace.id}`, "hidden");
    } catch {
      /* Nonessential preference. */
    }
  }
  const [draft, setDraft] = useState<Assistant>(assistant);
  const [open, setOpen] = useState<string | null>(
    !assistant.greeting ? "identity" : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [assistantRefreshPending, setAssistantRefreshPending] = useState(false);
  const mutation = useRef(false);
  useEffect(() => {
    setDraft(assistant);
  }, [assistant.id]);
  const fields: (keyof AssistantFields)[] = [
    "name",
    "greeting",
    "persona",
    "language",
    "voice",
    "take_messages",
    "custom_instructions",
    "engine",
    "realtime_model",
    "realtime_voice",
    "llm_model",
  ];
  const dirty = fields.some((k) => draft[k] !== assistant[k]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  async function save() {
    if (mutation.current || assistantRefreshPending) return;
    mutation.current = true; setBusy(true);
    setError("");
    try {
      const patch: Partial<AssistantFields> = {};
      for (const key of fields)
        (patch as Record<string, unknown>)[key] = draft[key];
      const saved = await api.saveAssistant(assistant.id, patch);
      setAssistant(saved);
      setDraft((current) => {
        const next = { ...saved };
        for (const key of fields) {
          if (current[key] !== draft[key])
            (next as unknown as Record<string, unknown>)[key] = current[key];
        }
        return next;
      });
      setNotice("Saved. Your next conversation will use this brief.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      mutation.current = false; setBusy(false);
    }
  }
  async function refreshAssistant() {
    try {
      const saved = await api.assistant(assistant.id);
      setAssistant(saved);
      setDraft(current => {
        const next = { ...saved };
        for (const key of fields) if (current[key] !== assistant[key]) (next as unknown as Record<string, unknown>)[key] = current[key];
        return next;
      });
      setAssistantRefreshPending(false); setError("");
    } catch (e) {
      setAssistantRefreshPending(true);
      setError(`The change was saved, but the receptionist could not refresh. ${errorText(e)}`);
    }
  }
  useDirtyGuard(dirty || busy);
  const messages = calls.filter(
    (c) => c.environment === "live" && callbackMessage(c.message_json)?.message,
  );
  const job = (
    id: string,
    title: string,
    desc: string,
    content: React.ReactNode,
  ) => (
    <div className={`of-cue-row ${open === id ? "is-open" : ""}`}>
      <button
        className="of-cue-trigger"
        aria-expanded={open === id}
        onClick={() => {
          setOpen(open === id ? null : id);
          setNotice("");
        }}
      >
        <span>
          <strong>{title}</strong>
          <small>{desc}</small>
        </span>
        <Icon name={open === id ? "close" : "plus"} size={20} />
      </button>
      {
        <div className="of-cue-content" hidden={open !== id}>
          {content}
        </div>
      }
    </div>
  );
  const brief = (
        <section className="of-cue-sheet" key="business-brief">
          <div className="of-sheet-heading">
            <div>
              <h2>The business brief</h2>
              <p>For {workspace.name}</p>
            </div>
            <button className="of-text-button" onClick={onBusiness}>
              Business details
            </button>
          </div>
          {error && <Notice error>{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
          {job(
            "identity",
            "Who answers",
            `${assistant.name || "Name your receptionist"} · the welcome and tone`,
            <div className="of-form">
              <Field label="Receptionist name">
                <input
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field
                label="Their first words"
                hint="This is how each conversation begins."
              >
                <textarea
                  rows={3}
                  value={draft.greeting}
                  onChange={(e) =>
                    setDraft({ ...draft, greeting: e.target.value })
                  }
                  placeholder={`Hello, thanks for calling ${workspace.name}. How can I help?`}
                />
              </Field>
              <Field label="Tone and personality">
                <textarea
                  rows={3}
                  value={draft.persona}
                  onChange={(e) =>
                    setDraft({ ...draft, persona: e.target.value })
                  }
                  placeholder="Warm, clear and helpful. Keep answers brief."
                />
              </Field>
              <VoiceChoices draft={draft} onChange={setDraft} />
            </div>,
          )}
          {job(
            "knowledge",
            "What they know",
            "Hours, services and answers customers need",
            <Knowledge
              assistant={assistant}
              onChanged={() => api.assistant(assistant.id).then(setAssistant)}
            />,
          )}
          {job(
            "help",
            "How they help",
            assistant.take_messages
              ? "Take messages and help with the next step"
              : "Set expectations and handling instructions",
            <div className="of-form">
              <label className="of-check">
                <input
                  type="checkbox"
                  checked={!!draft.take_messages}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      take_messages: e.target.checked ? 1 : 0,
                    })
                  }
                />
                <span>
                  <strong>Take messages for the team</strong>
                  <small>
                    Ask for the caller’s name, number and what they need.
                  </small>
                </span>
              </label>
              <Field
                label="Anything else they should know?"
                hint="Include boundaries, escalation guidance or how to handle an unusual request."
              >
                <textarea
                  rows={5}
                  value={draft.custom_instructions}
                  onChange={(e) =>
                    setDraft({ ...draft, custom_instructions: e.target.value })
                  }
                  placeholder="For urgent questions, ask the caller to…"
                />
              </Field>
              <PromptExamples current={draft.custom_instructions} onUse={value => setDraft({ ...draft, custom_instructions: value })} />
              <p className="of-help">
                Messages are recorded for you to follow up. Your receptionist
                cannot promise an appointment or a completed callback.
              </p>
            </div>,
          )}
          <div className="of-brief-footer">
            <span>
              {dirty
                ? "You have unsaved changes."
                : "Rehearsals use the saved brief."}
            </span>
            {dirty && (
              <div className="of-actions">
                <Button
                  kind="quiet"
                  disabled={busy}
                  onClick={() => {
                    setDraft(assistant);
                    setNotice("");
                  }}
                >
                  Discard
                </Button>
                <Button
                  disabled={busy || !draft.name.trim()}
                  onClick={() => void save()}
                >
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </div>
        </section>
  );
  const rehearsal = (
        <Rehearsal
          key={assistant.id}
          assistant={assistant}
          dirty={dirty}
          blockedReason={
            !assistant.name.trim() ||
            !assistant.persona.trim() ||
            !assistant.language.trim()
              ? "Complete ‘Who answers’ first."
              : undefined
          }
          onConnections={onConnections}
          onEnded={refreshCalls}
        />
  );
  return (
    <>
      {introVisible && !messages.length ? (
        <DeskIntroduction
          onStory={onStory}
          onDismiss={dismissIntro}
          stateLabel={
            assistant.state === "active"
              ? "Available on the web"
              : assistant.state === "paused"
                ? "Web calls paused"
                : "Draft receptionist"
          }
        />
      ) : (
        <div className="of-page-heading">
          <div>
            <h1>
              {messages.length
                ? "A message worth your attention."
                : "A good first hello."}
            </h1>
            <p>
              {messages.length
                ? `Here’s what your callers wanted you to know.`
                : "Give your receptionist the details. Then hear it for yourself."}
            </p>
          </div>
          <span
            className={`of-state-tag ${assistant.state === "active" ? "active" : ""}`}
          >
            {assistant.state === "active"
              ? "Available on the web"
              : assistant.state === "paused"
                ? "Web calls paused"
                : "Draft receptionist"}
          </span>
        </div>
      )}
      {messages.length > 0 && (
        <section className="of-priority-messages">
          <CallRows calls={messages.slice(0, 3)} onOpen={onConversations} />
          {messages.length > 3 && (
            <Button kind="quiet" onClick={() => onConversations()}>
              View all messages
            </Button>
          )}
        </section>
      )}
      <div className={`of-desk-grid ${open ? "has-expanded-brief" : ""}`}>
        {open ? [brief, rehearsal] : [rehearsal, brief]}
      </div>
      <section className="of-desk-bottom">
        <div>
          <h2>
            {messages.length
              ? "Keep the conversation going."
              : "Messages & follow-ups"}
          </h2>
          <p>
            {messages.length
              ? "Review the full conversation or keep improving your receptionist."
              : "A place for the details you don’t want to miss."}
          </p>
        </div>
        <Button kind="quiet" icon="arrow" onClick={() => onConversations()}>
          View conversations
        </Button>
      </section>
      {!messages.length &&
        (calls.length ? (
          <CallRows calls={calls.slice(0, 3)} onOpen={onConversations} />
        ) : (
          <Empty title="Your first message will appear here.">
            Try asking your receptionist to take a message during a browser
            rehearsal.
          </Empty>
        ))}
      <section className="of-availability">
        <div>
          <h3>
            {assistant.state === "active"
              ? "Your web call link"
              : "Ready to share your receptionist?"}
          </h3>
          <p>
            {assistant.state === "active" ? (
              <a
                href={`/call/${assistant.public_slug}`}
                target="_blank"
                rel="noreferrer"
              >
                {location.origin}/call/{assistant.public_slug}
              </a>
            ) : (
              "Rehearse first, then make your receptionist available through a browser link."
            )}
          </p>
          <small>
            Web availability is separate from connecting a phone number.
          </small>
        </div>
        {assistantRefreshPending && <Button kind="line" disabled={busy} onClick={async () => {
          if (mutation.current) return;
          mutation.current = true; setBusy(true);
          try { await refreshAssistant(); } finally { mutation.current = false; setBusy(false); }
        }}>Retry assistant refresh</Button>}
        <Button
          kind="line"
          disabled={busy || dirty || assistantRefreshPending}
          onClick={async () => {
            if (mutation.current || assistantRefreshPending) return;
            mutation.current = true; setBusy(true);
            setError("");
            try {
              const nextState = assistant.state === "active" ? "paused" : "active";
              if (assistant.state === "active")
                await api.pauseAssistant(assistant.id);
              else await api.activateAssistant(assistant.id);
              setAssistant({ ...assistant, state: nextState });
              setAssistantRefreshPending(true);
              await refreshAssistant();
            } catch (e) {
              setError(errorText(e));
            } finally {
              mutation.current = false; setBusy(false);
            }
          }}
        >
          {assistant.state === "active"
            ? "Pause web calls"
            : "Enable web calls"}
        </Button>
      </section>
    </>
  );
}
function decodePublicSlug(value: string) {
  try { return decodeURIComponent(value); } catch { return ""; }
}
function PublicCall({ slug }: { slug: string }) {
  const [data, setData] = useState<{
    assistantId: string;
    businessName: string;
    agentName: string;
    language: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!slug) { setError("This call link is invalid. Ask the business for a new link."); return; }
    void api
      .publicAssistant(slug)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [slug]);
  return (
    <div className="of-public">
      <header>
        <Brand />
      </header>
      <main>
        {error ? (
          <Notice error>{error}</Notice>
        ) : data ? (
          <>
            <h1>
              A warm welcome to
              <br />
              {data.businessName}.
            </h1>
            <p>Speak with {data.agentName}, our virtual receptionist.</p>
            <Rehearsal
              slug={slug}
              assistant={{
                id: data.assistantId,
                name: data.agentName,
                greeting: "",
                state: "active",
              }}
            />
            <small>
              AI receptionist · You can speak or type. Conversations may be
              recorded for the business.
            </small>
          </>
        ) : (
          <Loading />
        )}
      </main>
    </div>
  );
}
const screenPaths: Record<string, string> = { desk: "/overview", business: "/business", connections: "/connections", conversations: "/conversations", account: "/account", story: "/about" };
function screenFromPath() {
  const path = location.pathname;
  if (/^\/(?:connections|settings)\/?$/.test(path)) return "connections";
  if (/^\/(?:conversations|calls)(?:\/|$)/.test(path)) return "conversations";
  if (/^\/business\/?$/.test(path)) return "business";
  if (/^\/account\/?$/.test(path)) return "account";
  if (/^\/about\/?$/.test(path)) return "story";
  return "desk";
}
function callFromLocation() { return new URLSearchParams(location.search).get("call") || location.pathname.match(/^\/calls\/([^/]+)$/)?.[1] || undefined; }
export default function OpenFon() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [screen, setScreen] = useState(screenFromPath);
  const [callId, setCallId] = useState<string | undefined>(callFromLocation);
  const [conversationQuery, setConversationQuery] = useState(location.search);
  const historyIndex = useRef<number>(Number(history.state?.openfonIndex) || 0);
  const restoringHistory = useRef(false);
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [recovery, setRecovery] = useState<SignOutRecovery | null>(null);
  const [missingTarget, setMissingTarget] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const [deletedTarget, setDeletedTarget] = useState(false);
  const [moreAssistants, setMoreAssistants] = useState(false);
  const [assistantListBusy, setAssistantListBusy] = useState(false);
  const assistantOffset = useRef(0);
  const assistantMutation = useRef(false);
  const [assistantMutating, setAssistantMutating] = useState(false);

  type ReceptionSnapshot = { boot: Bootstrap; assistant: Assistant | null; calls: Call[]; missingTarget: string | null };
  const [session] = useState(() => new SessionCoordinator<ReceptionSnapshot>(browserLogoutIntentStorage));
  const loadGeneration = useRef(0);
  const loadPending = useRef(false);
  const releaseUnauthorized = useRef<(() => void) | null>(null);
  const callsGeneration = useRef(0);
  const publicMatch = location.pathname.match(
    /^\/(?:call|widget)\/([^/]+)\/?$/,
  );
  useEffect(() => {
    document.title = publicMatch
      ? "OpenFon · Call the receptionist"
      : auth
        ? "OpenFon · Your reception desk"
        : "OpenFon — A warm welcome. A clear next step.";
  }, [screen, auth]);
  const generationAtRender = loadGeneration.current;
  function acceptAssistant(next: Assistant) {
    if (
      generationAtRender !== loadGeneration.current ||
      next.business_id !== boot?.workspace?.id
    )
      return;
    setAssistant(next);
    setBoot((current) =>
      current
        ? {
            ...current,
            assistants: current.assistants.map((item) =>
              item.id === next.id
                ? { ...item, name: next.name, state: next.state }
                : item,
            ),
          }
        : current,
    );
  }
  async function refreshCalls() {
    const gen = ++callsGeneration.current;
    try {
      const result = await api.calls({ limit: 30, environment: "all" });
      if (gen === callsGeneration.current) setCalls(result.items);
    } catch (e) {
      if (gen === callsGeneration.current) setError(errorText(e));
    }
  }
  function clearSession() {
    releaseUnauthorized.current?.();
    releaseUnauthorized.current = null;
    ++loadGeneration.current; loadPending.current = false;
    ++callsGeneration.current;
    setAuth(false); setBoot(null); setAssistant(null); setCalls([]);
    setMenu(false); setScreen('desk'); setError(''); setLoading(false); setMissingTarget(null); setReplacement('');
    history.replaceState({ openfonIndex: historyIndex.current }, '', '/login');
  }
  function showRecovery(state: SignOutRecovery) {
    clearSession();
    setRecovery(state);
  }
  async function signOut() {
    setRecovery('pending');
    try {
      await session.signOut(api.logout, {
        clearLocal: clearSession,
        confirmed: () => setRecovery(null),
        failed: e => showRecovery(e instanceof SignOutRecoveryError ? e.recovery : 'unconfirmed'),
      });
    } catch { /* Persistent recovery owns the error and explicit retry. */ }
  }
  async function deleteAccount(input: { currentPassword: string; confirmation: 'DELETE' }) {
    await session.deleteAccount(() => api.deleteAccount(input), {
      clearLocal: clearSession,
      confirmed: () => setRecovery(null),
      failed: e => showRecovery(e instanceof SignOutRecoveryError ? e.recovery : 'local'),
    });
  }
  async function load(selected?: string) {
    const requested = selected || new URLSearchParams(location.search).get("assistant") || location.pathname.match(/^\/assistants\/([^/]+)/)?.[1];
    releaseUnauthorized.current?.();
    releaseUnauthorized.current = auth ? onPrivateUnauthorized(() => { session.invalidate(); clearSession(); }) : null;
    const gen = ++loadGeneration.current;
    loadPending.current = true; setLoading(true);
    setError('');
    await session.refresh(async () => {
      const b = await api.bootstrap();
      if (gen !== loadGeneration.current) throw new Error('Session changed.');
      const key = requested || assistant?.id || b.assistants[0]?.id;
      let unavailable: string | null = null;
      let a: Assistant | null = null;
      if (b.workspace && key) {
        try {
          a = await api.assistant(key);
          if (a.business_id !== b.workspace.id) { unavailable = key; a = null; }
          else if (!b.assistants.some(item => item.id === a!.id)) b.assistants.push(a);
        } catch (e) { if (e instanceof ApiError && e.status === 404) unavailable = key; else throw e; }
      }
      if (gen !== loadGeneration.current) throw new Error('Session changed.');
      const result = b.workspace ? await api.calls({ limit: 30, environment: 'all' }) : null;
      return { boot: b, assistant: a, calls: result?.items || [], missingTarget: unavailable };
    }, snapshot => {
      if (gen !== loadGeneration.current) return;
      setBoot(snapshot.boot); setAssistant(snapshot.assistant); setCalls(snapshot.calls);
      assistantOffset.current = 0; setMoreAssistants(snapshot.boot.assistants.length >= 32); setAssistantListBusy(false);
      setMissingTarget(snapshot.missingTarget); setReplacement(""); setDeletedTarget(false);
      releaseUnauthorized.current?.();
      releaseUnauthorized.current = onPrivateUnauthorized(() => { session.invalidate(); clearSession(); });
      setAuth(true); setRecovery(null); loadPending.current = false; setLoading(false);
      if (/^\/(?:login|signup|auth|onboarding)?\/?$/.test(location.pathname)) {
        history.replaceState({ ...history.state, openfonIndex: historyIndex.current }, "", "/overview");
      }
      if (selected && snapshot.assistant) {
        const url = new URL(location.href);
        if (/^\/(?:assistants|studio|test)(?:\/|$)/.test(url.pathname)) url.pathname = "/overview";
        if (snapshot.assistant.id === snapshot.boot.assistants[0]?.id) url.searchParams.delete("assistant");
        else url.searchParams.set("assistant", snapshot.assistant.id);
        history.replaceState({ ...history.state, openfonIndex: historyIndex.current }, "", url.pathname + url.search);
      }
    }, e => {
      if (gen !== loadGeneration.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setAuth(false); setBoot(null); setAssistant(null); setCalls([]);
      } else {
        setError(errorText(e));
        if (requested && requested !== assistant?.id) { setAssistant(null); setMissingTarget(requested); setReplacement(""); }
      }
      loadPending.current = false; setLoading(false);
    }, showRecovery);
  }
  useEffect(() => {
    if (!publicMatch) void load();
    return () => { releaseUnauthorized.current?.(); session.invalidate(); ++loadGeneration.current; ++callsGeneration.current; };
  }, []);
  useEffect(() => {
    if (publicMatch) return;
    history.replaceState({ ...history.state, openfonIndex: historyIndex.current }, "");
    const restore = (event: PopStateEvent) => {
      if (restoringHistory.current) { restoringHistory.current = false; return; }
      const targetIndex = Number(event.state?.openfonIndex) || 0;
      if (!canLeave()) {
        const delta = historyIndex.current - targetIndex;
        if (delta) { restoringHistory.current = true; history.go(delta); }
        return;
      }
      historyIndex.current = targetIndex;
      setScreen(screenFromPath()); setCallId(callFromLocation()); setConversationQuery(location.search); setMenu(false);
      const targetAssistant = new URLSearchParams(location.search).get("assistant") || location.pathname.match(/^\/assistants\/([^/]+)/)?.[1] || boot?.assistants[0]?.id;
      if (targetAssistant && (targetAssistant !== assistant?.id || loadPending.current)) void load(targetAssistant);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [assistant?.id, boot?.account.id]);
  function navigate(next: string, saved = false, selectedCall?: string, query?: Record<string, string>) {
    if (!saved && next !== screen && !canLeave()) return false;
    if (loadPending.current) {
      ++loadGeneration.current; session.invalidate(); loadPending.current = false; setLoading(false);
    }
    const url = new URL(screenPaths[next] || "/overview", location.origin);
    if (assistant && assistant.id !== boot?.assistants[0]?.id) url.searchParams.set("assistant", assistant.id);
    if (next === "conversations" && screen === "conversations") {
      const current = new URLSearchParams(location.search);
      for (const key of ["search", "environment", "assistantId", "status", "intent", "direction", "from", "to"]) if (current.has(key)) url.searchParams.set(key, current.get(key)!);
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value && !(key === "environment" && value === "all")) url.searchParams.set(key, value); else url.searchParams.delete(key);
      }
    }
    if (selectedCall) url.searchParams.set("call", selectedCall);
    if (location.pathname + location.search !== url.pathname + url.search) {
      historyIndex.current++;
      history.pushState({ openfonIndex: historyIndex.current }, "", url.pathname + url.search);
    }
    setScreen(next); setCallId(selectedCall); setConversationQuery(url.search);
    setMenu(false);
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }
  async function discoverAssistants() {
    if (assistantListBusy || !boot?.workspace) return;
    const gen = loadGeneration.current;
    setAssistantListBusy(true); setError("");
    try {
      let offset = assistantOffset.current;
      let items;
      do {
        items = await api.assistants(offset);
        if (gen !== loadGeneration.current) return;
        offset += items.length;
      } while (items.length === 32 && items.every(item => boot.assistants.some(existing => existing.id === item.id)));
      assistantOffset.current = offset;
      setMoreAssistants(items.length === 32);
      setBoot(current => current ? { ...current, assistants: [...current.assistants, ...items.filter(item => !current.assistants.some(existing => existing.id === item.id))] } : current);
    } catch (e) { if (gen === loadGeneration.current) setError(errorText(e)); }
    finally { if (gen === loadGeneration.current) setAssistantListBusy(false); }
  }
  async function removeAssistant() {
    if (!assistant || assistant.state === "active" || assistantMutation.current || !canLeave()) return;
    if (!confirm(`Delete “${assistant.name || "Receptionist"}”? This cannot be undone. Existing conversations will remain.`)) return;
    assistantMutation.current = true; setAssistantMutating(true); setError("");
    const gen = loadGeneration.current;
    try {
      await api.deleteAssistant(assistant.id);
      if (gen !== loadGeneration.current) return;
      ++loadGeneration.current; setAssistantListBusy(false);
      const remaining = boot!.assistants.filter(item => item.id !== assistant.id);
      setBoot(current => current ? { ...current, assistants: remaining } : current);
      setAssistant(null);
      const url = new URL(location.href); url.searchParams.delete("assistant");
      history.replaceState(history.state, "", url.pathname + url.search);
      setMissingTarget(remaining.length ? assistant.id : null); setReplacement(""); setDeletedTarget(true);
    } catch (e) { if (gen === loadGeneration.current) setError(errorText(e)); }
    finally { assistantMutation.current = false; setAssistantMutating(false); }
  }
  if (publicMatch)
    return <PublicCall slug={decodePublicSlug(publicMatch[1])} />;
  if (loading && !boot) return <Loading />;
  if (recovery || (!auth && !error)) return <Auth onDone={() => void load()} recovery={recovery} onRetry={() => void signOut()} />;
  return (
    <div className="of-app">
      <a className="of-skip" href="#of-main">Skip to your reception desk</a>
      <header className="of-header">
        <button
          className="of-brand-button"
          onClick={() => navigate("desk")}
          aria-label="OpenFon home"
        >
          <Brand />
        </button>
        <div className="of-header-right">
          {boot?.workspace && (
            <button
              className="of-header-link story-link"
              onClick={() => navigate("story")}
            >
              How it works
            </button>
          )}
          {boot?.workspace && (
            <button
              className="of-header-link messages-link"
              onClick={() => {
                setCallId(undefined);
                navigate("conversations");
              }}
            >
              Messages
            </button>
          )}
          <div className="of-menu-wrap">
            <button
              className="of-workspace-button"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <span className="of-workspace-name">
                {boot?.workspace?.name || "Your account"}
              </span>
              <Icon name="chevron" size={16} />
            </button>
            {menu && (
              <>
                <button
                  aria-label="Close menu"
                  className="of-menu-backdrop"
                  onClick={() => setMenu(false)}
                />
                <div className="of-workspace-menu">
                  {boot?.workspace && (
                    <>
                      <button onClick={() => { setCallId(undefined); navigate("conversations"); }}><Icon name="message" />Messages & conversations</button>
                      <button onClick={() => navigate("story")}>
                        <Icon name="phone" />
                        How OpenFon works
                      </button>
                      <button onClick={() => navigate("business")}>
                        <Icon name="book" />
                        Business details
                      </button>
                      <button onClick={() => navigate("connections")}>
                        <Icon name="settings" />
                        Connections & portability
                      </button>
                    </>
                  )}
                  <button onClick={() => navigate("account")}>
                    <Icon name="settings" />
                    Your account
                  </button>
                  <button onClick={() => {
                    if (!canLeave()) return;
                    void signOut();
                  }}>

                    <Icon name="logout" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      {error && (
        <div className="of-global-error">
          <Notice error>
            {error}{" "}
            <button className="of-text-button" onClick={() => { if (canLeave()) void load(missingTarget || undefined); }}>
              Try again
            </button>
          </Notice>
        </div>
      )}
      {!boot ? null : screen === 'account' ? (
        <main className="of-main" id="of-main">
          <Account email={boot.account.email} onDelete={deleteAccount} onDone={() => navigate('desk')} />
        </main>
      ) : !boot.workspace ? (
        <Setup onDone={() => load()} />
      ) : (
        <main className="of-main" id="of-main">
          {loading ? <Loading /> : missingTarget ? (
            <section className="of-business-form of-form">
              <h1>{deletedTarget ? "Receptionist deleted" : "Receptionist unavailable"}</h1>
              <Notice error>{deletedTarget ? "The receptionist was deleted. Existing conversations are still available. Choose your next receptionist before rehearsing." : "The requested receptionist is no longer available in this workspace. Choose a replacement explicitly before rehearsing."}</Notice>
              <Field label="Choose a replacement receptionist"><select value={replacement} onChange={e => setReplacement(e.target.value)}>
                <option value="">Choose a receptionist…</option>
                {boot.assistants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></Field>
              {moreAssistants && <Button kind="quiet" disabled={assistantListBusy || loading} onClick={() => void discoverAssistants()}>Find more receptionists</Button>}
              <Button disabled={!replacement || loading} onClick={() => void load(replacement)}>Use selected receptionist</Button>
              {!deletedTarget && <Button kind="line" disabled={loading} onClick={() => void load(missingTarget || undefined)}>Retry requested receptionist</Button>}
            </section>
          ) : screen === "story" ? (
            <Welcome
              inApp
              brand={<Brand inverse />}
              onCreate={() => navigate("desk")}
              onBack={() => navigate("desk")}
            />
          ) : screen === "business" ? (
            <Business
              workspace={boot.workspace}
              onBack={(saved) => { navigate("desk", saved); }}
              onSaved={workspace => setBoot(current => current ? { ...current, workspace } : current)}
            />
          ) : screen === "conversations" ? (
            <Conversations initial={callId} query={conversationQuery} onQuery={query => navigate("conversations", false, undefined, query)} assistants={boot.assistants} moreAssistants={moreAssistants} assistantListBusy={assistantListBusy} onMoreAssistants={() => void discoverAssistants()} onSelect={id => navigate("conversations", false, id)} onBack={() => navigate("desk")} />
          ) : screen === "connections" && assistant ? (
            <Connections
              key={assistant.id}
              assistant={assistant}
              onBack={() => navigate("desk")}
              onSaved={() => api.assistant(assistant.id).then(acceptAssistant)}
            />
          ) : assistant ? (
            <>
              <div className="of-assistant-switch">
                <label htmlFor="of-receptionist">Receptionist</label>
                <select
                  id="of-receptionist"
                  value={assistant.id}
                  disabled={loading || assistantMutating}
                  onChange={(e) => {
                    if (canLeave()) void load(e.target.value);
                  }}
                >
                  {boot.assistants.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name || "Unnamed receptionist"}
                    </option>
                  ))}
                </select>
                {moreAssistants && <Button kind="quiet" disabled={assistantListBusy || loading || assistantMutating} onClick={() => void discoverAssistants()}>{assistantListBusy ? "Loading receptionists…" : "Find more receptionists"}</Button>}
                {assistant.state !== "active" && <Button kind="quiet" disabled={loading || assistantMutating} onClick={() => void removeAssistant()}>Delete receptionist</Button>}
                <button
                  className="of-text-button"
                  disabled={loading || assistantMutating}
                  onClick={async () => {
                    if (!canLeave()) return;
                    const name = prompt("Name for your new receptionist");
                    if (!name?.trim()) return;
                    try {
                      const made = await api.createAssistant({
                        name: name.trim(),
                      });
                      await load(made.id);
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  Add receptionist
                </button>
              </div>
              <Desk
                key={assistant.id}
                assistant={assistant}
                setAssistant={acceptAssistant}
                workspace={boot.workspace}
                calls={calls}
                onConnections={() => navigate("connections")}
                onBusiness={() => navigate("business")}
                onConversations={(id) => {
                  navigate("conversations", false, id);
                }}
                refreshCalls={() => void refreshCalls()}
                onStory={() => navigate("story")}
              />
            </>
          ) : (
            <Empty title="Let’s meet your receptionist.">
              <Button
                onClick={async () => {
                  try {
                    const made = await api.createAssistant({
                      name: "Receptionist",
                    });
                    await load(made.id);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                Create receptionist
              </Button>
            </Empty>
          )}
        </main>
      )}
      <footer className="of-footer">
        <span>OpenFon</span>
        <span>A warm welcome. A clear next step.</span>
      </footer>
    </div>
  );
}
