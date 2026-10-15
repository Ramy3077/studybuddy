import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/server/app.js';
import { adminPool } from '../src/db/pool.js';
import { ensureBootstrap } from '../src/db/bootstrap.js';
import { GUEST_EMAIL_DOMAIN, DEMO_SEED_ANSWER, seedGuestProgress } from '../src/demo/seed.js';
import { createUser, deleteUser, enroll, createConcept, createMcq, deleteConcept } from './helpers.js';

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

describe('guest demo seed', () => {
  const concepts: string[] = [];
  afterAll(async () => {
    for (const id of concepts) await deleteConcept(id);
  });

  async function stats(token: string) {
    const res = await app.request('/api/stats', { headers: { authorization: `Bearer ${token}` } });
    return (await res.json()) as {
      totals: { answered: number; correct: number };
      concepts: { id: string; name: string; score: number; last_tested: string }[];
    };
  }

  it('a new guest starts with a spread of studied concepts, tagged as demo data', async () => {
    for (let i = 0; i < 7; i++) {
      const c = await createConcept({ name: `Seed Test ${i}`, week: 90 + i });
      concepts.push(c);
      await createMcq(c, `Q${i}?`, ['a b c d e f', 'b'], 'a b c d e f');
    }
    const res = await app.request('/api/auth/guest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.20' },
      body: '{}',
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    cleanup.push(body.user.id);

    const s = await stats(body.token);
    expect(s.concepts.length).toBeGreaterThanOrEqual(6);
    expect(s.totals.answered).toBeGreaterThan(s.concepts.length);
    const scores = s.concepts.map((c) => c.score);
    expect(Math.max(...scores)).toBeGreaterThan(0.6);
    expect(Math.min(...scores)).toBeLessThan(0.45);
    const ages = s.concepts.map((c) => Date.now() - new Date(c.last_tested).getTime());
    expect(Math.min(...ages)).toBeLessThan(3 * 86_400_000);
    expect(Math.max(...ages)).toBeGreaterThan(10 * 86_400_000);

    const { rows } = await adminPool.query<{ n: number; seeded: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE user_answer = $2)::int AS seeded
         FROM attempts WHERE user_id = $1`,
      [body.user.id, DEMO_SEED_ANSWER],
    );
    expect(rows[0]!.n).toBe(rows[0]!.seeded); // every seeded row is labelled
  });

  it('plain users get no seed and re-seeding is harmless', async () => {
    const u = await createUser();
    cleanup.push(u.id);
    await enroll(u.id);
    const s = await stats(u.token);
    expect(s.concepts).toHaveLength(0);
    // seeding twice for one user is harmless (knowledge rows are not duplicated)
    const g = await createUser();
    cleanup.push(g.id);
    const n1 = await seedGuestProgress(g.id);
    await seedGuestProgress(g.id);
    const { rows } = await adminPool.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge WHERE user_id = $1', [g.id]);
    expect(rows[0]!.n).toBe(n1);
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
