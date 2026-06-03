import type { EmbeddingProvider } from './types.js';

/** OpenAI text-embedding-3-small (1536-dim) provider. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dim = 1536;

  constructor(
    private apiKey: string,
    private model = 'text-embedding-3-small',
    private baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // OpenAI accepts up to 2048 inputs per call; callers batch upstream too.
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Preserve input order regardless of response ordering.
    const out = new Array<number[]>(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    return out;
  }
}
