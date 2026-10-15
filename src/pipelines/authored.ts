import { readFile } from 'node:fs/promises';
import { adminPool } from '../db/pool.js';
import { config } from '../config.js';
import { collapseWs, countWords, isCleanProse, stripInlineMarkup } from '../util/text.js';

/**
 * Import pre-authored concepts + questions (no external LLM call) while applying
 * the SAME grounding guarantees the live pipeline enforces:
 *   - every question keeps a verbatim 5-30 word evidence_quote that is a real
 *     substring of one of that week's chunks (else the question is dropped);
 *   - source_chunk_ids resolve to the real chunk containing the quote.
 *
 * This is how StudyBuddy ships a real question bank with no API key: the
 * questions in AUTHORED_QUESTIONS_PATH (default demo/questions.json) were
 * written against the source notes, and are re-validated here against the
 * ingested text.
 */

interface AuthoredQuestion {
  type: 'mcq' | 'free_form';
  question: string;
  options: string[] | null;
  correct_answer: string;
  explanation: string;
  evidence_quote: string;
}
interface AuthoredConcept {
  name: string;
  description: string;
  key_facts: string[];
  difficulty: number;
  questions: AuthoredQuestion[];
}
interface WeekResult {
  week: number;
  concepts: AuthoredConcept[];
}

/** Normalised form for verbatim matching: emphasis stripped, ws-collapsed, lowercased. */
function matchForm(s: string): string {
  return collapseWs(stripInlineMarkup(s)).toLowerCase();
}

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function validQuestion(q: AuthoredQuestion): boolean {
  const ev = stripInlineMarkup((q.evidence_quote ?? '').trim());
  const wc = countWords(ev);
  if (wc < 5 || wc > 30 || !isCleanProse(ev)) return false;
  if (!q.question || q.question.trim().length < 8) return false;
  if (q.type === 'mcq') {
    const opts = (q.options ?? []).map((o) => o.trim());
    if (opts.length !== 4) return false;
    if (new Set(opts).size !== 4) return false;
    if (!opts.includes((q.correct_answer ?? '').trim())) return false;
  } else if (!q.correct_answer || q.correct_answer.trim().length < 2) {
    return false;
  }
  return true;
}

async function weekChunks(moduleId: string, week: number): Promise<{ id: string; text: string }[]> {
  const { rows } = await adminPool.query<{ id: string; text: string }>(
    `SELECT c.id, c.text FROM source_chunks c JOIN sources s ON s.id = c.source_id
      WHERE s.module_id = $1 AND s.week = $2`,
    [moduleId, week],
  );
  return rows;
}

export interface ImportStats {
  concepts: number;
  questions: number;
  dropped: number;
}

export async function importAuthored(filePath: string): Promise<ImportStats> {
  const data = JSON.parse(await readFile(filePath, 'utf8')) as { results: WeekResult[] };
  const { rows: mod } = await adminPool.query<{ id: string }>('SELECT id FROM modules WHERE slug=$1', [config.moduleSlug]);
  const moduleId = mod[0]!.id;

  // Clean slate for the concept/question layer (chunks/embeddings are kept).
  await adminPool.query('DELETE FROM questions WHERE concept_id IN (SELECT id FROM concepts WHERE module_id=$1)', [moduleId]);
  await adminPool.query('DELETE FROM concepts WHERE module_id=$1', [moduleId]);

  let conceptCount = 0;
  let questionCount = 0;
  let dropped = 0;

  for (const wr of data.results ?? []) {
    const chunks = await weekChunks(moduleId, wr.week);
    const normChunks = chunks.map((c) => ({ id: c.id, norm: matchForm(c.text) }));

    for (const concept of wr.concepts ?? []) {
      const accepted: { q: AuthoredQuestion; hostId: string }[] = [];
      for (const q of concept.questions ?? []) {
        if (!validQuestion(q)) {
          dropped++;
          continue;
        }
        const evNorm = matchForm(q.evidence_quote);
        const host = normChunks.find((c) => c.norm.includes(evNorm));
        if (!host) {
          dropped++;
          continue;
        }
        accepted.push({ q: { ...q, evidence_quote: stripInlineMarkup(q.evidence_quote).trim() }, hostId: host.id });
      }
      if (accepted.length === 0) continue;

      const sourceChunkIds = [...new Set(accepted.map((a) => a.hostId))];
      const { rows } = await adminPool.query<{ id: string }>(
        `INSERT INTO concepts (module_id, name, description, key_facts, difficulty, week, source_chunk_ids, status, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'live',$8)
         ON CONFLICT (module_id, dedupe_key) DO UPDATE SET
           source_chunk_ids = (SELECT array_agg(DISTINCT x) FROM unnest(concepts.source_chunk_ids || EXCLUDED.source_chunk_ids) x),
           status='live'
         RETURNING id`,
        [
          moduleId,
          concept.name.trim(),
          (concept.description ?? '').trim(),
          (concept.key_facts ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 8),
          Math.min(5, Math.max(1, Math.round(concept.difficulty || 3))),
          wr.week,
          sourceChunkIds,
          normalizeKey(concept.name),
        ],
      );
      const conceptId = rows[0]!.id;
      conceptCount++;

      for (const { q, hostId } of accepted) {
        await adminPool.query(
          `INSERT INTO questions (concept_id, type, question, options, correct_answer, explanation, source_chunk_ids, evidence_quote)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
          [
            conceptId,
            q.type,
            q.question.trim(),
            q.type === 'mcq' ? JSON.stringify(q.options!.map((o) => o.trim())) : null,
            q.correct_answer.trim(),
            (q.explanation ?? '').trim(),
            [hostId],
            q.evidence_quote.trim(),
          ],
        );
        questionCount++;
      }
    }
  }

  return { concepts: conceptCount, questions: questionCount, dropped };
}
