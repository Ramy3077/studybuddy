import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/server/app.js';
import { adminPool } from '../src/db/pool.js';
import { ensureBootstrap } from '../src/db/bootstrap.js';
import { GUEST_EMAIL_DOMAIN } from '../src/demo/seed.js';
import { createUser, deleteUser } from './helpers.js';

const app = createApp();
const cleanup: string[] = [];
afterAll(async () => {
  for (const id of cleanup) await deleteUser(id);
});

describe('public demo', () => {
  it('guest login creates a fresh, enrolled account that can fetch questions', async () => {
    const res = await app.request('/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string; email: string } };
    cleanup.push(body.user.id);
    expect(body.user.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`)).toBe(true);

    const next = await app.request('/api/quiz/next?limit=1', { headers: { authorization: `Bearer ${body.token}` } });
    expect(next.status).toBe(200); // enrolled, so not 403
  });

  it('guest accounts have no usable password', async () => {
    const res = await app.request('/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: '{}',
    });
    const body = (await res.json()) as { user: { id: string; email: string } };
    cleanup.push(body.user.id);
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: JSON.stringify({ email: body.user.email, password: 'guess-me' }),
    });
    expect(login.status).toBe(401);
  });

  it('/api/demo reports guest mode without leaking anything else', async () => {
    const res = await app.request('/api/demo');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.guests).toBe(true);
    expect(Object.keys(body).sort()).toEqual(['account', 'guests']);
  });
});

describe('portable bootstrap', () => {
  it('ensureBootstrap is idempotent', async () => {
    await ensureBootstrap(() => {});
    await ensureBootstrap(() => {});
  });

  it('the table owner (the server) may change privileged profile columns', async () => {
    const u = await createUser();
    cleanup.push(u.id);
    await adminPool.query(`UPDATE profiles SET role = 'admin' WHERE id = $1`, [u.id]);
    const { rows } = await adminPool.query<{ role: string }>('SELECT role FROM profiles WHERE id = $1', [u.id]);
    expect(rows[0]!.role).toBe('admin');
  });
});
