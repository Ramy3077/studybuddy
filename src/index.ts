import { serve } from '@hono/node-server';
import { config } from './config.js';
import { createApp } from './server/app.js';

const app = createApp();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`StudyBuddy listening on http://localhost:${info.port}`);
  console.log(`Providers: embeddings=${config.embeddingProvider}, llm=${config.llmProvider}`);
});
