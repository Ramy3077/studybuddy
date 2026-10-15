import { ensureBootstrap } from '../db/bootstrap.js';
import { migrate } from '../db/migrate.js';
import { seedDemo } from '../demo/seed.js';

/**
 * Production entrypoint (Dockerfile CMD): bootstrap the DB roles, apply
 * migrations, seed the demo corpus + question bank (idempotent), then serve.
 */
async function main() {
  await ensureBootstrap();
  await migrate();
  await seedDemo();
  await import('../index.js');
}

main().catch((e) => {
  console.error('boot failed:', e);
  process.exit(1);
});
