import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, Business, AgentSettings } from './types';
import { createSession, deleteSession, getUserIdFromSession, hashPassword, newId, verifyPassword } from './auth';
import { sameLlmEndpoint, validateLlmBaseUrl } from './providers';
import { CallSession } from './call-session';
import { ensureWorkspaceFoundation, registerStudioApi, syncLegacyKnowledge } from './studio-api';

export { CallSession };

type Vars = { userId: string };
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const COOKIE = 'ofs';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'business'}-${newId().replace(/-/g, '').slice(0, 12)}`;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)])
    );
  }
  return value;
}

function jsonSemanticallyEqual(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(canonicalJson(JSON.parse(left))) === JSON.stringify(canonicalJson(JSON.parse(right)));
  } catch {
    return false;
  }
}

function updateCompatibilitySnapshot(env: Env, businessId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE compatibility_sync_state SET agent_snapshot=(
       SELECT json_object(
         'agent_name', agent_settings.agent_name, 'greeting', agent_settings.greeting,
         'persona', agent_settings.persona, 'language', agent_settings.language,
         'voice', agent_settings.voice, 'take_messages', agent_settings.take_messages,
         'custom_instructions', agent_settings.custom_instructions, 'engine', agent_settings.engine,
         'realtime_model', agent_settings.realtime_model, 'realtime_voice', agent_settings.realtime_voice,
         'llm_model', agent_settings.llm_model
       ) FROM agent_settings WHERE business_id=?
     ), synced_at=datetime('now') WHERE business_id=?`
  ).bind(businessId, businessId);
}

// ---------- abuse limits ----------
// /api/public/* and /api/auth/login are reachable by anyone on the internet, and
// a call row is a ticket to a Durable Object that spends the owner's LLM key.
// Counters live in D1 (fixed windows) rather than in the Cloudflare Rate
// Limiting binding: D1 is already a hard dependency and needs no account-level
// resource, the binding cannot express per-day or per-business counts, and its
// per-colo scope would let a distributed burst through anyway. Self-hosters on
// the free plan get the same behaviour as everyone else.
//
// Everything tunable lives in LIMITS and the two staleness constants below.
interface Limit {
  name: string;
  window: number; // seconds
  max: number; // requests allowed per window
}
const LIMITS = {
  // Every /api/public/* request. A widget page load is two of them — the agent
  // lookup and the call start — so 30 is fifteen page loads a minute from one
  // address, well past any legitimate NAT and still cheap to store.
  //
  // This number is also the instance's write budget, which is why it is not
  // larger. Each request that lands inside it costs exactly one D1 row write, so
  // an address saturating it for a full day costs 30 x 60 x 24 = 43,200 writes
  // against D1's free-tier ceiling of 100,000/day, leaving the rest for call
  // rows, transcripts and the sweep. At the old 60 — with call starts billing a
  // second row on top — a client breaking no rule at all reached 100,800 and
  // took the instance's own limiter offline with it.
  publicApi: { name: 'pub', window: 60, max: 30 },
  // Both are reserved on every attempt, and they do different jobs.
  //
  // Per-IP is the only real ceiling: it bounds how much work one address can
  // demand across every email it tries, and a success gives back only its own
  // reservation, never the bucket's history.
  //
  // Per-email refuses a wrong password from a repeat guesser and slows the next
  // one down. It is deliberately *not* a bound on guesses or on work — the only
  // version that would be also locks an owner out of their own account for the
  // price of five requests. The login handler sets out the trade in full; it is
  // a choice, not a limiter that quietly failed.
  loginIp: { name: 'lgip', window: 900, max: 20 },
  // How many *successful* sign-ins an address gets refunded before they start
  // spending the per-IP allowance like everything else. Far beyond what a shared
  // office does in a quarter of an hour — sessions last thirty days — and finite,
  // so a loop of deliberately correct logins cannot run for ever.
  loginOk: { name: 'lgok', window: 900, max: 30 },
  loginEmail: { name: 'lgem', window: 900, max: 5 },
} satisfies Record<string, Limit>;

// Call creation, counted in a second column of the *same* row as publicApi
// rather than a bucket of its own. Two buckets meant one call start billed two
// D1 row writes for one request, which is how the limiter's own cost came to
// exceed the quota it was protecting. They share a window, so they can share a
// row: one upsert, both ceilings. A caller who reloads the widget a few times is
// fine, and office NAT means several legitimate callers share one address.
const MAX_STARTS_PER_WINDOW = 10;

// A call row whose WebSocket never opened is dead after this: the widget
// connects immediately, so a longer gap means nobody is coming. Doubles as the
// attach window, which stops a leaked callId from being reusable forever.
const STALE_UNCONNECTED = '-15 minutes';
// A connected call this old is a leftover the Durable Object could not clear
// itself. Measured from connected_at, not started_at: attachment is allowed for
// STALE_UNCONNECTED after the row is created, so the two are up to 15 minutes
// apart and only one of them is when the call began.
//
// The number is set by CallSession's own budgets, not by guesswork. It caps a
// call at MAX_CALL_MS (30 min), and if the finalize that follows keeps failing
// it retries for MAX_FINALIZE_RETRY_MS (30 min) before giving up and — in its
// own words — leaving the row to be swept. So a row can be legitimately owned by
// a live Durable Object for a full hour, and a sweep at exactly 60 minutes would
// hand over at the same instant the DO gives up: the last retry would find the
// row already 'abandoned' (finalize writes WHERE status = 'active') and the call
// would lose the summary that retry was about to produce. 90 leaves a 30-minute
// margin so the DO always finishes losing before this starts trying.
//
// This is the *only* place a connected call's age is judged. The concurrency
// count deliberately has no window of its own: it counts every connected row
// that is still 'active', so a genuinely long call keeps its slot and the sweep
// is the single event that releases one. Two independent windows would disagree
// about whether a call is live, and the shorter one would silently admit callers
// past the cap.
const STALE_CONNECTED = '-90 minutes';

function clientIp(c: Ctx): string {
  // Set by Cloudflare on every edge request; absent under `wrangler dev`, where
  // one shared bucket is the safe answer.
  return c.req.header('CF-Connecting-IP') ?? 'local';
}

function windowStart(limit: Limit, now = Date.now()): number {
  return Math.floor(now / 1000 / limit.window) * limit.window;
}

// What a request took from a bucket. The window travels with it: a refund has to
// land on the row the reservation was made in, and a request that starts near a
// boundary finishes on the other side of one. Recomputing the window at refund
// time leaves the old window over-counted and decrements a new window the
// request never touched — wrong in both directions at once.
interface Reservation {
  over: boolean; // this request took the count past the limit
  window: number;
}

