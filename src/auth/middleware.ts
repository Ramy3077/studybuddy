import type { Context, Next } from 'hono';
import { verifyJwt } from './jwt.js';

export interface AuthVars {
  userId: string;
  email: string;
}

/** Require a valid Bearer JWT. Validates the token signature + expiry
 * server-side and pins the authenticated user id onto the context. */
export async function requireAuth(c: Context<{ Variables: AuthVars }>, next: Next) {
  const header = c.req.header('authorization') ?? '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: 'missing bearer token' }, 401);
  const payload = verifyJwt(m[1]!);
  if (!payload) return c.json({ error: 'invalid or expired token' }, 401);
  c.set('userId', payload.sub);
  c.set('email', payload.email);
  await next();
}
