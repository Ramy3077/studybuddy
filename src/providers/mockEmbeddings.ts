import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './types.js';

// Function words carry no topic signal; dropping them keeps the hashed
// bag-of-words vectors about content words, so neighbours are on-topic.
export const STOPWORDS = new Set(
  ('a an and are as at be been but by can do does each for from has have how if in into is it its more most ' +
    'no not of on one or so such than that the their them then there these this those to too up was we what when ' +
    'which while who why will with would you your also only other over same very').split(' '),
);

/**
 * Deterministic, dependency-free embeddings for offline runs and tests.
 *
 * Each text is projected into a fixed `dim`-dimensional space by hashing its
 * word tokens into buckets (a hashed bag-of-words), then L2-normalised. Stopwords are
 * dropped. Cosine similarity between two mock vectors therefore reflects real
 * content-word overlap, so
 * vector search still returns sensible neighbours without any API key.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly dim: number;

  constructor(dim = 1536) {
    this.dim = dim;
  }

  private embedOne(text: string): number[] {
    const vec = new Float64Array(this.dim);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));

    for (const tok of tokens) {
      // Two independent hash buckets per token reduce collisions.
      const h = createHash('md5').update(tok).digest();
      const i1 = h.readUInt32BE(0) % this.dim;
      const i2 = h.readUInt32BE(4) % this.dim;
      vec[i1] = vec[i1]! + 1;
      vec[i2] = vec[i2]! + 0.5;
    }

    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm) || 1;
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = vec[i]! / norm;
    return out;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}