// Counts this request and reports whether it busted the limit. One round trip:
// D1 supports INSERT ... ON CONFLICT ... RETURNING.
//
// The WHERE on the conflict branch is what makes a refusal free. Without it, a
// source that keeps hammering after being blocked buys a row write per request,
// forever — so the harder the flood, the more D1 quota the limiter itself burns,
// and when that quota runs out `consume` starts throwing and takes every public
// and login route down with it. A limiter that costs the operator more the
// harder it is attacked is worth less than no limiter at all. When the count is
// already at the ceiling the upsert matches nothing, writes nothing, and returns
// no row — an empty result is the refusal.
async function consume(env: Env, limit: Limit, subject: string): Promise<Reservation> {
  const window = windowStart(limit);
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET count = rate_counters.count + 1
       WHERE rate_counters.count < ?
     RETURNING count`
  )
    .bind(`${limit.name}:${subject}`, window, limit.max)
    .first<{ count: number }>();
  // No row means the conflict branch declined to write: already at the ceiling.
  return { over: !row || row.count > limit.max, window };
}

async function clearLimit(env: Env, limit: Limit, subject: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_counters WHERE bucket = ?').bind(`${limit.name}:${subject}`).run();
}

// Give back exactly the one reservation this request made — not the bucket's
// history. Clearing the whole bucket on success is a bypass wherever the bucket
// spans more than the thing that succeeded.
async function refundOne(env: Env, limit: Limit, subject: string, taken: Reservation): Promise<void> {
  await env.DB.prepare('UPDATE rate_counters SET count = count - 1 WHERE bucket = ? AND window_start = ? AND count > 0')
    .bind(`${limit.name}:${subject}`, taken.window)
    .run();
}

function tooMany(c: Ctx, message: string, retryAfter: number) {
  return c.json({ error: message }, 429, { 'Retry-After': String(retryAfter) });
}

// Both public ceilings in one row write. `count` gates in SQL, so anything past
// it costs nothing at all; `starts` is judged on the returned value, so a start
// refused for exceeding its own ceiling does write — but only up to the `count`
// gate, which is what bounds the instance's write budget either way.
async function consumePublic(
  env: Env,
  subject: string,
  isStart: boolean
): Promise<{ overAll: boolean; overStart: boolean }> {
  const limit = LIMITS.publicApi;
  const row = await env.DB.prepare(
    `INSERT INTO rate_counters (bucket, window_start, count, starts) VALUES (?, ?, 1, ?)
     ON CONFLICT(bucket, window_start) DO UPDATE SET
         count = rate_counters.count + 1,
         starts = rate_counters.starts + excluded.starts
       WHERE rate_counters.count < ?
     RETURNING count, starts`
  )
    .bind(`${limit.name}:${subject}`, windowStart(limit), isStart ? 1 : 0, limit.max)
    .first<{ count: number; starts: number }>();
  if (!row) return { overAll: true, overStart: false };
  return { overAll: false, overStart: isStart && row.starts > MAX_STARTS_PER_WINDOW };
}

app.use('/api/public/*', async (c, next) => {
  // The middleware owns both ceilings now: it is the one place that sees every
  // public request, so counting here is what lets a start cost one write.
  const isStart = c.req.method === 'POST' && new URL(c.req.url).pathname === '/api/public/call/start';
  const taken = await consumePublic(c.env, clientIp(c), isStart);
  if (taken.overAll) {
    return tooMany(c, 'Too many requests. Please wait a moment and try again.', LIMITS.publicApi.window);
  }
  if (taken.overStart) {
    return tooMany(c, 'Too many calls started from this connection. Please wait a minute.', LIMITS.publicApi.window);
  }
  await next();
});

// ---------- auth ----------
app.post('/api/auth/signup', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'Valid email required' }, 400);
  if (!password || password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
  if (existing) return c.json({ error: 'An account with this email already exists' }, 409);
  const id = newId();
  await c.env.DB.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)')
    .bind(id, email.toLowerCase(), await hashPassword(password))
    .run();
  const token = await createSession(c.env, id);
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  return c.json({ id, email: email.toLowerCase() });
});

// Well-formed but unmatchable: 16 zero-ish salt bytes and a 32-byte digest no
// password derives to. Verifying against it on the miss path burns the same
// 100k PBKDF2 iterations a real account pays, so the response time stops
// disclosing whether the email exists. (POST /api/auth/signup still answers the
// same question outright with its 409 — that is a deliberate UX call, and this
// only closes the silent channel.)
const DUMMY_HASH = 'BwcHBwcHBwcHBwcHBwcHBw==:CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws=';

const TOO_MANY_LOGINS = 'Too many sign-in attempts. Please try again later.';

// Applied to a wrong password once its email is over the limit. Long enough to
// cost a sequential guesser an order of magnitude, short enough that an owner
// who mistyped twice does not think the app has hung.
const OVER_LIMIT_DELAY_MS = 1000;

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  const addr = clientIp(c);
  const key = (email ?? '').toLowerCase();

  // Reserve before working, never after. Reading a counter and incrementing it
  // only on failure is the same count-then-act race as the daily cap: a parallel
  // burst all reads a count under the limit and all of it goes on to run PBKDF2.
  //
  // Per-IP is reserved and checked first, and nothing else here runs until it
  // passes. It is what bounds how much work this worker will do for one address
  // across all the emails they care to try — and the email bucket is keyed on
  // attacker-supplied text, so reserving it first would let a client that is
  // already blocked mint a fresh counter row per request forever. A refused
  // attacker must cost less than a served one, not more.
  const ipTaken = await consume(c.env, LIMITS.loginIp, addr);
  if (ipTaken.over) return tooMany(c, TOO_MANY_LOGINS, LIMITS.loginIp.window);

  const emailTaken = await consume(c.env, LIMITS.loginEmail, key);

  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(key)
    .first<{ id: string; password_hash: string }>();
  const ok = await verifyPassword(password ?? '', user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    // What the per-email bucket does, stated exactly, because it is easy to
    // credit it with more: it refuses a *wrong* password once an address has had
    // its five in the window, and it slows the next guess down. That is all.
    //
    // It is not a bound on guesses and not a bound on work. A correct password
    // still gets in from here, and the verify above already ran, so an attacker
    // spread over many addresses is limited by LIMITS.loginIp per address and by
    // nothing at all per account. Making it a real bound means refusing before
    // the password is checked, and then five wrong guesses from anyone who knows
    // an owner's email locks that owner out of the only control surface this
    // product has — with no 2FA, no email verification and no recovery flow to
    // get back in. Between an account that can be shut off by a stranger for the
    // price of five requests and an account whose defence against distributed
    // guessing is password strength plus the per-IP ceiling, this takes the
    // second. The trade is the point; it is not a limiter that quietly failed.
    //
    // The delay is worth what it is worth: a sequential guesser drops from ~10
    // attempts a second to ~1, and it costs the operator no CPU, because Workers
    // bill compute and this is a sleep. A parallel attacker is unaffected.
    if (emailTaken.over) {
      await new Promise((r) => setTimeout(r, OVER_LIMIT_DELAY_MS));
      return tooMany(c, TOO_MANY_LOGINS, LIMITS.loginEmail.window);
    }
    return c.json({ error: 'Invalid email or password' }, 401);
  }
  // Per-email is cleared outright: its whole job is to keep one account from
  // being locked out, and a correct password proves ownership of that account.
  //
  // Per-IP gets its reservation back, but only while successes stay inside an
  // allowance of their own. An unconditional refund made succeeding free, and
  // signup is public, so anyone can hold valid credentials and loop /login
  // forever: PBKDF2 every time, a handful of counter writes, and a session row
  // that nothing ever removes, from one address that never advances a counter.
  // Once loginOk is spent the refund stops, the per-IP counter starts climbing
  // again, and the gate above — which runs before any verification — closes.
  // That is what bounds the CPU as well as the writes; a check down here could
  // only ever refuse after the work was already done.
  //
  // The refund goes back to the window the reservation came from, which a
  // PBKDF2-length request can outlive.
  await clearLimit(c.env, LIMITS.loginEmail, key);
  if (!(await consume(c.env, LIMITS.loginOk, addr)).over) {
    await refundOne(c.env, LIMITS.loginIp, addr, ipTaken);
  }
  const token = await createSession(c.env, user.id);
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 30 * 86400 });
  return c.json({ id: user.id });
});

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await deleteSession(c.env, token);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- authed routes ----------
app.use('/api/me/*', async (c, next) => {
  const userId = await getUserIdFromSession(c.env, getCookie(c, COOKIE));
  if (!userId) return c.json({ error: 'Not signed in' }, 401);
  c.set('userId', userId);
  await next();
});

app.get('/api/me', async (c) => {
  const userId = await getUserIdFromSession(c.env, getCookie(c, COOKIE));
  if (!userId) return c.json({ error: 'Not signed in' }, 401);
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();
  return c.json(user);
});

registerStudioApi(app);

app.get('/api/me/business', async (c) => {
  const biz = await c.env.DB.prepare('SELECT * FROM businesses WHERE user_id = ? ORDER BY created_at, id LIMIT 1')
    .bind(c.get('userId'))
    .first<Business>();
  if (!biz) return c.json(null);
  await ensureWorkspaceFoundation(c.env, biz);
  const assistant = await c.env.DB.prepare('SELECT * FROM assistants WHERE business_id = ? AND public_slug = ? LIMIT 1')
    .bind(biz.id, biz.slug)
    .first<Record<string, string | number | null>>();
  const provider = await c.env.DB.prepare('SELECT llm_base_url, llm_api_key FROM provider_settings WHERE business_id = ?')
    .bind(biz.id)
    .first<{ llm_base_url: string; llm_api_key: string }>();
  const settings = assistant
    ? {
        business_id: biz.id,
        agent_name: assistant.name,
        greeting: assistant.greeting,
        persona: assistant.persona,
        language: assistant.language,
        voice: assistant.voice,
        take_messages: assistant.take_messages,
        custom_instructions: assistant.custom_instructions,
        llm_base_url: provider?.llm_base_url ?? '',
        llm_api_key: '',
        apiKeyConfigured: Boolean(
          provider?.llm_api_key ||
            ((!provider?.llm_base_url || sameLlmEndpoint(provider.llm_base_url, c.env.DEFAULT_LLM_BASE_URL)) &&
              c.env.DEFAULT_LLM_API_KEY)
        ),
        llm_model: assistant.llm_model,
        engine: assistant.engine,
        realtime_model: assistant.realtime_model,
        realtime_voice: assistant.realtime_voice,
      }
    : null;
  return c.json({ ...biz, agent: settings });
});

app.post('/api/me/business', async (c) => {
  const body = await c.req.json<Partial<Business>>();
  if (!body.name?.trim()) return c.json({ error: 'Business name required' }, 400);
  const userId = c.get('userId');
  const existingWorkspace = () =>
    c.env.DB.prepare('SELECT * FROM businesses WHERE user_id = ? ORDER BY created_at, id LIMIT 1')
      .bind(userId)
      .first<Business>();
  let existing = await existingWorkspace();
  if (existing) {
    await ensureWorkspaceFoundation(c.env, existing);
    return c.json(existing);
  }
  const id = newId();
  const slug = slugify(body.name);
  const assistantId = `asst_${id}`;
  const collectionId = `kc_default_${id}`;
  const createStatements = [
    c.env.DB.prepare(
      `INSERT INTO businesses (id, user_id, slug, name, description, address, phone, website, timezone, hours_json, services_json, faqs_json, closures_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      userId,
      slug,
      body.name.trim(),
      body.description ?? '',
      body.address ?? '',
      body.phone ?? '',
      body.website ?? '',
      body.timezone ?? 'Europe/Vienna',
      body.hours_json ?? '[]',
      body.services_json ?? '[]',
      body.faqs_json ?? '[]',
      body.closures_json ?? '[]'
    ),
    // A fresh compatibility row is deliberately incomplete, matching the draft
    // assistant. Besides making bootstrap resumable, this gives mixed-version
    // reconciliation an observable change even when the user accepts the old
    // UI's Alex/friendly/en defaults verbatim.
    c.env.DB.prepare(
      "INSERT INTO agent_settings (business_id, agent_name, persona, language) VALUES (?, '', '', '')"
    ).bind(id),
    c.env.DB.prepare(
      `INSERT INTO assistants (id, business_id, public_slug, state, name)
       VALUES (?, ?, ?, 'draft', '')`
    ).bind(assistantId, id, slug),
    c.env.DB.prepare('INSERT INTO provider_settings (business_id) VALUES (?)').bind(id),
    c.env.DB.prepare(
      `INSERT INTO knowledge_collections (id, business_id, name, description, is_default)
       VALUES (?, ?, 'Workspace knowledge', 'Services and answers shared by default with new assistants.', 1)`
    ).bind(collectionId, id),
    c.env.DB.prepare(
      'INSERT INTO assistant_knowledge_collections (assistant_id, collection_id) VALUES (?, ?)'
    ).bind(assistantId, collectionId),
  ];
  try {
    await c.env.DB.batch(createStatements);
  } catch (error) {
    // Concurrent retries race at the database trigger. The winner already
    // persisted the same onboarding stage, so return that canonical workspace
    // instead of turning a harmless retry into a dead end.
    existing = await existingWorkspace();
    if (!existing) throw error;
    await ensureWorkspaceFoundation(c.env, existing);
    return c.json(existing);
  }
  await syncLegacyKnowledge(c.env, {
    id,
    services_json: body.services_json ?? '[]',
    faqs_json: body.faqs_json ?? '[]',
  });
  const biz = await c.env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first<Business>();
  return c.json(biz, 201);
});

