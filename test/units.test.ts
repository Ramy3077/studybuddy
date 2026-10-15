import { describe, it, expect } from 'vitest';
import { bm25Rank, tokenize } from '../src/lexical.js';
import { chunkByWords } from '../src/ingest/chunk.js';
import { cleanObsidian } from '../src/ingest/markdown.js';
import { cleanTranscript } from '../src/ingest/transcript.js';
import { isVerbatimSubstring, verbatimSpan, countWords, isCleanProse } from '../src/util/text.js';
import { validateQuestion } from '../src/pipelines/questions.js';
import { parseSlideName, parseTranscriptName } from '../src/ingest/discover.js';
import type { RetrievedChunk } from '../src/types.js';

describe('chunkByWords', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has several words in it.`).join(' ');
  const chunks = chunkByWords(text, { maxWords: 40, overlapWords: 8, minWords: 5 });

  it('produces multiple overlapping chunks', () => {
    expect(chunks.length).toBeGreaterThan(1);
  });
  it('every chunk text is a verbatim slice at its offsets', () => {
    for (const c of chunks) expect(c.text).toBe(text.slice(c.char_start, c.char_end));
  });
  it('respects the max word budget (approximately)', () => {
    for (const c of chunks) expect(countWords(c.text)).toBeLessThanOrEqual(40);
  });
  it('consecutive chunks overlap', () => {
    expect(chunks[1]!.char_start).toBeLessThan(chunks[0]!.char_end);
  });
});

describe('cleanObsidian', () => {
  const raw = `---\ncourse: ML\ntags: [a]\n---\n# Heading\n![[1a-intro.pdf]]\nSee [[wikilink]] and [[target|alias]] and [a link](http://x).\n> [!abstract] TL;DR\n> Important callout text.\n#machine-learning tag here.\nMath stays: $\\mathbf{w}^T\\mathbf{x}$.`;
  const out = cleanObsidian(raw);

  it('strips YAML frontmatter', () => expect(out).not.toContain('course: ML'));
  it('drops ![[embeds]]', () => expect(out).not.toContain('1a-intro.pdf'));
  it('unwraps wikilinks and aliases', () => {
    expect(out).toContain('wikilink');
    expect(out).toContain('alias');
    expect(out).not.toContain('[[');
  });
  it('unwraps markdown links to their text', () => {
    expect(out).toContain('a link');
    expect(out).not.toContain('http://x');
  });
  it('flattens callouts and removes the [!type] marker', () => {
    expect(out).toContain('Important callout text.');
    expect(out).not.toContain('[!abstract]');
  });
  it('removes inline #tags but keeps # headings and $math$', () => {
    expect(out).not.toMatch(/#machine-learning/);
    expect(out).toContain('# Heading');
    expect(out).toContain('\\mathbf{w}');
  });
});

describe('cleanTranscript', () => {
  it('strips the generator banner, WEBVTT, cue indices and timecodes', () => {
    const raw = `[Auto-generated transcript. Edits may have been applied for clarity.]\nWEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nToday we discuss gradient descent.\n\n2\n00:00:04.000 --> 00:00:07.000\nIt minimises the loss.`;
    const out = cleanTranscript(raw);
    expect(out).not.toContain('Auto-generated');
    expect(out).not.toContain('WEBVTT');
    expect(out).not.toContain('-->');
    expect(out).not.toMatch(/^\s*\d+\s*$/m);
    expect(out).toContain('gradient descent');
    expect(out).toContain('minimises the loss');
  });
});

describe('grounding helpers', () => {
  it('isVerbatimSubstring tolerates whitespace and case differences', () => {
    expect(isVerbatimSubstring('gradient   descent', 'we use gradient descent here')).toBe(true);
    expect(isVerbatimSubstring('Gradient Descent', 'we use gradient descent here')).toBe(true); // case-folded
    expect(isVerbatimSubstring('gradient ascent', 'we use gradient descent here')).toBe(false);
  });
  it('isCleanProse rejects page markers and markup, accepts prose', () => {
    expect(isCleanProse('The SVM maximises the margin between two classes.')).toBe(true);
    expect(isCleanProse('[p.23] f ( x ) = 0.5')).toBe(false);
    expect(isCleanProse('### Heading with $$math$$ and a | table |')).toBe(false);
  });
  it('verbatimSpan returns a real substring within the word bound', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    const span = verbatimSpan(text, 5, 8);
    expect(text).toContain(span);
    expect(countWords(span)).toBeGreaterThanOrEqual(5);
    expect(countWords(span)).toBeLessThanOrEqual(8);
  });
});

