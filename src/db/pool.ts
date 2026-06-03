import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// Privileged connection: migrations, ingestion, pipelines, server-side grading
// writes. Connects as studybuddy_owner and bypasses RLS.
export const adminPool = new Pool({ connectionString: config.databaseUrl, max: 10, allowExitOnIdle: true });

// Un-privileged connection used for *user-scoped* HTTP requests. Connects as
// studybuddy_app, which has RLS FORCED. The only way it ever sees a user's
// rows is via the per-request `app.current_user_id` GUC set below.
export const appPool = new Pool({ connectionString: config.appDatabaseUrl, max: 10, allowExitOnIdle: true });

export type Db = pg.PoolClient;

/**
 * Run `fn` inside a transaction on the RLS-enforced app connection, with the
 * authenticated user's id bound to `app.current_user_id` for the duration.
 *
 * `set_config(..., true)` makes the setting transaction-local, so it can never
 * leak to another pooled request. The value is bound as a parameter (never
 * string-interpolated), so it cannot be used for SQL injection.
 */
export async function withUser<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run `fn` with a privileged (owner) client in a transaction. */
export async function withAdmin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([adminPool.end(), appPool.end()]);
}
