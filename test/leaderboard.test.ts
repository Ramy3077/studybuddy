import { describe, it, expect, afterAll } from 'vitest';
import { adminPool, withUser } from '../src/db/pool.js';
import { createApp } from '../src/server/app.js';
import { createUser, createConcept, createMcq, deleteUser, deleteConcept, enroll } from './helpers.js';

const app = createApp();
const cleanup: { users: string[]; concepts: string[] } = { users: [], concepts: [] };
afterAll(async () => {
  for (const u of cleanup.users) await deleteUser(u);
  for (const c of cleanup.concepts) await deleteConcept(c);
});

async function answer(token: string, body: object) {
  const res = await app.request('/api/quiz/answer', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function leaderboardRowFor(token: string, userId: string) {
  const res = await app.request('/api/leaderboard?limit=200', { headers: { authorization: `Bearer ${token}` } });
  const { leaderboard } = (await res.json()) as { leaderboard: any[] };
  return leaderboard.find((r) => r.user_id === userId) ?? { answered: 0, correct: 0 };
}

describe('Leaderboard integrity — scores are server-authoritative', () => {
  it('the app (client) DB role cannot INSERT into attempts at all', async () => {
    const user = await createUser();
    const concept = await createConcept();
    const q = await createMcq(concept, 'q', ['a', 'b', 'c', 'd'], 'a');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);

    await expect(
      withUser(user.id, (db) =>
        db.query(
          `INSERT INTO attempts (user_id, question_id, concept_id, is_correct) VALUES ($1,$2,$3,true)`,
          [user.id, q, concept],
        ),
      ),
    ).rejects.toThrow(/permission denied|denied for table attempts/i);
  });

  it('a crafted request with is_correct:true + score:9999 on a WRONG answer cannot inflate the score', async () => {
    const user = await createUser('Cheater');
    const concept = await createConcept();
    const options = ['correct-opt', 'wrong-opt', 'x', 'y'];
    const q = await createMcq(concept, 'pick correct', options, 'correct-opt');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await enroll(user.id);

    // Submit a WRONG answer but try to tamper with is_correct/score fields.
    const r = await answer(user.token, { question_id: q, answer: 'wrong-opt', is_correct: true, score: 9999 });
    expect(r.status).toBe(200);
    expect(r.json.is_correct).toBe(false); // server graded it wrong, tamper ignored

    // The stored attempt is is_correct=false.
    const { rows } = await adminPool.query('SELECT is_correct FROM attempts WHERE user_id=$1 AND question_id=$2', [user.id, q]);
    expect(rows.every((x) => x.is_correct === false)).toBe(true);

    // Leaderboard derives correct=0 from attempts despite the tampered payload.
    const row = await leaderboardRowFor(user.token, user.id);
    expect(Number(row.correct)).toBe(0);
    expect(Number(row.answered)).toBe(1);
  });

  it('the leaderboard counts DISTINCT questions correct (genuine progress)', async () => {
    const user = await createUser('Honest');
    const concept = await createConcept();
    const q1 = await createMcq(concept, 'q1', ['right1', 'a', 'b', 'c'], 'right1');
    const q2 = await createMcq(concept, 'q2', ['right2', 'a', 'b', 'c'], 'right2');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await enroll(user.id);

    await answer(user.token, { question_id: q1, answer: 'a' }); // wrong
    await answer(user.token, { question_id: q2, answer: 'right2' }); // correct

    const row = await leaderboardRowFor(user.token, user.id);
    expect(Number(row.answered)).toBe(2); // 2 distinct questions attempted
    expect(Number(row.correct)).toBe(1); // 1 distinct question correct
  });

  it('replaying a known-correct answer cannot inflate the score (distinct counting)', async () => {
    const user = await createUser('Replayer');
    const concept = await createConcept();
    const q = await createMcq(concept, 'replay me', ['the-answer', 'a', 'b', 'c'], 'the-answer');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await enroll(user.id);

    // Learn the answer, then spam it 8 times.
    for (let i = 0; i < 8; i++) await answer(user.token, { question_id: q, answer: 'the-answer' });

    const row = await leaderboardRowFor(user.token, user.id);
    expect(Number(row.correct)).toBe(1); // still 1, not 8
    expect(Number(row.answered)).toBe(1);
  });

  it('a non-enrolled user cannot record a counting attempt (403)', async () => {
    const user = await createUser('Outsider');
    const concept = await createConcept();
    const q = await createMcq(concept, 'q', ['a', 'b', 'c', 'd'], 'a');
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    // deliberately NOT enrolled
    const r = await answer(user.token, { question_id: q, answer: 'a' });
    expect(r.status).toBe(403);
    const { rows } = await adminPool.query('SELECT count(*)::int n FROM attempts WHERE user_id=$1', [user.id]);
    expect(rows[0].n).toBe(0);
  });

  it('there is no client-writable path to knowledge either', async () => {
    const user = await createUser();
    const concept = await createConcept();
    cleanup.users.push(user.id); cleanup.concepts.push(concept);
    await expect(
      withUser(user.id, (db) =>
        db.query(`INSERT INTO knowledge (user_id, concept_id, score) VALUES ($1,$2,1.0)`, [user.id, concept]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('Leaderboard excludes throwaway guest accounts', () => {
  it('a guest with graded attempts is not listed, a real user is', async () => {
    const real = await createUser('Real Student');
    const guest = await createUser('Guest');
    await adminPool.query('UPDATE profiles SET email=$1 WHERE id=$2', [`guest-${Date.now()}@guest.studybuddy.invalid`, guest.id]);
    const concept = await createConcept();
    const q = await createMcq(concept, 'pick a', ['a', 'b', 'c', 'd'], 'a');
    cleanup.users.push(real.id, guest.id); cleanup.concepts.push(concept);
    await enroll(real.id); await enroll(guest.id);

    await answer(real.token, { question_id: q, answer: 'a' });
    await answer(guest.token, { question_id: q, answer: 'a' });

    const res = await app.request('/api/leaderboard?limit=200', { headers: { authorization: `Bearer ${real.token}` } });
    const { leaderboard } = (await res.json()) as { leaderboard: any[] };
    expect(leaderboard.some((r) => r.user_id === real.id)).toBe(true);
    expect(leaderboard.some((r) => r.user_id === guest.id)).toBe(false);
  });
});
