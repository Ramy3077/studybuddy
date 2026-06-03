import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePools } from '../db/pool.js';
import { importAuthored } from '../pipelines/authored.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultFile = join(here, '..', '..', 'db', 'authored-questions.json');

async function main() {
  const file = process.argv[2] || defaultFile;
  console.log(`Importing authored questions from ${file}`);
  const stats = await importAuthored(file);
  console.log(`Imported ${stats.concepts} concept(s), ${stats.questions} grounded question(s); dropped ${stats.dropped} ungrounded/invalid.`);
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await closePools();
    process.exit(1);
  });
