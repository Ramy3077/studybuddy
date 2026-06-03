import { config as loadEnv } from 'dotenv';

loadEnv();

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got ${v}`);
  return n;
}

const hasOpenAI = !!optional('OPENAI_API_KEY');
const hasAnthropic = !!optional('ANTHROPIC_API_KEY');

const INSECURE_JWT_DEFAULT = 'dev-insecure-change-me';
const isProd = process.env.NODE_ENV === 'production';

function resolveJwtSecret(): string {
  const provided = optional('JWT_SECRET');
  const secret = provided ?? INSECURE_JWT_DEFAULT;
  const weak = secret === INSECURE_JWT_DEFAULT || secret.length < 32;
  if (weak) {
    if (isProd) {
      throw new Error(
        'JWT_SECRET is missing, the built-in dev default, or shorter than 32 chars. ' +
          'Refusing to start in production. Set a strong random JWT_SECRET (e.g. `openssl rand -hex 32`).',
      );
    }
    console.warn(
      '\x1b[33m[security] Using a weak/default JWT_SECRET. This is fine for local dev only — ' +
        'set a strong random JWT_SECRET before any real deployment.\x1b[0m',
    );
  }
  return secret;
}

export const config = {
  // Database. DATABASE_URL is the privileged owner connection used by
  // migrations, ingestion and the pipelines (bypasses RLS as table owner).
  // APP_DATABASE_URL is the un-privileged role the HTTP API uses for
  // user-scoped requests, where RLS is FORCED.
  databaseUrl: str('DATABASE_URL', 'postgresql://studybuddy_owner:owner_pw@localhost:5433/studybuddy'),
  appDatabaseUrl: str('APP_DATABASE_URL', 'postgresql://studybuddy_app:app_pw@localhost:5433/studybuddy'),

  // Auth. Refuses the dev default / short secrets in production (see above).
  jwtSecret: resolveJwtSecret(),
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 24 * 7),

  // HTTP
  port: int('PORT', 8080),

  // Module / ingestion
  vaultPath: str('VAULT_PATH', './demo/corpus'),
  moduleSlug: str('MODULE_SLUG', 'ml'),
  moduleName: str('MODULE_NAME', 'Machine Learning'),

  // Providers (swappable). Default to the real provider only if a key is set.
  embeddingProvider: str('EMBEDDING_PROVIDER', hasOpenAI ? 'openai' : 'mock') as 'openai' | 'mock',
  llmProvider: str('LLM_PROVIDER', hasAnthropic ? 'anthropic' : 'mock') as 'anthropic' | 'mock',
  embeddingModel: str('EMBEDDING_MODEL', 'text-embedding-3-small'),
  llmModel: str('LLM_MODEL', 'claude-sonnet-4-6'),
  embeddingDim: 1536,

  openaiApiKey: optional('OPENAI_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  anthropicBaseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),

  // AI endpoint guardrails
  aiRateLimitPerMin: int('AI_RATE_LIMIT_PER_MIN', 20),
  aiMaxBodyBytes: int('AI_MAX_BODY_BYTES', 16 * 1024),
  maxAnswerChars: int('MAX_ANSWER_CHARS', 4000),
} as const;

export type AppConfig = typeof config;
