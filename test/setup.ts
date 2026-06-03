// Runs before the test module graph is imported. Provide a strong, non-default
// JWT_SECRET so importing src/config.ts (which now rejects the dev default
// unconditionally) does not throw during tests. dotenv does not override an
// already-set process.env var, so this wins over any .env.
process.env.JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef0123456789abcdef';
delete process.env.NODE_ENV; // ensure tests run in non-production mode