app.put('/api/me/business/:id', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<Partial<Business>>();
  const servicesChanged =
    b.services_json !== undefined && !jsonSemanticallyEqual(b.services_json, biz.services_json);
  const faqsChanged = b.faqs_json !== undefined && !jsonSemanticallyEqual(b.faqs_json, biz.faqs_json);
  // Keep the synchronized serialization when the submitted JSON is only a
  // whitespace/key-order rewrite. Persisting that rewrite without rebuilding
  // the projection would make the next reconciliation mistake it for a source
  // change and clobber approved item edits.
  const servicesJson = servicesChanged ? b.services_json! : biz.services_json;
  const faqsJson = faqsChanged ? b.faqs_json! : biz.faqs_json;
  await c.env.DB.prepare(
    `UPDATE businesses SET name=?, description=?, address=?, phone=?, website=?, timezone=?, hours_json=?, services_json=?, faqs_json=?, closures_json=?, max_concurrent_calls=?, max_calls_per_day=? WHERE id=?`
  )
    .bind(
      b.name?.trim() || biz.name,
      b.description ?? biz.description,
      b.address ?? biz.address,
      b.phone ?? biz.phone,
      b.website ?? biz.website,
      b.timezone ?? biz.timezone,
      b.hours_json ?? biz.hours_json,
      servicesJson,
      faqsJson,
      b.closures_json ?? biz.closures_json,
      clampCap(b.max_concurrent_calls, biz.max_concurrent_calls, 50),
      clampCap(b.max_calls_per_day, biz.max_calls_per_day, 100_000),
      biz.id
    )
    .run();
  if (servicesChanged || faqsChanged) {
    await syncLegacyKnowledge(c.env, {
      id: biz.id,
      services_json: servicesJson,
      faqs_json: faqsJson,
    }, undefined, { services: servicesChanged, faqs: faqsChanged });
  }
  return c.json({ ok: true });
});

// Caps always apply — there is no "unlimited", because an unlimited public
// endpoint is exactly the bug this is fixing. Junk input keeps the old value.
function clampCap(v: unknown, current: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : current;
}

