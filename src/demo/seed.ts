import { config } from '../config.js';
import { adminPool } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';
import { ingestVault } from '../ingest/ingest.js';
import { importAuthored } from '../pipelines/authored.js';

export const GUEST_EMAIL_DOMAIN = 'guest.studybuddy.invalid';
const GUEST_MAX_AGE_DAYS = 3;

async function moduleId(): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [config.moduleSlug]);
  if (!rows[0]) throw new Error(`module ${config.moduleSlug} missing (run migrations first)`);
  return rows[0].id;
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
 *  - imports the authored question bank only when there are no questions yet
 *    or the corpus changed (re-import resets attempts on the old questions);
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
  if (changed || rows[0]!.n === 0) {
    const r = await importAuthored(config.authoredQuestionsPath);
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
