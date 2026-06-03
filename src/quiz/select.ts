import type pg from 'pg';
import { decayedScore } from './knowledge.js';

const DAY_MS = 86_400_000;
const NEUTRAL = 0.5;

export interface SelectedQuestion {
  question: { id: string; type: 'mcq' | 'free_form'; question: string; options: string[] | null };
  concept: { id: string; name: string; week: number | null; difficulty: number };
  priority: number;
  effective_score: number;
  reason: string;
}

interface ConceptStat {
  id: string;
  name: string;
  week: number | null;
  difficulty: number;
  score: number | null;
  last_tested: Date | null;
  last_correct: boolean | null;
  n_attempts: number;
  n_questions: number;
}

function priorityFor(r: ConceptStat, now: number): { priority: number; eff: number; reason: string } {
  const tested = r.score !== null;
  const eff = tested ? decayedScore(r.score!, r.last_tested, now) : NEUTRAL;
  const reasons: string[] = [];
  let p = 0;

  if (!tested) {
    p += 1.0;
    reasons.push('untested');
  }
  p += 1.0 * (1 - eff);
  if (eff < 0.4 && tested) reasons.push('weak');

  if (r.last_correct === false) {
    p += 0.6;
    reasons.push('recently missed');
  }

  if (tested && r.last_tested) {
    const days = Math.max(0, (now - r.last_tested.getTime()) / DAY_MS);
    const interval = 1 + eff * 20; // stronger knowledge -> longer interval
    const due = days / interval;
    p += 0.8 * Math.min(due, 1.5);
    if (due >= 1) reasons.push('review due');
  } else {
    p += 0.4;
  }

  p += 0.2 * (r.difficulty / 5);
  if (reasons.length === 0) reasons.push('practice');
  return { priority: p, eff, reason: reasons.join(', ') };
}

/**
 * Priority-weighted question selection. attempts/knowledge are read through the
 * RLS-scoped app connection, so a user only ever sees their own learning state.
 */
export async function selectQuestions(
  db: Pick<pg.Pool, 'query'>,
  moduleId: string,
  limit = 5,
  now: number = Date.now(),
): Promise<SelectedQuestion[]> {
  const { rows } = await db.query<ConceptStat>(
    `SELECT c.id, c.name, c.week, c.difficulty,
            k.score::float8 AS score, k.last_tested,
            la.is_correct AS last_correct,
            COALESCE(na.n, 0)::int AS n_attempts,
            COALESCE(nq.n, 0)::int AS n_questions
       FROM concepts c
       LEFT JOIN knowledge k ON k.concept_id = c.id
       LEFT JOIN LATERAL (
         SELECT a.is_correct FROM attempts a WHERE a.concept_id = c.id ORDER BY a.created_at DESC LIMIT 1
       ) la ON true
       LEFT JOIN LATERAL (SELECT count(*) AS n FROM attempts a WHERE a.concept_id = c.id) na ON true
       LEFT JOIN (SELECT concept_id, count(*) AS n FROM questions GROUP BY concept_id) nq ON nq.concept_id = c.id
      WHERE c.module_id = $1 AND c.status = 'live'`,
    [moduleId],
  );

  const ranked = rows
    .filter((r) => r.n_questions > 0)
    .map((r) => ({ r, ...priorityFor(r, now) }))
    .sort((a, b) => b.priority - a.priority);

  const out: SelectedQuestion[] = [];
  for (const cand of ranked) {
    if (out.length >= limit) break;
    const q = await db.query<{ id: string; type: 'mcq' | 'free_form'; question: string; options: string[] | null }>(
      `SELECT q.id, q.type, q.question, q.options
         FROM questions q
         LEFT JOIN LATERAL (
           SELECT count(*) AS n, max(a.created_at) AS last_at FROM attempts a WHERE a.question_id = q.id
         ) qa ON true
        WHERE q.concept_id = $1
        ORDER BY COALESCE(qa.n, 0) ASC, qa.last_at ASC NULLS FIRST, q.created_at ASC
        LIMIT 1`,
      [cand.r.id],
    );
    const row = q.rows[0];
    if (!row) continue;
    out.push({
      question: { id: row.id, type: row.type, question: row.question, options: row.options },
      concept: { id: cand.r.id, name: cand.r.name, week: cand.r.week, difficulty: cand.r.difficulty },
      priority: Number(cand.priority.toFixed(3)),
      effective_score: Number(cand.eff.toFixed(3)),
      reason: cand.reason,
    });
  }
  return out;
}