app.put('/api/me/business/:id/agent', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const cur = await c.env.DB.prepare(
    `SELECT assistants.*,
      assistants.name AS agent_name,
      provider_settings.llm_base_url,
      provider_settings.llm_api_key
     FROM assistants LEFT JOIN provider_settings ON provider_settings.business_id = assistants.business_id
     WHERE assistants.business_id = ? AND assistants.public_slug = ? LIMIT 1`
  )
    .bind(biz.id, biz.slug)
    .first<AgentSettings & { id: string; name: string; state: 'draft' | 'active' | 'paused' }>();
  if (!cur) return c.json({ error: 'Not found' }, 404);
  const s = await c.req.json<Partial<AgentSettings>>();
  // "••••" placeholder from the UI means "keep the stored key"
  const llmKey = s.llm_api_key !== undefined && s.llm_api_key !== '' && !/^•+$/.test(s.llm_api_key) ? s.llm_api_key : cur.llm_api_key;
  const engine = s.engine === 'realtime' ? 'realtime' : s.engine === 'pipeline' ? 'pipeline' : cur.engine;
  const realtimeModel = s.realtime_model !== undefined ? s.realtime_model : cur.realtime_model;
  const realtimeVoice = s.realtime_voice !== undefined ? s.realtime_voice : cur.realtime_voice;
  const llmBaseUrl = s.llm_base_url ?? cur.llm_base_url;
  const effectiveName = s.agent_name ?? cur.agent_name;
  const effectivePersona = s.persona ?? cur.persona;
  const effectiveLanguage = s.language ?? cur.language;
  if (cur.state === 'draft' && (!biz.name.trim() || !biz.description.trim())) {
    return c.json({ error: 'Complete the workspace name and description first' }, 409);
  }
  if (!effectiveName.trim() || !effectivePersona.trim() || !effectiveLanguage.trim()) {
    return c.json({ error: 'Assistant name, personality, and language are required' }, 400);
  }
  const bad = llmEndpointError(c.env, llmBaseUrl, llmKey);
  if (bad) return c.json({ error: bad }, 400);
  const assistantUpdate = c.env.DB.prepare(
    `UPDATE assistants SET name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?, custom_instructions=?,
      engine=?, realtime_model=?, realtime_voice=?, llm_model=?,
      activated_at=CASE WHEN state='draft' THEN COALESCE(activated_at, datetime('now')) ELSE activated_at END,
      state=CASE WHEN state='draft' THEN 'active' ELSE state END,
      updated_at=datetime('now') WHERE id=?`
  ).bind(
      effectiveName,
      s.greeting ?? cur.greeting,
      effectivePersona,
      effectiveLanguage,
      s.voice ?? cur.voice,
      s.take_messages !== undefined ? (s.take_messages ? 1 : 0) : cur.take_messages,
      s.custom_instructions ?? cur.custom_instructions,
      engine,
      realtimeModel,
      realtimeVoice,
      s.llm_model ?? cur.llm_model,
      cur.id
    );
  const providerUpdate = c.env.DB.prepare(
    `INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key) VALUES (?, ?, ?)
     ON CONFLICT(business_id) DO UPDATE SET llm_base_url=excluded.llm_base_url,
       llm_api_key=excluded.llm_api_key, updated_at=datetime('now')`
  ).bind(biz.id, llmBaseUrl, llmKey);
  const legacyUpdate = c.env.DB.prepare(
    `UPDATE agent_settings SET agent_name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?, custom_instructions=?, llm_base_url=?, llm_api_key=?, llm_model=?, engine=?, realtime_model=?, realtime_voice=? WHERE business_id=?`
  ).bind(
      effectiveName,
      s.greeting ?? cur.greeting,
      effectivePersona,
      effectiveLanguage,
      s.voice ?? cur.voice,
      s.take_messages !== undefined ? (s.take_messages ? 1 : 0) : cur.take_messages,
      s.custom_instructions ?? cur.custom_instructions,
      llmBaseUrl,
      llmKey,
      s.llm_model ?? cur.llm_model,
      engine,
      realtimeModel,
      realtimeVoice,
      biz.id
    );
  await c.env.DB.batch([assistantUpdate, providerUpdate, legacyUpdate, updateCompatibilitySnapshot(c.env, biz.id)]);
  return c.json({ ok: true });
});

