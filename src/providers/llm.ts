import { config } from '../config.js';
import type { LlmProvider } from './types.js';
import { AnthropicLlmProvider } from './anthropicLLM.js';
import { MockLlmProvider } from './mockLLM.js';

let cached: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;
  if (config.llmProvider === 'anthropic') {
    if (!config.anthropicApiKey) {
      throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
    }
    cached = new AnthropicLlmProvider(
      config.anthropicApiKey,
      config.llmModel,
      config.anthropicBaseUrl,
    );
  } else {
    cached = new MockLlmProvider();
  }
  return cached;
}
