import { config } from '../config.js';
import { closePools } from '../db/pool.js';
import { importAuthored } from '../pipelines/authored.js';

const defaultFile = config.authoredQuestionsPath;

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