app.get('/api/me/business/:id/calls', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT id, channel, caller_id, status, started_at, connected_at, ended_at, duration_s, summary, intent, message_json
     FROM calls WHERE business_id = ? AND environment = 'live' ORDER BY started_at DESC, id DESC LIMIT 100`
  )
    .bind(biz.id)
    .all();
  return c.json(results);
});

app.get('/api/me/calls/:callId', async (c) => {
  const call = await c.env.DB.prepare(
    `SELECT calls.* FROM calls JOIN businesses ON businesses.id = calls.business_id
     WHERE calls.id = ? AND businesses.user_id = ?`
  )
    .bind(c.req.param('callId'), c.get('userId'))
    .first();
  if (!call) return c.json({ error: 'Not found' }, 404);
  const { results: turns } = await c.env.DB.prepare(
    'SELECT id, role, text, ts FROM call_turns WHERE call_id = ? ORDER BY id'
  )
    .bind(c.req.param('callId'))
    .all();
  return c.json({ ...call, turns });
});

async function ownedBusiness(env: Env, userId: string, id: string): Promise<Business | null> {
  return env.DB.prepare('SELECT * FROM businesses WHERE id = ? AND user_id = ?').bind(id, userId).first<Business>();
}

// A custom LLM endpoint is only ever called with the key stored next to it
// (see resolveLlm), so an endpoint without a key is a configuration error.
// Caught on write, where the dashboard can show it, rather than on the call.
function llmEndpointError(env: Env, baseUrl: string, apiKey: string): string | null {
  const url = (baseUrl ?? '').trim();
  if (!url || sameLlmEndpoint(url, env.DEFAULT_LLM_BASE_URL)) return null;
  const rejected = validateLlmBaseUrl(url, env.ALLOW_INSECURE_LLM_URL === 'true');
  if (rejected) return `LLM base URL ${rejected}`;
  if (!apiKey) return 'A custom LLM base URL needs its own API key — this instance never sends its key to another endpoint.';
  return null;
}

// ---------- engine profiles (named voice-engine presets) ----------
const PROFILE_FIELDS = ['engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_base_url', 'llm_api_key', 'llm_model'] as const;
type ProfileFields = Record<(typeof PROFILE_FIELDS)[number], string> & { id: string; name: string; business_id: string };

function maskProfile(p: ProfileFields): ProfileFields & { apiKeyConfigured: boolean } {
  return { ...p, llm_api_key: '', apiKeyConfigured: Boolean(p.llm_api_key) };
}

app.get('/api/me/business/:id/profiles', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const { results } = await c.env.DB.prepare('SELECT * FROM engine_profiles WHERE business_id = ? ORDER BY created_at')
    .bind(biz.id)
    .all<ProfileFields>();
  return c.json(results.map(maskProfile));
});

app.post('/api/me/business/:id/profiles', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<Partial<ProfileFields>>();
  if (!b.name?.trim()) return c.json({ error: 'Profile name required' }, 400);
  const id = newId();
  // A missing/blank value means "snapshot the workspace key". Credentials are
  // never returned by an API, including as a masked placeholder.
  let llmKey = b.llm_api_key ?? '';
  if (!llmKey || /^•+$/.test(llmKey)) {
    const cur = await c.env.DB.prepare('SELECT llm_api_key FROM provider_settings WHERE business_id = ?')
      .bind(biz.id)
      .first<{ llm_api_key: string }>();
    llmKey = cur?.llm_api_key ?? '';
  }
  const bad = llmEndpointError(c.env, b.llm_base_url ?? '', llmKey);
  if (bad) return c.json({ error: bad }, 400);
  const legacyProfile = c.env.DB.prepare(
    `INSERT INTO engine_profiles (id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_base_url, llm_api_key, llm_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
      id,
      biz.id,
      b.name.trim(),
      b.engine === 'realtime' ? 'realtime' : 'pipeline',
      b.realtime_model ?? '',
      b.realtime_voice ?? '',
      b.language?.trim() || 'en',
      b.voice ?? '',
      b.llm_base_url ?? '',
      llmKey,
      b.llm_model ?? ''
    );
  const preset = c.env.DB.prepare(
    `INSERT INTO engine_presets (
      id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
      id,
      biz.id,
      b.name.trim(),
      b.engine === 'realtime' ? 'realtime' : 'pipeline',
      b.realtime_model ?? '',
      b.realtime_voice ?? '',
      b.language?.trim() || 'en',
      b.voice ?? '',
      b.llm_model ?? ''
    );
  await c.env.DB.batch([legacyProfile, preset]);
  const row = await c.env.DB.prepare('SELECT * FROM engine_profiles WHERE id = ?').bind(id).first<ProfileFields>();
  return c.json(maskProfile(row!), 201);
});

async function ownedProfile(env: Env, userId: string, pid: string): Promise<ProfileFields | null> {
  return env.DB.prepare(
    `SELECT engine_profiles.* FROM engine_profiles
     JOIN businesses ON businesses.id = engine_profiles.business_id
     WHERE engine_profiles.id = ? AND businesses.user_id = ?`
  )
    .bind(pid, userId)
    .first<ProfileFields>();
}

app.put('/api/me/profiles/:pid', async (c) => {
  const p = await ownedProfile(c.env, c.get('userId'), c.req.param('pid'));
  if (!p) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<Partial<ProfileFields>>();
  const llmKey = b.llm_api_key !== undefined && b.llm_api_key !== '' && !/^•+$/.test(b.llm_api_key) ? b.llm_api_key : p.llm_api_key;
  const llmBaseUrl = b.llm_base_url ?? p.llm_base_url;
  if (b.language !== undefined && !b.language.trim()) return c.json({ error: 'Profile language is required' }, 400);
  const bad = llmEndpointError(c.env, llmBaseUrl, llmKey);
  if (bad) return c.json({ error: bad }, 400);
  const legacyProfileUpdate = c.env.DB.prepare(
    `UPDATE engine_profiles SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_base_url=?, llm_api_key=?, llm_model=? WHERE id=?`
  ).bind(
      b.name?.trim() || p.name,
      b.engine ?? p.engine,
      b.realtime_model ?? p.realtime_model,
      b.realtime_voice ?? p.realtime_voice,
      b.language ?? p.language,
      b.voice ?? p.voice,
      llmBaseUrl,
      llmKey,
      b.llm_model ?? p.llm_model,
      p.id
    );
  const presetUpdate = c.env.DB.prepare(
    `UPDATE engine_presets SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
     WHERE id=?`
  ).bind(
      b.name?.trim() || p.name,
      b.engine ?? p.engine,
      b.realtime_model ?? p.realtime_model,
      b.realtime_voice ?? p.realtime_voice,
      b.language ?? p.language,
      b.voice ?? p.voice,
      b.llm_model ?? p.llm_model,
      p.id
    );
  await c.env.DB.batch([legacyProfileUpdate, presetUpdate]);
  return c.json({ ok: true });
});

app.delete('/api/me/profiles/:pid', async (c) => {
  const p = await ownedProfile(c.env, c.get('userId'), c.req.param('pid'));
  if (!p) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM engine_profiles WHERE id = ?').bind(p.id),
    c.env.DB.prepare('DELETE FROM engine_presets WHERE id = ?').bind(p.id),
  ]);
  return c.json({ ok: true });
});

// Copy a profile's engine fields onto the live agent settings in one action.
app.post('/api/me/profiles/:pid/apply', async (c) => {
  const p = await ownedProfile(c.env, c.get('userId'), c.req.param('pid'));
  if (!p) return c.json({ error: 'Not found' }, 404);
  // Profiles saved before the endpoint rules existed are re-checked here.
  const bad = llmEndpointError(c.env, p.llm_base_url, p.llm_api_key);
  if (bad) return c.json({ error: `Cannot apply "${p.name}": ${bad}` }, 400);
  if (!p.language.trim()) return c.json({ error: `Cannot apply "${p.name}": language is required` }, 400);
  const legacySettings = c.env.DB.prepare(
    `UPDATE agent_settings SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_base_url=?, llm_api_key=?, llm_model=? WHERE business_id=?`
  ).bind(p.engine, p.realtime_model, p.realtime_voice, p.language, p.voice, p.llm_base_url, p.llm_api_key, p.llm_model, p.business_id);
  const assistantUpdate = c.env.DB.prepare(
    `UPDATE assistants SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_model=?, updated_at=datetime('now')
     WHERE business_id = ? AND public_slug = (SELECT slug FROM businesses WHERE id = ?)`
  ).bind(p.engine, p.realtime_model, p.realtime_voice, p.language, p.voice, p.llm_model, p.business_id, p.business_id);
  const providerUpdate = c.env.DB.prepare(
    `INSERT INTO provider_settings (business_id, llm_base_url, llm_api_key) VALUES (?, ?, ?)
     ON CONFLICT(business_id) DO UPDATE SET llm_base_url=excluded.llm_base_url,
       llm_api_key=excluded.llm_api_key, updated_at=datetime('now')`
  ).bind(p.business_id, p.llm_base_url, p.llm_api_key);
  await c.env.DB.batch([
    legacySettings,
    assistantUpdate,
    providerUpdate,
    updateCompatibilitySnapshot(c.env, p.business_id),
  ]);
  return c.json({ ok: true });
});

// ---------- voice catalogs (aggregated per tier, cached per isolate) ----------
let voicesCache: { data: unknown; at: number } | null = null;

app.get('/api/me/voices', async (c) => {
  if (voicesCache && Date.now() - voicesCache.at < 3_600_000) return c.json(voicesCache.data);
  const out: {
    cascade: { id: string; label: string }[];
    native: { id: string; label: string }[];
    azure: { id: string; label: string }[];
    hdDefault: string;
  } = { cascade: [], native: [], azure: [], hdDefault: '' };
  try {
    const res = await fetch(c.env.REALTIME_BASE_URL.replace(/^ws/, 'http') + '/voices', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const cat = (await res.json()) as {
        'kataleptic-realtime'?: { voices_by_language?: Record<string, string> };
        'kataleptic-realtime-hd'?: { default?: string };
        'gpt-realtime-2'?: { voices?: string[] };
      };
      out.cascade = Object.entries(cat['kataleptic-realtime']?.voices_by_language ?? {}).map(([lang, id]) => ({
        id,
        label: `${id} (${lang})`,
      }));
      out.native = (cat['gpt-realtime-2']?.voices ?? []).map((id) => ({ id, label: id }));
      out.hdDefault = cat['kataleptic-realtime-hd']?.default ?? '';
    }
  } catch {
    /* catalog unavailable — dropdowns degrade to free text */
  }
  try {
    if (c.env.AZURE_SPEECH_KEY) {
      const res = await fetch(`https://${c.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
        headers: { 'Ocp-Apim-Subscription-Key': c.env.AZURE_SPEECH_KEY },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const list = (await res.json()) as { ShortName: string; LocaleName: string }[];
        out.azure = list.map((v) => ({ id: v.ShortName, label: `${v.ShortName} — ${v.LocaleName}` }));
      }
    }
  } catch {
    /* same: free text fallback */
  }
  voicesCache = { data: out, at: Date.now() };
  return c.json(out);
});

