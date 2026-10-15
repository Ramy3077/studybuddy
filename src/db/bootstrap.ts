import { config } from '../config.js';
import { adminPool } from './pool.js';

const APP_ROLE = 'studybuddy_app';

/**
 * Idempotent database bootstrap, run as the owner connection before migrations.
 *
 * Local docker-compose does this through db/bootstrap/00-bootstrap.sql on first
 * container init. Managed Postgres (Railway, CI service containers) never runs
 * that file, so the same steps happen here instead:
 *   - CREATE EXTENSION vector
 *   - create the un-privileged RLS role named in APP_DATABASE_URL, with the
 *     password from that URL (kept in sync on every boot)
 *   - let it connect to the current database and use the public schema
 *
 * The role is always NOSUPERUSER NOBYPASSRLS, so RLS is enforced for it.
 */
export async function ensureBootstrap(log: (m: string) => void = console.log): Promise<void> {
  const url = new URL(config.appDatabaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (user !== APP_ROLE) {
    throw new Error(`APP_DATABASE_URL must connect as ${APP_ROLE} (the role the RLS policies are written for), got "${user}"`);
  }
  if (!password) throw new Error('APP_DATABASE_URL must include a password for the app role');

  await adminPool.query('CREATE EXTENSION IF NOT EXISTS vector');

  const { rowCount } = await adminPool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  // format(%L) quotes the password as a literal server-side; role DDL cannot
  // take bind parameters.
  const { rows } = await adminPool.query<{ sql: string }>(
    rowCount
      ? `SELECT format('ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql`
      : `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', $1::text, $2::text) AS sql`,
    [APP_ROLE, password],
  );
  await adminPool.query(rows[0]!.sql);

  const db = await adminPool.query<{ sql: string }>(
    `SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS sql`,
    [APP_ROLE],
  );
  await adminPool.query(db.rows[0]!.sql);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  log(`bootstrap ok (extension vector, role ${APP_ROLE} ${rowCount ? 'updated' : 'created'})`);
}
