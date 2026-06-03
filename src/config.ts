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

/**
 * Parse an integer environment variable, enforcing it is a whole number >= min.
 * Rejects 0 / negative / fractional / non-numeric values at boot (fail fast)
 * instead of silently degrading at runtime (e.g. a 0 rate limit blocking all
 * requests). Exported pure for testing.
 */
export function parseIntEnv(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`Env ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function int(name: string, fallback: number, min = 1): number {
  return parseIntEnv(name, process.env[name], fallback, min);
}

const hasOpenAI = !!optional('OPENAI_API_KEY');
const hasAnthropic = !!optional('ANTHROPIC_API_KEY');

export const INSECURE_JWT_DEFAULT = 'dev-insecure-change-me';
const isProd = process.env.NODE_ENV === 'production';

/**
 * Resolve + validate the JWT signing secret. Exported pure for testing.
 * The built-in dev default is public (it ships in the repo / .env.example), so
 * it can never be a real signing key — it is rejected UNCONDITIONALLY. A custom
 * but short (<32 char) secret is allowed in dev (with a warning) and rejected
 * in production.
 */
export function validateJwtSecret(provided: string | undefined, prod: boolean): string {
  const secret = provided ?? INSECURE_JWT_DEFAULT;
  if (secret === INSECURE_JWT_DEFAULT) {
    throw new Error(
      'JWT_SECRET is unset or the built-in dev default. Set a strong random secret, e.g. `openssl rand -hex 32`.',
    );
  }
  if (secret.length < 32) {
    if (prod) {
      throw new Error('JWT_SECRET must be at least 32 characters in production. Use `openssl rand -hex 32`.');
    }
    console.warn(
      '\x1b[33m[security] JWT_SECRET is shorter than 32 chars — fine for local dev only; ' +
        'use a 32+ char random secret before any real deployment.\x1b[0m',
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

  // Auth. Rejects the built-in dev default unconditionally; short secrets are a
  // dev-only warning and a hard error in production (see validateJwtSecret).
  jwtSecret: validateJwtSecret(optional('JWT_SECRET'), isProd),
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

  // Auth brute-force guard: max login/signup attempts per minute, per IP and
  // (for login) per email.
  authRateLimitPerMin: int('AUTH_RATE_LIMIT_PER_MIN', 10),
} as const;

export type AppConfig = typeof config;
