import { ensureBootstrap } from '../db/bootstrap.js';
import { migrate } from '../db/migrate.js';
import { closePools } from '../db/pool.js';

ensureBootstrap()
  .then(() => migrate())
  .then(() => closePools())
  .then(() => {
    console.log('migrations complete');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('migration failed:', err.message);
    await closePools();
    process.exit(1);
  });
