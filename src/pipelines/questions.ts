import { z } from 'zod';
import { adminPool } from '../db/pool.js';
import { config } from '../config.js';
import { getLlmProvider } from '../providers/llm.js';
import { getChunksByIds, sourceLabel } from '../retrieval.js';
import { parseJsonLoose } from '../util/json.js';
import { countWords, isCleanProse, isVerbatimSubstring } from '../util/text.js';
import type { GeneratedQuestion, RetrievedChunk } from '../types.js';

const QuestionSchema = z.object({
  type: z.enum(['mcq', 'free_form']),
  question: z.string().min(5),
  options: z.array(z.string()).nullable().default(null),
  correct_answer: z.string().min(1),
  explanation: z.string().default(''),
  evidence_quote: z.string().default(''),
  source_chunk_ids: z.array(z.string()).default([]),
});
const QuestionsOut = z.object({ questions: z.array(QuestionSchema) });

const SYSTEM = `You write strictly-grounded revision questions for a university Machine Learning module. Every question MUST be answerable using ONLY the provided source chunks. Every question MUST include an evidence_quote that is a VERBATIM 5-30 word substring copied exactly from one of the chunks. If you cannot ground a question, omit it. Prefer fewer, well-grounded questions over more.`;

function buildPrompt(concept: { name: string; description: string; key_facts: string[] }, chunks: RetrievedChunk[]): string {
  const lines = chunks.map((c) => `--- chunk id=${c.id} | ${sourceLabel(c)} ---\n${c.text.slice(0, 1800)}`);
  return `Concept: ${concept.name}
Description: ${concept.description}
Key facts: ${concept.key_facts.join('; ')}

Source chunks:

${lines.join('\n\n')}

Write 3-5 questions for this concept: ~60% multiple-choice (exactly 4 options, correct_answer = the FULL text of the correct option) and ~40% free-form.

Return STRICT JSON only:
{"questions":[{"type":"mcq|free_form","question":"...","options":["a","b","c","d"]|null,"correct_answer":"...","explanation":"...","evidence_quote":"<verbatim 5-30 word substring copied from a chunk above>","source_chunk_ids":["<ids of chunks the question/evidence came from>"]}]}

Rules: evidence_quote MUST appear verbatim in one of the chunks above. source_chunk_ids must only contain ids listed above. For mcq, the 4 options must be distinct and correct_answer must equal one of them.`;
}

/** Enforce the grounding contract; returns a clean question or null (dropped). */
export function validateQuestion(
  q: z.infer<typeof QuestionSchema>,
  conceptChunks: RetrievedChunk[],
): GeneratedQuestion | null {
  const evidence = q.evidence_quote.trim();
  const wc = countWords(evidence);
  if (wc < 5 || wc > 30) return null;
  if (!isCleanProse(evidence)) return null; // reject page-markers / markup as evidence

  const host = conceptChunks.find((c) => isVerbatimSubstring(evidence, c.text));
  if (!host) return null; // evidence not verbatim in any chunk -> drop

  const validIds = new Set(conceptChunks.map((c) => c.id));
  let ids = q.source_chunk_ids.filter((id) => validIds.has(id));
  if (!ids.includes(host.id)) ids = [host.id, ...ids];

  if (q.type === 'mcq') {
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length !== 4) return null;
    if (new Set(opts.map((o) => o.trim())).size !== 4) return null;
    if (!opts.map((o) => o.trim()).includes(q.correct_answer.trim())) return null;
    return {
      type: 'mcq',
      question: q.question.trim(),
      options: opts.map((o) => o.trim()),
      correct_answer: q.correct_answer.trim(),
      explanation: q.explanation.trim(),
      evidence_quote: evidence,
      source_chunk_ids: ids,
    };
  }
  return {
    type: 'free_form',
    question: q.question.trim(),
    options: null,
    correct_answer: q.correct_answer.trim(),
    explanation: q.explanation.trim(),
    evidence_quote: evidence,
    source_chunk_ids: ids,
  };
}

export async function generateForConcept(concept: {
  id: string;
  name: string;
  description: string;
  key_facts: string[];
  source_chunk_ids: string[];
}): Promise<GeneratedQuestion[]> {
  const chunks = await getChunksByIds(adminPool, concept.source_chunk_ids);
  if (chunks.length === 0) return [];

  const llm = getLlmProvider();
  const raw = await llm.complete({
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(concept, chunks) }],
    maxTokens: 2500,
    temperature: 0,
    mock: {
      task: 'generate_questions',
      payload: {
        concept: { name: concept.name, description: concept.description, key_facts: concept.key_facts },
        chunks: chunks.map((c) => ({ id: c.id, text: c.text, source_label: sourceLabel(c) })),
      },
    },
  });

  let parsed: z.infer<typeof QuestionsOut>;
  try {
    parsed = QuestionsOut.parse(parseJsonLoose(raw));
  } catch {
    return [];
  }
  const out: GeneratedQuestion[] = [];
  for (const q of parsed.questions) {
    const v = validateQuestion(q, chunks);
    if (v) out.push(v);
  }
  return out;
}

async function persistQuestions(conceptId: string, questions: GeneratedQuestion[]): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM questions WHERE concept_id = $1', [conceptId]);
    for (const q of questions) {
      await client.query(
        `INSERT INTO questions (concept_id, type, question, options, correct_answer, explanation, source_chunk_ids, evidence_quote)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
        [
          conceptId,
          q.type,
          q.question,
          q.options ? JSON.stringify(q.options) : null,
          q.correct_answer,
          q.explanation,
          q.source_chunk_ids,
          q.evidence_quote,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function generateAllQuestions(
  opts: { force?: boolean; log?: (m: string) => void } = {},
): Promise<{ concepts: number; questions: number }> {
  const log = opts.log ?? console.log;
  const { rows: mod } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug = $1', [config.moduleSlug]);
  const moduleId = mod[0]!.id;

  const { rows: concepts } = await adminPool.query(
    `SELECT c.id, c.name, c.description, c.key_facts, c.source_chunk_ids,
            (SELECT count(*) FROM questions q WHERE q.concept_id = c.id)::int AS nq
       FROM concepts c WHERE c.module_id = $1 ORDER BY c.week, c.name`,
    [moduleId],
  );

  let totalQ = 0;
  let touched = 0;
  for (const c of concepts as any[]) {
    if (!opts.force && c.nq > 0) continue;
    const qs = await generateForConcept(c);
    await persistQuestions(c.id, qs);
    totalQ += qs.length;
    touched++;
    log(`Concept "${c.name}": ${qs.length} grounded question(s)`);
  }
  return { concepts: touched, questions: totalQ };
}
