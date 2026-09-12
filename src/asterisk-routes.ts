import type { Hono } from 'hono';
import type { Env } from './types';

export async function asteriskDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function authenticateAsterisk(env: Env, route: string, authorization: string | null): Promise<boolean> {
  if (!authorization || authorization.length > 1024 || !authorization.startsWith('Basic ')) return false;
  let decoded: string;
  try { decoded = atob(authorization.slice(6)); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 1 || decoded.slice(0, split) !== route || decoded.length - split - 1 < 32) return false;
  const hash = await asteriskDigest(decoded.slice(split + 1));
  return Boolean(await env.DB.prepare('SELECT id FROM asterisk_routes WHERE id=? AND password_sha256=? AND enabled=1').bind(route, hash).first());
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
    if (!await authenticateAsterisk(c.env, route, authorization)) return c.json({ error: 'Invalid PBX authorization' }, 401, { 'WWW-Authenticate': 'Basic realm="OpenFon PBX"' });
    const source = c.req.header('CF-Connecting-IP')?.trim() || 'unknown';
    const admitted = await c.env.DB.prepare(`INSERT INTO rate_counters(bucket,window_start,count) VALUES(?,?,1)
      ON CONFLICT(bucket,window_start) DO UPDATE SET count=count+1 WHERE count<120 RETURNING count`)
      .bind(`asterisk:${source}`, Math.floor(Date.now()/60000)*60).first();
    if (!admitted) return c.json({ error: 'Too many attempts' }, 429);
    const id = `ast_${await asteriskDigest(`${route}\0${call}`)}`;
    const stub = c.env.ASTERISK_CALL.get(c.env.ASTERISK_CALL.idFromName(id));
    return stub.fetch(new Request(`https://internal/media?call=${id}&route=${encodeURIComponent(route)}`, {
      headers: { Upgrade: 'websocket', Authorization: authorization!, 'Sec-WebSocket-Protocol': 'media' },
    }));
  });
}
