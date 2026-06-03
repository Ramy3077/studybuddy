import { describe, it, expect, afterAll } from 'vitest';
import { createApp } from '../src/server/app.js';
import { createUser, createConcept, createMcq, deleteUser, deleteConcept, enroll } from './helpers.js';

const app = createApp();
const cleanup: { users: string[]; concepts: string[] } = { users: [], concepts: [] };
afterAll(async () => {
  for (const u of cleanup.users) await deleteUser(u);
  for (const c of cleanup.concepts) await deleteConcept(c);
});

async function get(path: string, token: string) {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function answer(token: string, body: object) {
  return app.request('/api/quiz/answer', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('The answer key is not an oracle — /quiz/why* is gated on a prior wrong attempt', () => {
  it('refuses to reveal citations/answer for an un-attempted question', async () => {
    const user = await createUser();
    const concept = await createConcept();
    const q = await createMcq(concept, 'secret', ['the-key', 'a', 'b', 'c'], 'the-key');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await enroll(user.id);

    const r = await get(`/api/quiz/why/context?question_id=${q}`, user.token);
    expect(r.status).toBe(403); // never leaks correct_answer before answering
  });

  it('reveals the grounded citation only after the user answers wrong', async () => {
    const user = await createUser();
    const concept = await createConcept();
    const q = await createMcq(concept, 'secret2', ['the-key2', 'a', 'b', 'c'], 'the-key2');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await enroll(user.id);

    await answer(user.token, { question_id: q, answer: 'a' }); // wrong
    const r = await get(`/api/quiz/why/context?question_id=${q}`, user.token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.citations)).toBe(true);
  });
});
