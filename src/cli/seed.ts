import { config } from '../config.js';
import { closePools } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { ensureBootstrap } from '../db/bootstrap.js';
import { printDiscoveryReport } from './discover.js';
import { ingestVault } from '../ingest/ingest.js';
import { extractAllConcepts, publishConcepts } from '../pipelines/concepts.js';
import { generateAllQuestions } from '../pipelines/questions.js';
import { importAuthored } from '../pipelines/authored.js';

const authoredFile = config.authoredQuestionsPath;

/**
 * Full ingestion seed. Always prints the discovery report first; only proceeds
 * past the report when invoked with --confirm (the human confirmation gate).
 *   npm run seed              # prints report, stops
 *   npm run seed -- --confirm # runs migrate -> ingest -> concepts -> questions
 */
async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const force = args.includes('--force');

  await printDiscoveryReport(config.vaultPath);

  if (!confirm) {
    console.log('>> Review the discovery report above.');
    console.log('>> Re-run with `--confirm` to ingest and build concepts/questions:');
    console.log('     npm run seed -- --confirm');
    return;
  }

  console.log('\n--- Applying migrations ---');
  await ensureBootstrap();
  await migrate();

  console.log(`\n--- Ingesting vault (embeddings=${config.embeddingProvider}) ---`);
  await ingestVault({ force });

  if (config.llmProvider === 'anthropic') {
    // Real key present: generate fresh concepts + questions with Claude.
    console.log(`\n--- Extracting concepts (llm=anthropic) ---`);
    const { moduleId, total } = await extractAllConcepts();
    const published = await publishConcepts(moduleId);
    console.log(`Persisted ${total} draft concept(s); published ${published}.`);

    console.log(`\n--- Generating grounded questions (llm=anthropic) ---`);
    const { concepts, questions } = await generateAllQuestions({ force });
    console.log(`\nSeed complete: ${questions} question(s) across ${concepts} concept(s).`);
  } else {
    // No API key: import the pre-authored, grounded question bank (real
    // questions, re-validated against the freshly ingested chunks).
    console.log(`\n--- Importing pre-authored grounded questions (no API key) ---`);
    const { concepts, questions, dropped } = await importAuthored(authoredFile);
    console.log(`\nSeed complete: ${questions} question(s) across ${concepts} concept(s) (dropped ${dropped} ungrounded). Set ANTHROPIC_API_KEY to generate fresh questions instead.`);
  }
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await closePools();
    process.exit(1);
  });
