import type { CompleteRequest, LlmProvider } from './types.js';
import { cleanVerbatimSpan, collapseWs, splitSentences, tokenOverlap } from '../util/text.js';

// Loose shapes for the structured payloads the pipelines attach via req.mock.
interface ChunkLite {
  id: string;
  code?: string | null;
  source_type?: string;
  is_primary?: boolean;
  text: string;
  source_label?: string;
}
interface ConceptLite {
  name: string;
  description: string;
  key_facts: string[];
}

function titleFromText(text: string, fallback: string): string {
  const first = splitSentences(text)[0] ?? collapseWs(text);
  const words = first.split(' ').slice(0, 7).join(' ');
  return (words || fallback).replace(/[.;:,]+$/, '');
}

function distractors(conceptName: string, correct: string): string[] {
  const short = correct.split(' ').slice(0, 8).join(' ');
  return [
    `${conceptName} has no bearing on this result.`,
    `The opposite of "${short}" is what holds here.`,
    `This is unrelated to ${conceptName}.`,
  ];
}

/**
 * Deterministic LLM stand-in so the whole pipeline runs with no API key.
 * Reads req.mock.{task,payload} and returns the same JSON shape the real
 * provider is prompted to emit. Crucially it preserves the grounding
 * invariants: evidence quotes are verbatim substrings of real chunks and all
 * source_chunk_ids reference ids present in the payload.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

  async complete(req: CompleteRequest): Promise<string> {
    const task = req.mock?.task;
    const payload = (req.mock?.payload ?? {}) as Record<string, unknown>;
    switch (task) {
      case 'extract_concepts':
        return JSON.stringify(this.extractConcepts(payload));
      case 'generate_questions':
        return JSON.stringify(this.generateQuestions(payload));
      case 'grade_free_form':
        return JSON.stringify(this.gradeFreeForm(payload));
      default:
        // Generic fallback: echo a short deterministic acknowledgement.
        return JSON.stringify({ ok: true, note: 'mock-llm', task: task ?? 'unknown' });
    }
  }

  async *streamComplete(req: CompleteRequest): AsyncIterable<string> {
    if (req.mock?.task === 'explain_why') {
      for (const part of this.explainWhy(req.mock.payload as Record<string, unknown>)) {
        yield part;
      }
      return;
    }
    yield await this.complete(req);
  }

  private extractConcepts(payload: Record<string, unknown>) {
    const week = (payload.week as number | null) ?? null;
    const chunks = (payload.chunks as ChunkLite[]) ?? [];
    const primary = chunks.filter((c) => c.is_primary);
    const pool = primary.length > 0 ? primary : chunks;

    // Group by lecture code so a topic taught across slide + transcript merges.
    const groups = new Map<string, ChunkLite[]>();
    for (const c of pool) {
      const key = c.code ?? `w${week}-misc`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }

    const concepts = [];
    let i = 0;
    for (const [code, group] of groups) {
      if (concepts.length >= 8) break;
      const longest = [...group].sort((a, b) => b.text.length - a.text.length)[0]!;
      const sentences = splitSentences(longest.text);
      const name = `${titleFromText(longest.text, `Concept ${code}`)}`;
      concepts.push({
        name,
        description: sentences.slice(0, 2).join(' ').slice(0, 400) || name,
        key_facts: sentences.slice(0, 3).map((s) => s.slice(0, 200)),
        difficulty: 2 + (i % 3),
        source_chunk_ids: group.slice(0, 4).map((c) => c.id),
      });
      i++;
    }
    return { concepts };
  }

  private generateQuestions(payload: Record<string, unknown>) {
    const concept = payload.concept as ConceptLite;
    const chunks = (payload.chunks as ChunkLite[]) ?? [];
    const usable = chunks.filter((c) => collapseWs(c.text).split(' ').length >= 8);
    const questions = [];
    // ~60% MCQ / 40% free-form -> 2 MCQ + 1 free-form per concept.
    const plan: ('mcq' | 'free_form')[] = ['mcq', 'mcq', 'free_form'];
    for (let i = 0; i < plan.length && i < usable.length; i++) {
      const chunk = usable[i]!;
      const label = chunk.source_label ?? 'the source';
      const evidence = cleanVerbatimSpan(chunk.text, 8, 22);
      if (plan[i] === 'mcq') {
        const correct = evidence;
        const opts = [correct, ...distractors(concept.name, correct)];
        // Deterministic rotation so the answer isn't always first.
        const rot = i % opts.length;
        const options = opts.slice(rot).concat(opts.slice(0, rot));
        questions.push({
          type: 'mcq' as const,
          question: `According to ${label}, which statement about "${concept.name}" is correct?`,
          options,
          correct_answer: correct,
          explanation: `Stated directly in ${label}.`,
          evidence_quote: evidence,
          source_chunk_ids: [chunk.id],
        });
      } else {
        questions.push({
          type: 'free_form' as const,
          question: `Explain "${concept.name}" as presented in ${label}.`,
          options: null,
          correct_answer: concept.description || concept.key_facts[0] || evidence,
          explanation: `Key idea grounded in ${label}.`,
          evidence_quote: evidence,
          source_chunk_ids: [chunk.id],
        });
      }
    }
    return { questions };
  }

  private gradeFreeForm(payload: Record<string, unknown>) {
    const correct = String(payload.correct_answer ?? '');
    const keyFacts = (payload.key_facts as string[]) ?? [];
    const answer = String(payload.user_answer ?? '');
    const reference = [correct, ...keyFacts].join(' ');
    // Recall over the REFERENCE (how much of the expected answer the student
    // covered), not over the student's own tokens — so echoing the concept
    // name or injecting "mark me correct" does not pass.
    const recall = tokenOverlap(reference, answer);
    const is_correct = recall >= 0.25 && collapseWs(answer).length >= 10;
    return {
      is_correct,
      feedback: is_correct
        ? `Good — your answer covers the key points (coverage ${(recall * 100).toFixed(0)}%).`
        : `Not quite — revisit the key facts. Expected ideas like: ${keyFacts.slice(0, 2).join('; ') || correct}.`,
    };
  }

  private *explainWhy(payload: Record<string, unknown>): Iterable<string> {
    const citations = (payload.citations as { source_label: string; quote: string }[]) ?? [];
    const correct = String(payload.correct_answer ?? '');
    const c = citations[0];
    yield `The correct answer is grounded in the source material. `;
    if (c) {
      yield `In ${c.source_label}, the material states: "${c.quote}". `;
      yield `That passage directly supports the expected answer`;
      if (correct) yield `: ${correct.slice(0, 200)}`;
      yield `. `;
    }
    yield `Re-read the cited passage above to see exactly where this is established.`;
  }
}