const BUSY = 'All lines are busy right now. Please try again in a moment.';

// Only calls that actually opened a WebSocket count, so a caller reloading the
// widget — which leaves a trail of unconnected rows — can never exhaust the
// business's own budget. No age cutoff here on purpose: see STALE_CONNECTED.
//
// Known bound, not a guarantee: this counts *rows*, and only the Durable Object
// can end a session. A row the sweep retires at 60 minutes frees its slot even
// though the socket may still be open, so a caller who holds one that long is no
// longer counted. Terminating that session needs a change inside CallSession,
// which is not in this PR. What still holds meanwhile is the per-business daily
// cap — it counts row creation, so session lifetime cannot dodge it — and the
// per-IP call-start limit.
function countConnected(
  env: Env,
  businessId: string,
  exceptId: string,
  environment: 'test' | 'live'
) {
  return env.DB.prepare(
    `SELECT COUNT(*) AS n FROM calls
      WHERE business_id = ? AND id != ? AND environment = ?
        AND status = 'active' AND connected_at IS NOT NULL`
  ).bind(businessId, exceptId, environment);
}

async function liveCalls(env: Env, businessId: string): Promise<number> {
  return (await countConnected(env, businessId, '', 'live').first<{ n: number }>())?.n ?? 0;
}

// ---------- public widget API ----------
interface PublicAssistantTarget {
  assistant_id: string;
  agent_name: string;
  language: string;
  business_id: string;
  business_name: string;
  workspace_slug: string;
  max_concurrent_calls: number;
  max_calls_per_day: number;
  services_json: string;
  faqs_json: string;
  needs_repair: number;
}

async function activePublicAssistant(env: Env, slug: string): Promise<PublicAssistantTarget | null> {
  const lookup = () =>
    env.DB.prepare(
      `SELECT assistants.id AS assistant_id, assistants.name AS agent_name, assistants.language,
        businesses.id AS business_id, businesses.name AS business_name, businesses.slug AS workspace_slug,
        businesses.max_concurrent_calls, businesses.max_calls_per_day,
        businesses.services_json, businesses.faqs_json,
        CASE WHEN legacy.business_id IS NULL
          OR compatibility.id IS NULL
          OR provider_settings.business_id IS NULL
          OR sync.business_id IS NULL
          OR (compatibility.state <> 'draft' AND (
            compatibility.name <> legacy.agent_name
            OR compatibility.greeting <> legacy.greeting
            OR compatibility.persona <> legacy.persona
            OR compatibility.language <> legacy.language
            OR compatibility.voice <> legacy.voice
            OR compatibility.take_messages <> legacy.take_messages
            OR compatibility.custom_instructions <> legacy.custom_instructions
            OR compatibility.engine <> legacy.engine
            OR compatibility.realtime_model <> legacy.realtime_model
            OR compatibility.realtime_voice <> legacy.realtime_voice
            OR compatibility.llm_model <> legacy.llm_model
          ))
          OR provider_settings.llm_base_url <> legacy.llm_base_url
          OR provider_settings.llm_api_key <> legacy.llm_api_key
          OR sync.services_json <> businesses.services_json
          OR sync.faqs_json <> businesses.faqs_json
          OR default_collection.id IS NULL
          OR sync.collection_id <> default_collection.id
          OR sync.agent_snapshot <> json_object(
            'agent_name', legacy.agent_name, 'greeting', legacy.greeting,
            'persona', legacy.persona, 'language', legacy.language,
            'voice', legacy.voice, 'take_messages', legacy.take_messages,
            'custom_instructions', legacy.custom_instructions, 'engine', legacy.engine,
            'realtime_model', legacy.realtime_model, 'realtime_voice', legacy.realtime_voice,
            'llm_model', legacy.llm_model
          )
          THEN 1 ELSE 0 END AS needs_repair
       FROM assistants
       JOIN businesses ON businesses.id = assistants.business_id
       LEFT JOIN assistants compatibility
         ON compatibility.business_id=businesses.id AND compatibility.public_slug=businesses.slug
       LEFT JOIN agent_settings legacy ON legacy.business_id=businesses.id
       LEFT JOIN provider_settings ON provider_settings.business_id=businesses.id
       LEFT JOIN compatibility_sync_state sync ON sync.business_id=businesses.id
       LEFT JOIN knowledge_collections default_collection
         ON default_collection.id=(
           SELECT id FROM knowledge_collections
            WHERE business_id=businesses.id AND is_default=1
            ORDER BY created_at, id LIMIT 1
         )
       WHERE assistants.public_slug = ? AND assistants.state = 'active'`
    )
      .bind(slug)
      .first<PublicAssistantTarget>();
  const reconcile = async (current: PublicAssistantTarget): Promise<PublicAssistantTarget> => {
    let repaired = current;
    for (let attempt = 0; repaired.needs_repair && attempt < 2; attempt++) {
      await ensureWorkspaceFoundation(env, {
        id: repaired.business_id,
        slug: repaired.workspace_slug,
        services_json: repaired.services_json,
        faqs_json: repaired.faqs_json,
      });
      repaired = (await lookup()) ?? repaired;
    }
    if (repaired.needs_repair) throw new Error('Workspace configuration changed during call setup');
    return repaired;
  };
  let target = await lookup();
  if (target) return reconcile(target);
  const existingAssistant = await env.DB.prepare(
    `SELECT assistants.state, businesses.id AS business_id, businesses.slug AS workspace_slug,
      businesses.services_json, businesses.faqs_json,
      assistants.public_slug = businesses.slug AS is_compatibility,
      CASE WHEN legacy.business_id IS NULL OR sync.business_id IS NULL
        OR sync.agent_snapshot <> json_object(
          'agent_name', legacy.agent_name, 'greeting', legacy.greeting,
          'persona', legacy.persona, 'language', legacy.language,
          'voice', legacy.voice, 'take_messages', legacy.take_messages,
          'custom_instructions', legacy.custom_instructions, 'engine', legacy.engine,
          'realtime_model', legacy.realtime_model, 'realtime_voice', legacy.realtime_voice,
          'llm_model', legacy.llm_model
        ) THEN 1 ELSE 0 END AS needs_repair
     FROM assistants
     JOIN businesses ON businesses.id=assistants.business_id
     LEFT JOIN agent_settings legacy ON legacy.business_id=businesses.id
     LEFT JOIN compatibility_sync_state sync ON sync.business_id=businesses.id
     WHERE assistants.public_slug = ? LIMIT 1`
  )
    .bind(slug)
    .first<{
      state: 'draft' | 'active' | 'paused';
      business_id: string;
      workspace_slug: string;
      services_json: string;
      faqs_json: string;
      is_compatibility: number;
      needs_repair: number;
    }>();
  if (existingAssistant) {
    if (
      existingAssistant.state !== 'draft' ||
      !existingAssistant.is_compatibility ||
      !existingAssistant.needs_repair
    ) {
      return null;
    }
    await ensureWorkspaceFoundation(env, {
      id: existingAssistant.business_id,
      slug: existingAssistant.workspace_slug,
      services_json: existingAssistant.services_json,
      faqs_json: existingAssistant.faqs_json,
    });
    target = await lookup();
    return target ? reconcile(target) : null;
  }
  // Repair a workspace/profile an old worker created after migration 0008 but
  // before this worker version took traffic. The normal path above remains a
  // read-only lookup; reconciliation runs only for a missing legacy slug.
  const legacy = await env.DB.prepare('SELECT * FROM businesses WHERE slug = ?').bind(slug).first<Business>();
  if (!legacy) return null;
  await ensureWorkspaceFoundation(env, legacy);
  target = await lookup();
  return target ? reconcile(target) : null;
}

