import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { adminPool, withUser } from '../src/db/pool.js';
import { createUser, createConcept, createMcq, deleteUser, deleteConcept, moduleId, type TestUser } from './helpers.js';

let A: TestUser, B: TestUser, concept: string, q: string;

beforeAll(async () => {
  A = await createUser('User A');
  B = await createUser('User B');
  concept = await createConcept();
  q = await createMcq(concept, 'q', ['a', 'b', 'c', 'd'], 'a');
  // Seed attempts via the owner connection (server-authoritative writes).
  for (let i = 0; i < 2; i++)
    await adminPool.query('INSERT INTO attempts (user_id,question_id,concept_id,is_correct) VALUES ($1,$2,$3,true)', [A.id, q, concept]);
  for (let i = 0; i < 3; i++)
    await adminPool.query('INSERT INTO attempts (user_id,question_id,concept_id,is_correct) VALUES ($1,$2,$3,false)', [B.id, q, concept]);
  await adminPool.query('INSERT INTO knowledge (user_id,concept_id,score) VALUES ($1,$2,0.8)', [A.id, concept]);
  await adminPool.query('INSERT INTO knowledge (user_id,concept_id,score) VALUES ($1,$2,0.2)', [B.id, concept]);
});

afterAll(async () => {
  await deleteConcept(concept);
  await deleteUser(A.id);
  await deleteUser(B.id);
});

describe('RLS isolation — a user can only read their own private rows', () => {
  it('attempts are scoped to the current user', async () => {
    const aCount = await withUser(A.id, async (db) => (await db.query('SELECT count(*)::int n FROM attempts')).rows[0].n);
    const bCount = await withUser(B.id, async (db) => (await db.query('SELECT count(*)::int n FROM attempts')).rows[0].n);
    expect(aCount).toBe(2);
    expect(bCount).toBe(3);
  });

  it("user A cannot read user B's attempts even when querying B's id explicitly", async () => {
    const seen = await withUser(A.id, async (db) =>
      (await db.query('SELECT count(*)::int n FROM attempts WHERE user_id = $1', [B.id])).rows[0].n,
    );
    expect(seen).toBe(0);
  });

  it("user A cannot read user B's knowledge", async () => {
    const aKnow = await withUser(A.id, async (db) => (await db.query('SELECT count(*)::int n FROM knowledge')).rows[0].n);
    const bSeenByA = await withUser(A.id, async (db) =>
      (await db.query('SELECT count(*)::int n FROM knowledge WHERE user_id=$1', [B.id])).rows[0].n,
    );
    expect(aKnow).toBe(1);
    expect(bSeenByA).toBe(0);
  });

  it('profiles are scoped to the current user', async () => {
    const rows = await withUser(A.id, async (db) => (await db.query('SELECT id FROM profiles')).rows);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(A.id);
  });
});

describe('Privileged columns + cross-user writes are blocked at the DB layer', () => {
  it('the app role cannot write the privileged role column', async () => {
    await expect(
      withUser(A.id, (db) => db.query("UPDATE profiles SET role='admin' WHERE id = $1", [A.id])),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the app role CAN update its own display_name (allowed column)', async () => {
    const n = await withUser(A.id, async (db) => (await db.query("UPDATE profiles SET display_name='Renamed' WHERE id=$1", [A.id])).rowCount);
    expect(n).toBe(1);
  });

  it('user A cannot enrol user B (RLS WITH CHECK)', async () => {
    const mid = await moduleId();
    await expect(
      withUser(A.id, (db) => db.query('INSERT INTO module_enrollments (user_id, module_id) VALUES ($1,$2)', [B.id, mid])),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});
