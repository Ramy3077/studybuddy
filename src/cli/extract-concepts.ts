import { config } from '../config.js';
import { closePools, adminPool } from '../db/pool.js';
import { extractAllConcepts, publishConcepts } from '../pipelines/concepts.js';

async function main() {
  const args = process.argv.slice(2);
  const publish = args.includes('--publish');
  const weekArg = args.find((a) => a.startsWith('--week='));
  const onlyWeeks = weekArg ? weekArg.replace('--week=', '').split(',').map((n) => parseInt(n, 10)) : undefined;

  console.log(`Extracting concepts with LLM provider: ${config.llmProvider}`);
  const { moduleId, total } = await extractAllConcepts({ onlyWeeks });
  console.log(`\nTotal drafts persisted: ${total}`);
  if (publish) {
    const n = await publishConcepts(moduleId);
    console.log(`Published ${n} concept(s) -> live`);
  } else {
    const { rows } = await adminPool.query<{ n: string }>(
      "SELECT count(*) n FROM concepts WHERE module_id=$1 AND status='draft'",
      [moduleId],
    );
    console.log(`${rows[0]!.n} draft(s) awaiting review. Re-run with --publish to go live.`);
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