app.get('/api/public/agent/:slug', async (c) => {
  const agent = await activePublicAssistant(c.env, c.req.param('slug'));
  if (!agent) return c.json({ error: 'Not found' }, 404);
  return c.json({
    assistantId: agent.assistant_id,
    businessName: agent.business_name,
    agentName: agent.agent_name,
    language: agent.language,
  });
});

app.post('/api/public/call/start', async (c) => {
  const { slug } = await c.req.json<{ slug?: string }>();
  // The per-IP ceilings were already applied by the /api/public/* middleware.
  const addr = clientIp(c);
  const target = await activePublicAssistant(c.env, slug ?? '');
  if (!target) return c.json({ error: 'Unknown or unavailable assistant' }, 404);

  if ((await liveCalls(c.env, target.business_id)) >= target.max_concurrent_calls) {
    return tooMany(c, BUSY, 30);
  }

  // Daily ceiling on the owner's provider spend. It is an availability trade the
  // owner controls: better to go quiet than to wake up to a six-figure bill.
  //
  // One conditional statement: the row is inserted only if the day's count is
  // under the cap, so a refusal writes nothing at all. Counting first and then
  // inserting would be a TOCTOU the measured burst walks straight through — at
  // 576 requests/sec every concurrent request reads a count under the cap and
  // every one of them inserts — and inserting first and deleting on refusal, as
  // this did, charged two `calls` writes plus their index updates for every
  // rejection. That is the refusal-is-free property the limiter already has,
  // applied to the row the limiter is protecting.
  //
  // A swept never-connected row is excluded from the count, because it is the one
  // shape that provably cost nothing: the sweeper retired it, so its id can no
  // longer attach, and it never reached a Durable Object to spend anything.
  // Counting those turns a cap on *spend* into a cap on junk — a pre-upgrade
  // burst above the limit would leave a business dark for a day the moment it
  // migrated, and one address could reproduce that on purpose at ten ids a minute
  // without ever opening a socket.
  //
  // Still-'active' rows do count even with no connection yet: an unattached but
  // live ticket is a real reservation someone can still redeem. It stops counting
  // when the sweep retires it, not before.
  const callId = newId();
  const claim = await c.env.DB.prepare(
    `INSERT INTO calls (id, business_id, assistant_id, channel, caller_id, environment, direction)
     SELECT ?, ?, ?, 'web', ?, 'live', 'inbound'
      WHERE (SELECT COUNT(*) FROM calls
              WHERE business_id = ? AND environment = 'live' AND started_at > datetime('now', '-1 day')
                AND NOT (status = 'abandoned' AND connected_at IS NULL)) < ?`
  )
    .bind(
      callId,
      target.business_id,
      target.assistant_id,
      addr === 'local' ? 'anonymous' : addr,
      target.business_id,
      target.max_calls_per_day
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    return tooMany(c, 'This agent has reached its daily call limit. Please try again tomorrow.', 3600);
  }
  return c.json({ callId });
});

// ---------- websocket -> Durable Object ----------
app.get('/ws/call/:callId', async (c) => {
  const callId = c.req.param('callId');
  // Before anything touches the database. connected_at is what the concurrency
  // cap counts, so a plain GET that could write it would let anyone make a
  // business look busy for the length of the stale window at no cost — and
  // without ever opening a socket. CallSession answers 426 to the same check.
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected websocket' }, 426);
  }
  // The socket route sits outside /api/public/*, but an Upgrade still performs
  // call lookup and an atomic capacity claim. Share the same per-IP request
  // bucket so random ids and replayed tickets cannot bypass the public budget.
  const handshake = await consumePublic(c.env, clientIp(c), false);
  if (handshake.overAll) {
    return tooMany(c, 'Too many requests. Please wait a moment and try again.', LIMITS.publicApi.window);
  }
  // Bounded by started_at, not just status: a callId that has sat unused past
  // the stale window is not attachable, even before the sweeper retires it.
  const call = await c.env.DB.prepare(
    `SELECT calls.id, calls.business_id, calls.assistant_id, calls.environment,
      businesses.user_id, businesses.slug AS workspace_slug,
      businesses.services_json, businesses.faqs_json, businesses.max_concurrent_calls
       FROM calls JOIN businesses ON businesses.id = calls.business_id
      WHERE calls.id = ? AND calls.status = 'active' AND calls.started_at > datetime('now', ?)`
  )
    .bind(callId, STALE_UNCONNECTED)
    .first<{
      id: string;
      business_id: string;
      assistant_id: string | null;
      environment: 'test' | 'live';
      user_id: string;
      workspace_slug: string;
      services_json: string;
      faqs_json: string;
      max_concurrent_calls: number;
    }>();
  if (!call) return c.json({ error: 'call not found' }, 404);
  if (call.environment === 'test') {
    const userId = await getUserIdFromSession(c.env, getCookie(c, COOKIE));
    if (userId !== call.user_id) return c.json({ error: 'call not found' }, 404);
  }
  if (call.environment === 'live' && !call.assistant_id) {
    // During a rolling deploy, an old worker can create both the workspace and
    // a live ticket after migration 0008, before any new-worker public lookup
    // has materialized its compatibility assistant. Repair that canonical
    // assistant before the atomic active-state claim below.
    await ensureWorkspaceFoundation(c.env, {
      id: call.business_id,
      slug: call.workspace_slug,
      services_json: call.services_json,
      faqs_json: call.faqs_json,
    });
  }
  // The Durable Object — and every provider request it makes — starts here, so
  // this is where the concurrency cap has to bite. Checking only at /call/start
  // would let a minute's worth of call ids become that many simultaneous
  // sessions, which is the shape of the measured attack.
  //
  // Claim the slot and count it in one batch, i.e. one D1 transaction. Counting
  // first and marking after loses the race: fifty sockets opened at once all
  // read zero live calls and all get in.
  //
  // The UPDATE is conditional, so its affected-row count says whether *this*
  // request is the one that took the slot. Zero means the id was already
  // connected, and a second attach on a live id is refused outright: it would
  // ride one row's slot while driving a second session's worth of provider work,
  // and both caps would count it once. (CallSession's own half of that bug — the
  // socket swap — is fixed separately; refusing at the route is cheap and does
  // not depend on which lands first.)
  const claim = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare(
      `UPDATE calls SET connected_at = datetime('now')
        WHERE id = ? AND connected_at IS NULL
          AND (environment = 'test' OR EXISTS (
            SELECT 1 FROM assistants
             WHERE assistants.business_id=calls.business_id
               AND assistants.state='active'
               AND (
                 assistants.id=calls.assistant_id
                 OR (
                   calls.assistant_id IS NULL
                   AND assistants.public_slug=(SELECT slug FROM businesses WHERE id=calls.business_id)
                 )
               )
          ))`
    ).bind(callId),
    countConnected(c.env, call.business_id, callId, call.environment),
  ]);
  if ((claim[0].meta.changes ?? 0) !== 1) {
    return c.json({ error: 'call already connected' }, 409);
  }
  if ((claim[1].results[0]?.n ?? 0) >= call.max_concurrent_calls) {
    // Release the slot we just claimed, so a refused attach cannot hold a line
    // open until the sweeper next runs. connected_at goes back to NULL with it:
    // this row never reached a Durable Object, and leaving the marker set would
    // show it in the dashboard as a real conversation that got cut off.
    await c.env.DB.prepare(
      "UPDATE calls SET status = 'abandoned', connected_at = NULL, ended_at = datetime('now') WHERE id = ?"
    )
      .bind(callId)
      .run();
    return c.json({ error: BUSY }, 429, { 'Retry-After': '30' });
  }
  const id = c.env.CALL_SESSION.idFromName(callId);
  const stub = c.env.CALL_SESSION.get(id);
  const url = new URL(c.req.raw.url);
  url.searchParams.set('call', callId);
  // Hand the slot back only on an answer that proves no session owns this call.
  //
  // Not every error qualifies, and 409 is the counter-example that matters:
  // CallSession returns it for "already connected", meaning a session *is* live
  // on this row. Releasing then clears a live call's slot. That is reachable
  // without any race — during a rollout an older worker serves calls without
  // writing connected_at, so a second attach can claim a row whose session is
  // already running, get the 409, and knock the live call out of the concurrency
  // count until the sweep repairs it from its turns.
  //
  // 426 is the safe one: CallSession answers it before touching any state, so
  // nothing was started. A rejected fetch is safe for the same reason — the
  // object was never reached. Anything else keeps the marker; holding a slot a
  // little too long is recoverable, releasing a live one is not.
  const releaseSlot = () =>
    c.env.DB.prepare('UPDATE calls SET connected_at = NULL WHERE id = ?').bind(callId).run();
  // Normalized, because the two checks are not the same check. This route
  // compares case-insensitively, as RFC 6455 requires; CallSession compares
  // against the literal 'websocket'. So `Upgrade: WebSocket` passed here, claimed
  // the slot, and came back 426 — which then released it without retiring the
  // row, leaving the id replayable until the stale cutoff, two UPDATEs a go, on a
  // path that sits outside the rate limiter. Sending the canonical value means
  // both checks reach the same verdict.
  const headers = new Headers(c.req.raw.headers);
  headers.set('Upgrade', 'websocket');
  let res: Response;
  try {
    res = await stub.fetch(new Request(url.toString(), { method: 'GET', headers }));
  } catch (err) {
    await releaseSlot();
    console.error('call session unreachable', err);
    return c.json({ error: 'could not reach the call session' }, 502);
  }
  if (res.status === 426) await releaseSlot();
  return res;
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'openfon' }));

