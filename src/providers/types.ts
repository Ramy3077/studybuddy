// Swappable provider interfaces. Real implementations call OpenAI / Anthropic;
// mock implementations are deterministic so the whole app runs offline.

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  /** Returns one vector per input text, in order. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Deterministic fallback hint consumed ONLY by the mock provider so the full
   * pipeline can run with no API key. Real providers ignore this entirely.
   */
  mock?: { task: string; payload: unknown };
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompleteRequest): Promise<string>;
  streamComplete(req: CompleteRequest): AsyncIterable<string>;
}
