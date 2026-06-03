import { describe, it, expect } from 'vitest';
import { createApp } from '../src/server/app.js';
import { config } from '../src/config.js';

const app = createApp();

async function login(email: string, ip: string): Promise<number> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });
  return res.status;
}

describe('Auth endpoints are rate-limited (CWE-307 online brute force)', () => {
  it('login returns 429 once the per-minute attempt limit is exceeded', async () => {
    const ip = '203.0.113.45';
    const email = `brute_${Date.now()}@studybuddy.test`;
    const statuses: number[] = [];
    for (let i = 0; i < config.authRateLimitPerMin + 2; i++) statuses.push(await login(email, ip));

    expect(statuses[0]).toBe(401); // first attempt is a normal failed login
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0); // later ones throttled
    expect(statuses.at(-1)).toBe(429);
  });

  it('a fresh IP + email is not affected by another client hitting the limit', async () => {
    const status = await login(`fresh_${Date.now()}@studybuddy.test`, '198.51.100.7');
    expect(status).toBe(401);
  });
});
