import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, Business, AgentSettings } from './types';
import { createSession, deleteSession, getUserIdFromSession, hashPassword, newId, verifyPassword } from './auth';
import { sameLlmEndpoint, validateLlmBaseUrl } from './providers';
import { CallSession } from './call-session';

export { CallSession };

type Vars = { userId: string };
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
  return `${base || 'business'}-${newToken4()}`;
}
function newToken4(): string {
  return [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json<{ email?: string; password?: string }>();
  const user = await c.env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind((email ?? '').toLowerCase())
    .first<{ id: string; password_hash: string }>();
  if (!user || !password || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'Invalid email or password' }, 401);
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

app.get('/api/me/business', async (c) => {
  const biz = await c.env.DB.prepare('SELECT * FROM businesses WHERE user_id = ? LIMIT 1')
    .bind(c.get('userId'))
    .first<Business>();
  if (!biz) return c.json(null);
  const settings = await c.env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
    .bind(biz.id)
    .first<AgentSettings>();
  return c.json({ ...biz, agent: settings ? maskSettings(settings) : null });
});

app.post('/api/me/business', async (c) => {
  const body = await c.req.json<Partial<Business>>();
  if (!body.name?.trim()) return c.json({ error: 'Business name required' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM businesses WHERE user_id = ?').bind(c.get('userId')).first();
  if (existing) return c.json({ error: 'Business already exists; use PUT to update' }, 409);
  const id = newId();
  const slug = slugify(body.name);
  await c.env.DB.prepare(
    `INSERT INTO businesses (id, user_id, slug, name, description, address, phone, website, timezone, hours_json, services_json, faqs_json, closures_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      c.get('userId'),
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
    )
    .run();
  await c.env.DB.prepare('INSERT INTO agent_settings (business_id) VALUES (?)').bind(id).run();
  const biz = await c.env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first<Business>();
  return c.json(biz, 201);
});

app.put('/api/me/business/:id', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const b = await c.req.json<Partial<Business>>();
  await c.env.DB.prepare(
    `UPDATE businesses SET name=?, description=?, address=?, phone=?, website=?, timezone=?, hours_json=?, services_json=?, faqs_json=?, closures_json=? WHERE id=?`
  )
    .bind(
      b.name?.trim() || biz.name,
      b.description ?? biz.description,
      b.address ?? biz.address,
      b.phone ?? biz.phone,
      b.website ?? biz.website,
      b.timezone ?? biz.timezone,
      b.hours_json ?? biz.hours_json,
      b.services_json ?? biz.services_json,
      b.faqs_json ?? biz.faqs_json,
      b.closures_json ?? biz.closures_json,
      biz.id
    )
    .run();
  return c.json({ ok: true });
});

app.put('/api/me/business/:id/agent', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const cur = await c.env.DB.prepare('SELECT * FROM agent_settings WHERE business_id = ?')
    .bind(biz.id)
    .first<AgentSettings>();
  if (!cur) return c.json({ error: 'Not found' }, 404);
  const s = await c.req.json<Partial<AgentSettings>>();
  // "••••" placeholder from the UI means "keep the stored key"
  const llmKey = s.llm_api_key !== undefined && !/^•+$/.test(s.llm_api_key) ? s.llm_api_key : cur.llm_api_key;
  const engine = s.engine === 'realtime' ? 'realtime' : s.engine === 'pipeline' ? 'pipeline' : cur.engine;
  const realtimeModel = s.realtime_model !== undefined ? s.realtime_model : cur.realtime_model;
  const realtimeVoice = s.realtime_voice !== undefined ? s.realtime_voice : cur.realtime_voice;
  const llmBaseUrl = s.llm_base_url ?? cur.llm_base_url;
  const bad = llmEndpointError(c.env, llmBaseUrl, llmKey);
  if (bad) return c.json({ error: bad }, 400);
  await c.env.DB.prepare(
    `UPDATE agent_settings SET agent_name=?, greeting=?, persona=?, language=?, voice=?, take_messages=?, custom_instructions=?, llm_base_url=?, llm_api_key=?, llm_model=?, engine=?, realtime_model=?, realtime_voice=? WHERE business_id=?`
  )
    .bind(
      s.agent_name ?? cur.agent_name,
      s.greeting ?? cur.greeting,
      s.persona ?? cur.persona,
      s.language ?? cur.language,
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
    )
    .run();
  return c.json({ ok: true });
});

app.get('/api/me/business/:id/calls', async (c) => {
  const biz = await ownedBusiness(c.env, c.get('userId'), c.req.param('id'));
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT id, channel, caller_id, status, started_at, ended_at, duration_s, summary, intent, message_json
     FROM calls WHERE business_id = ? ORDER BY started_at DESC LIMIT 100`
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
    'SELECT role, text, ts FROM call_turns WHERE call_id = ? ORDER BY id'
  )
    .bind(c.req.param('callId'))
    .all();
  return c.json({ ...call, turns });
});

async function ownedBusiness(env: Env, userId: string, id: string): Promise<Business | null> {
  return env.DB.prepare('SELECT * FROM businesses WHERE id = ? AND user_id = ?').bind(id, userId).first<Business>();
}

function maskSettings(s: AgentSettings): AgentSettings {
  return { ...s, llm_api_key: s.llm_api_key ? '••••••••' : '' };
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

function maskProfile(p: ProfileFields): ProfileFields {
  return { ...p, llm_api_key: p.llm_api_key ? '••••••••' : '' };
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
  // '••••' means "snapshot the key currently in agent_settings"
  let llmKey = b.llm_api_key ?? '';
  if (/^•+$/.test(llmKey)) {
    const cur = await c.env.DB.prepare('SELECT llm_api_key FROM agent_settings WHERE business_id = ?')
      .bind(biz.id)
      .first<{ llm_api_key: string }>();
    llmKey = cur?.llm_api_key ?? '';
  }
  const bad = llmEndpointError(c.env, b.llm_base_url ?? '', llmKey);
  if (bad) return c.json({ error: bad }, 400);
  await c.env.DB.prepare(
    `INSERT INTO engine_profiles (id, business_id, name, engine, realtime_model, realtime_voice, language, voice, llm_base_url, llm_api_key, llm_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      biz.id,
      b.name.trim(),
      b.engine === 'realtime' ? 'realtime' : 'pipeline',
      b.realtime_model ?? '',
      b.realtime_voice ?? '',
      b.language ?? 'en',
      b.voice ?? '',
      b.llm_base_url ?? '',
      llmKey,
      b.llm_model ?? ''
    )
    .run();
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
  const llmKey = b.llm_api_key !== undefined && !/^•+$/.test(b.llm_api_key) ? b.llm_api_key : p.llm_api_key;
  const llmBaseUrl = b.llm_base_url ?? p.llm_base_url;
  const bad = llmEndpointError(c.env, llmBaseUrl, llmKey);
  if (bad) return c.json({ error: bad }, 400);
  await c.env.DB.prepare(
    `UPDATE engine_profiles SET name=?, engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_base_url=?, llm_api_key=?, llm_model=? WHERE id=?`
  )
    .bind(
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
    )
    .run();
  return c.json({ ok: true });
});

app.delete('/api/me/profiles/:pid', async (c) => {
  const p = await ownedProfile(c.env, c.get('userId'), c.req.param('pid'));
  if (!p) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.prepare('DELETE FROM engine_profiles WHERE id = ?').bind(p.id).run();
  return c.json({ ok: true });
});

// Copy a profile's engine fields onto the live agent settings in one action.
app.post('/api/me/profiles/:pid/apply', async (c) => {
  const p = await ownedProfile(c.env, c.get('userId'), c.req.param('pid'));
  if (!p) return c.json({ error: 'Not found' }, 404);
  // Profiles saved before the endpoint rules existed are re-checked here.
  const bad = llmEndpointError(c.env, p.llm_base_url, p.llm_api_key);
  if (bad) return c.json({ error: `Cannot apply "${p.name}": ${bad}` }, 400);
  await c.env.DB.prepare(
    `UPDATE agent_settings SET engine=?, realtime_model=?, realtime_voice=?, language=?, voice=?, llm_base_url=?, llm_api_key=?, llm_model=? WHERE business_id=?`
  )
    .bind(p.engine, p.realtime_model, p.realtime_voice, p.language, p.voice, p.llm_base_url, p.llm_api_key, p.llm_model, p.business_id)
    .run();
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

// ---------- public widget API ----------
app.get('/api/public/agent/:slug', async (c) => {
  const biz = await c.env.DB.prepare('SELECT id, name, slug FROM businesses WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<{ id: string; name: string; slug: string }>();
  if (!biz) return c.json({ error: 'Not found' }, 404);
  const settings = await c.env.DB.prepare('SELECT agent_name, language FROM agent_settings WHERE business_id = ?')
    .bind(biz.id)
    .first<{ agent_name: string; language: string }>();
  return c.json({ businessName: biz.name, agentName: settings?.agent_name ?? 'Alex', language: settings?.language ?? 'en' });
});

app.post('/api/public/call/start', async (c) => {
  const { slug } = await c.req.json<{ slug?: string }>();
  const biz = await c.env.DB.prepare('SELECT id FROM businesses WHERE slug = ?')
    .bind(slug ?? '')
    .first<{ id: string }>();
  if (!biz) return c.json({ error: 'Unknown agent' }, 404);
  const callId = newId();
  await c.env.DB.prepare('INSERT INTO calls (id, business_id, channel, caller_id) VALUES (?, ?, ?, ?)')
    .bind(callId, biz.id, 'web', c.req.header('CF-Connecting-IP') ?? 'anonymous')
    .run();
  return c.json({ callId });
});

// ---------- websocket -> Durable Object ----------
app.get('/ws/call/:callId', async (c) => {
  const callId = c.req.param('callId');
  const exists = await c.env.DB.prepare('SELECT id FROM calls WHERE id = ? AND status = ?')
    .bind(callId, 'active')
    .first();
  if (!exists) return c.json({ error: 'call not found' }, 404);
  const id = c.env.CALL_SESSION.idFromName(callId);
  const stub = c.env.CALL_SESSION.get(id);
  const url = new URL(c.req.raw.url);
  url.searchParams.set('call', callId);
  return stub.fetch(new Request(url.toString(), c.req.raw));
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'openfon' }));

export default app;
