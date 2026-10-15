import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { adminPool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { ingestVault } from '../ingest/ingest.js';
import { importAuthored } from '../pipelines/authored.js';
import { nextScore } from '../quiz/knowledge.js';

export const GUEST_EMAIL_DOMAIN = 'guest.studybuddy.invalid';
const GUEST_MAX_AGE_DAYS = 3;

async function moduleId(): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [config.moduleSlug]);
  if (!rows[0]) throw new Error(`module ${config.moduleSlug} missing (run migrations first)`);
  return rows[0].id;
}

/** Marker stored in attempts.user_answer so seeded rows are never mistaken for real answers. */
export const DEMO_SEED_ANSWER = '[demo seed]';

/**
 * A realistic spread of mastery and recency: [outcomes oldest to newest, days ago of each].
 * Final scores come out strong, solid, due for review, weak, and faded.
 */
const DEMO_PROFILES: { outcomes: boolean[]; daysAgo: number[] }[] = [
  { outcomes: [false, true, true, true], daysAgo: [7, 5, 3, 1] }, // strong, fresh
  { outcomes: [true, true, false, true], daysAgo: [9, 6, 4, 2] }, // solid
  { outcomes: [false, true, true], daysAgo: [14, 12, 9] }, // decent but due for review
  { outcomes: [true, false, false], daysAgo: [6, 3, 1] }, // weak, recently missed
  { outcomes: [true, true], daysAgo: [20, 17] }, // fading with time
  { outcomes: [false, true], daysAgo: [8, 5] }, // middling
];

/**
 * Gives a new guest a few concepts already studied so Atlas, Ranks and Desk are not empty.
 * Rows are real attempts and knowledge (so every screen behaves normally) but each attempt
 * is tagged DEMO_SEED_ANSWER. Concepts are spread across the module; some stay untested.
 * Returns the number of concepts seeded.
 */
export async function seedGuestProgress(userId: string, now: number = Date.now()): Promise<number> {
  const mid = await moduleId();
  const { rows: concepts } = await adminPool.query<{ id: string; qid: string }>(
    `SELECT c.id, (SELECT q.id FROM questions q WHERE q.concept_id = c.id ORDER BY q.id LIMIT 1) AS qid
       FROM concepts c
      WHERE c.module_id = $1 AND c.status = 'live'
        AND EXISTS (SELECT 1 FROM questions q WHERE q.concept_id = c.id)
      ORDER BY c.week NULLS LAST, c.name`,
    [mid],
  );
  const count = Math.min(DEMO_PROFILES.length, concepts.length);
  const DAY = 86_400_000;
  for (let i = 0; i < count; i++) {
    const concept = concepts[Math.floor((i * concepts.length) / count)]!;
    const prof = DEMO_PROFILES[i]!;
    let score: number | null = null;
    let last: Date | null = null;
    const history: { at: string; is_correct: boolean; score: number }[] = [];
    for (let j = 0; j < prof.outcomes.length; j++) {
      const at = now - prof.daysAgo[j]! * DAY;
      score = nextScore(score, last, prof.outcomes[j]!, at);
      last = new Date(at);
      history.push({ at: last.toISOString(), is_correct: prof.outcomes[j]!, score: Number(score.toFixed(4)) });
      await adminPool.query(
        `INSERT INTO attempts (user_id, question_id, concept_id, is_correct, user_answer, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [userId, concept.qid, concept.id, prof.outcomes[j], DEMO_SEED_ANSWER, last],
      );
    }
    await adminPool.query(
      `INSERT INTO knowledge (user_id, concept_id, score, last_tested, history) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (user_id, concept_id) DO NOTHING`,
      [userId, concept.id, score, last, JSON.stringify(history)],
    );
  }
  return count;
}

export async function enrollUser(userId: string): Promise<void> {
  await adminPool.query(
    'INSERT INTO module_enrollments (user_id, module_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, await moduleId()],
  );
}

/**
 * Idempotent seed for the hosted demo. Safe to run on every boot:
 *  - ingests the corpus at VAULT_PATH (unchanged files are skipped by sha256);
 *  - imports the authored question bank when there are no questions yet, or
 *    the corpus or bank file changed (re-import resets attempts on old questions);
 *  - upserts the demo account when DEMO_EMAIL/DEMO_PASSWORD are set;
 *  - deletes guest accounts older than a few days.
 * Uses whatever embedding provider is configured; never calls an LLM.
 */
export async function seedDemo(log: (m: string) => void = console.log): Promise<void> {
  const stats = await ingestVault({ log });
  const errors = stats.filter((s) => s.status === 'error');
  if (errors.length) throw new Error(`ingest failed for: ${errors.map((e) => e.file).join(', ')}`);
  const changed = stats.some((s) => s.status === 'ingested');

  const mid = await moduleId();
  const { rows } = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM questions q JOIN concepts c ON c.id = q.concept_id WHERE c.module_id = $1`,
    [mid],
  );
  const bankHash = createHash('sha256').update(await readFile(config.authoredQuestionsPath)).digest('hex');
  const prev = await adminPool.query<{ value: string }>(`SELECT value FROM seed_state WHERE key = 'bank_sha256'`);
  if (changed || rows[0]!.n === 0 || prev.rows[0]?.value !== bankHash) {
    const r = await importAuthored(config.authoredQuestionsPath);
    await adminPool.query(
      `INSERT INTO seed_state (key, value) VALUES ('bank_sha256', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [bankHash],
    );
    log(`imported ${r.questions} question(s) across ${r.concepts} concept(s) (dropped ${r.dropped} ungrounded)`);
  } else {
    log(`question bank up to date (${rows[0]!.n} questions)`);
  }

  if (config.demoEmail && config.demoPassword) {
    const hash = await hashPassword(config.demoPassword);
    const up = await adminPool.query<{ id: string }>(
      `INSERT INTO profiles (email, password_hash, display_name) VALUES ($1,$2,'Demo student')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [config.demoEmail, hash],
    );
    await enrollUser(up.rows[0]!.id);
    log(`demo account ready: ${config.demoEmail}`);
  }

  const del = await adminPool.query(
    `DELETE FROM profiles WHERE email LIKE $1 AND created_at < now() - make_interval(days => $2)`,
    [`%@${GUEST_EMAIL_DOMAIN}`, GUEST_MAX_AGE_DAYS],
  );
  if (del.rowCount) log(`removed ${del.rowCount} expired guest account(s)`);
}
