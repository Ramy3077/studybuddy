import { config } from '../config.js';
import { adminPool, closePools } from '../db/pool.js';
import { hashPassword } from '../auth/password.js';

/**
 * DEV-ONLY convenience: seed a known admin login for local testing.
 *
 *   npm run seed:admin                 # admin / admin
 *   ADMIN_USERNAME=root ADMIN_PASSWORD=hunter2 npm run seed:admin
 *
 * Intentionally NOT part of migrations or `npm run seed` so it can never end up
 * in a real deployment by accident. Refuses to run when NODE_ENV=production
 * unless FORCE_SEED_ADMIN=1 is set (which you should never do).
 */
async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED_ADMIN !== '1') {
    console.error('Refusing to seed weak admin credentials in production. (Override: FORCE_SEED_ADMIN=1 — not recommended.)');
    process.exit(1);
  }

  const username = (process.env.ADMIN_USERNAME ?? 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? 'admin';
  const displayName = process.env.ADMIN_NAME ?? 'admin';
  const password_hash = await hashPassword(password);

  // Upsert as the owner role (bypasses the privileged-column trigger), so role
  // can be set to 'admin'.
  const { rows } = await adminPool.query<{ id: string }>(
    `INSERT INTO profiles (email, password_hash, display_name, role)
     VALUES ($1,$2,$3,'admin')
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       display_name  = EXCLUDED.display_name,
       role          = 'admin'
     RETURNING id`,
    [username, password_hash, displayName],
  );
  const id = rows[0]!.id;

  // Enrol the admin in the Machine Learning module for immediate testing.
  const m = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [config.moduleSlug]);
  if (m.rows[0]) {
    await adminPool.query(
      'INSERT INTO module_enrollments (user_id, module_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, m.rows[0].id],
    );
  }

  console.log('\x1b[33m%s\x1b[0m', '──────────────────────────────────────────────────────────');
  console.log('\x1b[33m%s\x1b[0m', `[dev] Seeded admin login  ->  username: ${username}   password: ${password}   (role=admin)`);
  console.log('\x1b[33m%s\x1b[0m', '[dev] WEAK CREDENTIALS — local/testing use only. Never seed this in production.');
  console.log('\x1b[33m%s\x1b[0m', '──────────────────────────────────────────────────────────');
  console.log('admin user id:', id);
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await closePools();
    process.exit(1);
  });
