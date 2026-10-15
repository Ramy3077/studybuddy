import { adminPool } from '../db/pool.js';
import { getEmbeddingProvider } from '../providers/embeddings.js';
import { getLlmProvider } from '../providers/llm.js';
import { getChunksByIds, sourceLabel, vectorSearch } from '../retrieval.js';
import { lexicalSearch } from '../lexical.js';
import { cleanVerbatimSpan, isVerbatimSubstring } from '../util/text.js';
import type { Locator, RetrievedChunk } from '../types.js';

export interface WhyCitation {
  source_id: string;
  chunk_id: string;
  source_label: string;
  week: number | null;
  lecture_title: string;
  source_type: string;
  quote: string; // verbatim passage from the source
  locator: Locator; // slide page or char offsets, for scroll-to/highlight
}

export interface WhyContext {
  question_id: string;
  question: string;
  correct_answer: string;
  /** Short authored rationale stored with the question (may be empty). */
  explanation: string;
  concept_name: string;
  citations: WhyCitation[];
  /** How related passages were found: offline BM25 (demo) or embedding search. */
  retrieval: 'lexical' | 'vector';
}

function toCitation(c: RetrievedChunk, quote: string): WhyCitation {
  return {
    source_id: c.source_id,
    chunk_id: c.id,
    source_label: sourceLabel(c),
    week: c.week,
    lecture_title: c.source_title,
    source_type: c.source_type,
    quote,
    locator: c.locator,
  };
}

/**
 * Build the GROUNDED citation context for a wrong answer. Citations are derived
 * server-side from real chunks (never from the model), so the exact passage,
 * its locator and the week + lecture title are always present and verifiable.
 */
export async function buildWhyContext(questionId: string): Promise<WhyContext> {
  const { rows } = await adminPool.query<{
    question: string;
    correct_answer: string;
    explanation: string | null;
    evidence_quote: string;
    source_chunk_ids: string[];
    concept_name: string;
    module_id: string;
  }>(
    `SELECT q.question, q.correct_answer, q.explanation, q.evidence_quote, q.source_chunk_ids,
            c.name AS concept_name, c.module_id
       FROM questions q JOIN concepts c ON c.id = q.concept_id
      WHERE q.id = $1`,
    [questionId],
  );
  const q = rows[0];
  if (!q) throw Object.assign(new Error('question not found'), { status: 404 });

  const citations: WhyCitation[] = [];
  const seen = new Set<string>();

  // 1) Primary citation: the chunk that contains the question's evidence quote.
  const hostChunks = await getChunksByIds(adminPool, q.source_chunk_ids);
  const host = hostChunks.find((c) => isVerbatimSubstring(q.evidence_quote, c.text)) ?? hostChunks[0];
  if (host) {
    const quote = isVerbatimSubstring(q.evidence_quote, host.text) ? q.evidence_quote : cleanVerbatimSpan(host.text, 8, 28);
    citations.push(toCitation(host, quote));
    seen.add(host.id);
  }

  // 2) Additional support via vector search over the question + correct answer.
  try {
    const queryText = `${q.question}\n${q.correct_answer}`;
    const provider = getEmbeddingProvider();
    const hits =
      provider.name === 'mock'
        ? await lexicalSearch(adminPool, queryText, { moduleId: q.module_id, limit: 5 })
        : await vectorSearch(adminPool, (await provider.embedBatch([queryText]))[0]!, { moduleId: q.module_id, limit: 5 });
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      const quote = cleanVerbatimSpan(h.text, 8, 28);
      // Overlapping chunks can yield the same (or a contained) passage; show it once.
      const ql = quote.toLowerCase();
      if (citations.some((c) => { const cl = c.quote.toLowerCase(); return cl.includes(ql) || ql.includes(cl); })) continue;
      citations.push(toCitation(h, quote));
      seen.add(h.id);
      if (citations.length >= 3) break;
    }
  } catch {
    // retrieval is best-effort; primary citation already grounds the answer
  }

  return {
    question_id: questionId,
    question: q.question,
    correct_answer: q.correct_answer,
    explanation: q.explanation ?? '',
    concept_name: q.concept_name,
    citations,
    retrieval: getEmbeddingProvider().name === 'mock' ? 'lexical' : 'vector',
  };
}

const SYSTEM = `You explain to a student WHY the correct answer is right, using ONLY the provided source passages. You MUST ground every claim in the quoted passages and refer to them by their source label (week + lecture title). Do not invent facts, citations, timestamps or links. Keep it to a short, clear paragraph.`;

/** Stream a grounded explanation. Citations are already server-verified. */
export async function* streamWhy(ctx: WhyContext, userAnswer?: string): AsyncIterable<string> {
  const llm = getLlmProvider();
  const passages = ctx.citations
    .map((c, i) => `[${i + 1}] ${c.source_label}: "${c.quote}"`)
    .join('\n');
  const user = `Question: ${ctx.question}
Correct answer: ${ctx.correct_answer}
${userAnswer ? `Student's (incorrect) answer: ${userAnswer}\n` : ''}Source passages you must rely on and cite:
${passages}

Explain why the correct answer is right, citing the source label(s) and pointing the student to where in the material it is stated.`;

  yield* llm.streamComplete({
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 600,
    temperature: 0,
    mock: {
      task: 'explain_why',
      payload: {
        correct_answer: ctx.correct_answer,
        explanation: ctx.explanation,
        citations: ctx.citations.map((c) => ({ source_label: c.source_label, quote: c.quote })),
      },
    },
  });
}
