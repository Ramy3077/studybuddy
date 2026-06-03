import { adminPool } from '../src/db/pool.js';
import { signJwt } from '../src/auth/jwt.js';
import { config } from '../src/config.js';

let counter = 0;
function uniq(): string {
  counter++;
  return `${Date.now().toString(36)}_${counter}`;
}

export async function moduleId(): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug=$1', [config.moduleSlug]);
  return rows[0]!.id;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export async function createUser(displayName = 'Test User'): Promise<TestUser> {
  const email = `test_${uniq()}@studybuddy.test`;
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO profiles (email, password_hash, display_name) VALUES ($1,'scrypt$00$00',$2) RETURNING id`,
    [email, displayName],
  );
  const id = rows[0]!.id;
  return { id, email, token: signJwt({ sub: id, email }) };
}

export async function enroll(userId: string): Promise<void> {
  await adminPool.query(
    `INSERT INTO module_enrollments (user_id, module_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, await moduleId()],
  );
}

export async function createConcept(opts: { name?: string; keyFacts?: string[]; week?: number | null } = {}): Promise<string> {
  const mid = await moduleId();
  const name = opts.name ?? `Test Concept ${uniq()}`;
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO concepts (module_id, name, description, key_facts, difficulty, week, status, dedupe_key)
     VALUES ($1,$2,'desc',$3,3,$4,'live',$5) RETURNING id`,
    [mid, name, opts.keyFacts ?? [], opts.week ?? 1, `test_${uniq()}`],
  );
  return rows[0]!.id;
}

export async function createMcq(conceptId: string, question: string, options: string[], correct: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO questions (concept_id, type, question, options, correct_answer, explanation, evidence_quote)
     VALUES ($1,'mcq',$2,$3::jsonb,$4,'because',$5) RETURNING id`,
    [conceptId, question, JSON.stringify(options), correct, options[0] ?? 'evidence quote here for grounding'],
  );
  return rows[0]!.id;
}

export async function createFreeForm(conceptId: string, question: string, correct: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO questions (concept_id, type, question, options, correct_answer, explanation, evidence_quote)
     VALUES ($1,'free_form',$2,NULL,$3,'because','verbatim evidence quote of several words here') RETURNING id`,
    [conceptId, question, correct],
  );
  return rows[0]!.id;
}

export async function deleteUser(userId: string): Promise<void> {
  await adminPool.query('DELETE FROM profiles WHERE id=$1', [userId]);
}

export async function deleteConcept(conceptId: string): Promise<void> {
  await adminPool.query('DELETE FROM concepts WHERE id=$1', [conceptId]);
}
