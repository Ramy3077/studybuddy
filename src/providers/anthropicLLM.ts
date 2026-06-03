import type { CompleteRequest, LlmProvider } from './types.js';

interface AnthropicDelta {
  type: string;
  delta?: { type: string; text?: string };
}

/** Anthropic Claude provider (Messages API). */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    private apiKey: string,
    private model = 'claude-sonnet-4-6',
    private baseUrl = 'https://api.anthropic.com',
  ) {}

  private body(req: CompleteRequest, stream: boolean) {
    return JSON.stringify({
      model: this.model,
      max_tokens: req.maxTokens ?? 1500,
      temperature: req.temperature ?? 0,
      system: req.system,
      stream,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
  }

  private headers() {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }

  async complete(req: CompleteRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, false),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 500)}`);
    }
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    return json.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }

  async *streamComplete(req: CompleteRequest): AsyncIterable<string> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, true),
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new Error(`Anthropic stream ${res.status}: ${t.slice(0, 500)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const evt of events) {
        const line = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as AnthropicDelta;
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text;
          }
        } catch {
          // ignore keep-alive / non-JSON lines
        }
      }
    }
  }
}
