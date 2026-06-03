import { config } from '../config.js';
import type { EmbeddingProvider } from './types.js';
import { MockEmbeddingProvider } from './mockEmbeddings.js';
import { OpenAIEmbeddingProvider } from './openaiEmbeddings.js';

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  if (config.embeddingProvider === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error('EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set');
    }
    cached = new OpenAIEmbeddingProvider(
      config.openaiApiKey,
      config.embeddingModel,
      config.openaiBaseUrl,
    );
  } else {
    cached = new MockEmbeddingProvider(config.embeddingDim);
  }
  return cached;
}
