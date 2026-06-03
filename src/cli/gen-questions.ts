import { config } from '../config.js';
import { closePools } from '../db/pool.js';
import { generateAllQuestions } from '../pipelines/questions.js';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  console.log(`Generating questions with LLM provider: ${config.llmProvider}`);
  const { concepts, questions } = await generateAllQuestions({ force });
  console.log(`\nGenerated ${questions} grounded question(s) across ${concepts} concept(s).`);
}

main()
  .then(() => closePools())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e);
    await closePools();
    process.exit(1);
  });