// ---------- cron sweep ----------
// A row whose WebSocket never opened has no Durable Object, so no alarm inside
// CallSession can ever rescue it — only a scheduled pass over the table can.
// The second query covers the other stranding path: a worker restart (i.e. every
// deploy) leaves whatever was in flight 'active' with no ended_at.
// The two branches age from different columns, so they are written out rather
// than sharing a template — the column is the part that differs, and hiding it
// behind a parameter is how it came to be wrong in the first place.
//
// connected_at's NULL-ness is a moving target for as long as two worker versions
// can serve, so the sweep repairs it at runtime rather than trusting a migration
// to have established it. See the first statement.
//
// This is a FLOOR, not a retry, and the difference matters to anything thinking
// of leaning on it. The write is terminal: CallSession.finalize() selects
// `WHERE id = ? AND status = 'active'` and returns early when that misses, so
// once a row is swept no later attempt can ever complete it. summary, intent,
// message_json and duration_s are written only by that one finalize UPDATE, so a
// call this sweep retires never gets any of them — including the structured
// callback message a caller left. call_turns are written per turn, so the raw
// transcript survives and the row reads "Call interrupted"; the extracted
// message does not. Recovering a failed finalize is worth doing where the
// session still exists, because only there can a summary still be produced.
export async function sweepStaleCalls(env: Env, now = Date.now()): Promise<number> {
  const res = await env.DB.batch([
    // Reconcile before classifying. A row with saved turns reached a Durable
    // Object by definition, so connected_at IS NULL there means the row was
    // served by a worker that predates the column — which is not only ancient
    // history: `npm run deploy` applies migrations *before* uploading, so the old
    // worker keeps serving through the rollout and every call it takes in that
    // window lands with a NULL. The migration's one-time backfill cannot see
    // those; it already ran. Classified as-is they take the never-dialled branch
    // and a real transcript gets labelled "Never connected".
    //
    // Same COALESCE rule the migration uses, for the same reason: MIN(ts) trails
    // the real connect by one greeting, started_at is early by at most the attach
    // window, and either beats NULL, which asserts something known to be false.
    // Runs inside the batch, so the two statements below see the repair.
    env.DB.prepare(
      `UPDATE calls SET connected_at = COALESCE(
           (SELECT MIN(ts) FROM call_turns WHERE call_turns.call_id = calls.id),
           started_at
         )
        WHERE status = 'active' AND connected_at IS NULL
          AND EXISTS (SELECT 1 FROM call_turns WHERE call_turns.call_id = calls.id)`
    ),
    // Never dialled: measured from when the id was handed out, because that is
    // the only timestamp such a row has.
    env.DB.prepare(
      `UPDATE calls SET status = 'abandoned', ended_at = datetime('now')
        WHERE status = 'active' AND connected_at IS NULL AND started_at < datetime('now', ?)`
    ).bind(STALE_UNCONNECTED),
    // Connected: measured from when the session began, not when the row was
    // created. Attachment is allowed for 15 minutes after creation, so ageing
    // this branch from started_at would retire a caller who connected at minute
    // 14 only 46 minutes into their call — cut off mid-conversation, and
    // mislabelled as interrupted on the way out.
    env.DB.prepare(
      `UPDATE calls SET status = 'abandoned', ended_at = datetime('now')
        WHERE status = 'active' AND connected_at IS NOT NULL AND connected_at < datetime('now', ?)`
    ).bind(STALE_CONNECTED),
    // Fixed-window counters are only read for the current window; a day of
    // history is plenty of slack for the longest limiter.
    env.DB.prepare('DELETE FROM rate_counters WHERE window_start < ?').bind(Math.floor(now / 1000) - 86400),
    // Expired sessions were never removed by anything. That was survivable while
    // rows only arrived when a person signed in; it stopped being survivable once
    // it became clear a caller with valid credentials can mint them in a loop.
    // The login allowance bounds the rate, this bounds the residue.
    //
    // The cutoff is generated here rather than by datetime('now') because
    // createSession stores toISOString() and SQLite compares these as TEXT: the
    // 'T' separator sorts after datetime()'s space, so every session that expired
    // earlier *today* sorted above the cutoff and survived until the date rolled
    // over. Same producer on both sides is the only way that comparison is sound.
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()),
  ]);
  // Retired rows only — the reconciliation at res[0] repairs, it does not retire.
  return (res[1].meta.changes ?? 0) + (res[2].meta.changes ?? 0);
}

export default {
  fetch: app.fetch,
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(sweepStaleCalls(env));
  },
} satisfies ExportedHandler<Env>;
