import { asteriskAuthBudget } from './asterisk-auth-budget';
import { verifyPassword } from './auth';
import type { Hono } from 'hono';
import type { Env } from './types';

export async function asteriskDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export const ASTERISK_ADMISSION_HEADER = 'X-Openfon-Asterisk-Admission';
type AsteriskCredential = { business_id: string; assistant_id: string; password_hash: string | null };
export function asteriskAdmissionVersion(route: string, credential: AsteriskCredential): Promise<string> {
  return asteriskDigest(JSON.stringify([route, credential.business_id, credential.assistant_id, credential.password_hash]));
}
/** Binding-only route handoff, not a public credential. Public ingress builds a
 * new request and never forwards caller-supplied admission headers. */
export async function validateAsteriskAdmission(env: Env, route: string, version: string | null): Promise<AsteriskCredential | null> {
  if (env.ASTERISK_ENABLED !== 'true' || !version || !/^[a-f0-9]{64}$/.test(version)) return null;
  const credential = await env.DB.prepare('SELECT business_id,assistant_id,password_hash FROM asterisk_routes WHERE id=? AND enabled=1').bind(route).first<AsteriskCredential>();
  return credential?.password_hash && await asteriskAdmissionVersion(route, credential) === version ? credential : null;
}
export async function authenticateAsterisk(env: Env, route: string, authorization: string | null): Promise<boolean> {
  return Boolean(await authorizeAsterisk(env, route, authorization));
}
export async function authorizeAsterisk(env: Env, route: string, authorization: string | null): Promise<string | null> {
  if (env.ASTERISK_ENABLED !== 'true' || !authorization || authorization.length > 1024 || !authorization.startsWith('Basic ')) return null;
  let decoded: string;
  try { decoded = atob(authorization.slice(6)); } catch { return null; }
  const split = decoded.indexOf(':');
  if (split < 1 || decoded.slice(0, split) !== route || decoded.length - split - 1 < 32) return null;
  const password = decoded.slice(split + 1);
  // Basic authentication and provisioning share an unambiguous byte contract.
  if (!/^[A-Za-z0-9_-]{32,512}$/.test(password)) return null;
  const release = asteriskAuthBudget.acquire();
  if (!release) return null;
  try {
    const credential = await env.DB.prepare('SELECT business_id,assistant_id,password_hash FROM asterisk_routes WHERE id=? AND enabled=1').bind(route).first<AsteriskCredential>();
    if (!credential?.password_hash || !await verifyPassword(password, credential.password_hash)) return null;
    // Revocation or rotation during the asynchronous KDF must win this admission.
    const current = await env.DB.prepare('SELECT id FROM asterisk_routes WHERE id=? AND enabled=1 AND password_hash=? AND business_id=? AND assistant_id=?').bind(route, credential.password_hash, credential.business_id, credential.assistant_id).first();
    return current ? asteriskAdmissionVersion(route, credential) : null;
  } finally { release(); }
}
export function registerAsteriskRoutes(app: Hono<{ Bindings: Env; Variables: { userId: string } }>): void {
  app.get('/ws/asterisk/:route', async c => {
    if (c.env.ASTERISK_ENABLED !== 'true' || !c.env.ASTERISK_CALL) return c.json({ error: 'PBX ingress unavailable' }, 503);
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'Expected websocket' }, 426);
    const route = c.req.param('route');
    const call = c.req.query('call') || '';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(route) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(call)) return c.json({ error: 'Invalid PBX route or call' }, 400);
    // Rejected public handshakes must not consume the database write budget.
    const authorization = c.req.header('Authorization') || null;
    const version = await authorizeAsterisk(c.env, route, authorization);
    if (!version) return c.json({ error: 'Invalid PBX authorization' }, 401, { 'WWW-Authenticate': 'Basic realm="OpenFon PBX"' });
    const source = c.req.header('CF-Connecting-IP')?.trim() || 'unknown';
    const admitted = await c.env.DB.prepare(`INSERT INTO rate_counters(bucket,window_start,count) VALUES(?,?,1)
      ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1 WHERE count<120 RETURNING count`)
      .bind(`asterisk:${source}`, Math.floor(Date.now()/60000)*60).first();
    if (!admitted) return c.json({ error: 'Too many attempts' }, 429);
    const id = `ast_${await asteriskDigest(`${route}\0${call}`)}`;
    const stub = c.env.ASTERISK_CALL.get(c.env.ASTERISK_CALL.idFromName(id));
    return stub.fetch(new Request(`https://internal/media?call=${id}&route=${encodeURIComponent(route)}`, {
      headers: { Upgrade: 'websocket', [ASTERISK_ADMISSION_HEADER]: version, 'Sec-WebSocket-Protocol': 'media' },
    }));
  });
}