describe('validateQuestion enforces the grounding contract', () => {
  const chunk = {
    id: '11111111-1111-1111-1111-111111111111',
    source_id: 's', chunk_index: 0,
    text: 'The support vector machine maximises the margin between the two classes using support vectors.',
    locator: { kind: 'text', chunk_index: 0, char_start: 0, char_end: 10 },
    distance: 0, source_title: 't', source_type: 'slides', source_code: '5a', week: 5,
  } as unknown as RetrievedChunk;

  it('drops a question whose evidence is not verbatim in any chunk', () => {
    const v = validateQuestion(
      { type: 'free_form', question: 'q', options: null, correct_answer: 'a', explanation: '', evidence_quote: 'this phrase is fabricated and absent', source_chunk_ids: [chunk.id] } as any,
      [chunk],
    );
    expect(v).toBeNull();
  });
  it('accepts a free-form question grounded in a verbatim quote', () => {
    const v = validateQuestion(
      { type: 'free_form', question: 'q', options: null, correct_answer: 'a', explanation: '', evidence_quote: 'maximises the margin between the two classes', source_chunk_ids: [] } as any,
      [chunk],
    );
    expect(v).not.toBeNull();
    expect(v!.source_chunk_ids).toContain(chunk.id); // host chunk auto-attached
  });
  it('rejects an MCQ without 4 distinct options or whose correct answer is absent', () => {
    const base = { type: 'mcq', question: 'q', explanation: '', evidence_quote: 'maximises the margin between the two classes', source_chunk_ids: [chunk.id] };
    expect(validateQuestion({ ...base, options: ['a', 'b', 'c'], correct_answer: 'a' } as any, [chunk])).toBeNull();
    expect(validateQuestion({ ...base, options: ['a', 'a', 'b', 'c'], correct_answer: 'a' } as any, [chunk])).toBeNull();
    expect(validateQuestion({ ...base, options: ['a', 'b', 'c', 'd'], correct_answer: 'z' } as any, [chunk])).toBeNull();
    expect(validateQuestion({ ...base, options: ['a', 'b', 'c', 'd'], correct_answer: 'a' } as any, [chunk])).not.toBeNull();
  });
});

describe('discovery filename parsing', () => {
  it('parses both slide naming schemes', () => {
    expect(parseSlideName('1a-introduction.pdf')).toMatchObject({ week: 1, lecture: 'a', code: '1a' });
    expect(parseSlideName('2b-newton-raphson-IRLS.pdf')).toMatchObject({ week: 2, lecture: 'b', code: '2b' });
    expect(parseSlideName('W07-01-LinearRegression.pdf')).toMatchObject({ week: 7, lecture: 'a', code: '7a' });
    expect(parseSlideName('W11-01-Validation.pdf')).toMatchObject({ week: 11, lecture: 'a', code: '11a' });
  });
  it('parses combined / tutorial / assessment transcripts', () => {
    expect(parseTranscriptName('9a _ 9b_Captions_English (United States).txt')).toMatchObject({ week: 9, kind: 'lecture' });
    expect(parseTranscriptName('Tutorial Week 10_Captions_English (United States).txt')).toMatchObject({ week: 10, kind: 'tutorial' });
    expect(parseTranscriptName('Tutorial - 9c_Captions_English (United States).txt')).toMatchObject({ week: 9, kind: 'tutorial' });
    expect(parseTranscriptName('12-assessment-support-week_Captions_English (United States).txt')).toMatchObject({ week: 12, kind: 'assessment_support' });
    expect(parseTranscriptName('6a - Revision Part 1 - 04 November 2025 at 15_48_13_Captions_English (United States).txt')).toMatchObject({ week: 6, kind: 'revision' });
  });
});


describe('BM25 lexical retrieval (offline demo provider)', () => {
  const docs = [
    'Gradient descent updates parameters by stepping against the gradient of the loss, scaled by the learning rate.',
    'Regularisation adds a penalty on weight size to reduce overfitting on the training data.',
    'K-means clustering assigns each point to the nearest centroid and recomputes the centroids.',
  ];

  it('tokenizes to stemmed content words', () => {
    expect(tokenize('The learning rates are Updating')).toEqual(['learn', 'rate', 'updat']);
  });

  it('ranks the on-topic chunk first', () => {
    const hits = bm25Rank('how does the learning rate affect gradient descent steps', docs);
    expect(hits[0]?.index).toBe(0);
  });

  it('returns nothing when no chunk is relevant', () => {
    expect(bm25Rank('quantum chromodynamics lagrangian', docs)).toEqual([]);
  });

  it('drops weak single-word matches', () => {
    // "data" appears in one chunk only: one shared term is below the floor
    expect(bm25Rank('what is a database index', docs)).toEqual([]);
  });

  it('drops hits far below the best hit', () => {
    const hits = bm25Rank('penalty overfitting weight loss', docs, { minRelative: 0.9, minMatched: 1, minScore: 0 });
    expect(hits.map((h) => h.index)).toEqual([1]);
  });
});
