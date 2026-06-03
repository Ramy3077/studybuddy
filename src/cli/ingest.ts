import { config } from '../config.js';
import { closePools } from '../db/pool.js';
import { ingestVault } from '../ingest/ingest.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const weekArg = args.find((a) => a.startsWith('--week='));
  const onlyWeeks = weekArg ? weekArg.replace('--week=', '').split(',').map((n) => parseInt(n, 10)) : undefined;
  return { force, onlyWeeks };
}

async function main() {
  const { force, onlyWeeks } = parseArgs();
  console.log(`Ingesting vault with embedding provider: ${config.embeddingProvider}`);
  const stats = await ingestVault({ force, onlyWeeks });
  const ingested = stats.filter((s) => s.status === 'ingested').length;
  const skipped = stats.filter((s) => s.status === 'skipped-unchanged').length;
  const errors = stats.filter((s) => s.status === 'error');
  const totalChunks = stats.reduce((a, s) => a + s.chunks, 0);
  const skippedPages = stats.flatMap((s) => (s.skippedPages ?? []).map(() => s.file));
  console.log(`\nDone: ${ingested} ingested, ${skipped} unchanged, ${errors.length} errors, ${totalChunks} chunks total.`);
  if (skippedPages.length) console.log(`Image-only/near-empty PDF pages were skipped in ${new Set(skippedPages).size} file(s).`);
  if (errors.length) {
    for (const e of errors) console.error(`  ERROR ${e.file}: ${e.error}`);
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
