import { describe, it, expect, vi } from 'vitest';
import { validateJwtSecret, parseIntEnv, INSECURE_JWT_DEFAULT } from '../src/config.js';

describe('JWT secret guard (#1)', () => {
  it('rejects the built-in dev default UNCONDITIONALLY (dev and prod)', () => {
    expect(() => validateJwtSecret(INSECURE_JWT_DEFAULT, false)).toThrow(/default/i);
    expect(() => validateJwtSecret(INSECURE_JWT_DEFAULT, true)).toThrow(/default/i);
    expect(() => validateJwtSecret(undefined, false)).toThrow(/unset|default/i); // unset -> default
  });

  it('accepts a strong (>=32 char) custom secret in dev and prod', () => {
    const strong = 'a'.repeat(40);
    expect(validateJwtSecret(strong, false)).toBe(strong);
    expect(validateJwtSecret(strong, true)).toBe(strong);
  });

  it('a short custom secret warns in dev but throws in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(validateJwtSecret('short-custom-secret', false)).toBe('short-custom-secret');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(() => validateJwtSecret('short-custom-secret', true)).toThrow(/32 characters/i);
  });
});

describe('integer env bounds (#6)', () => {
  it('rejects 0, negative, fractional and non-numeric values', () => {
    expect(() => parseIntEnv('AI_RATE_LIMIT_PER_MIN', '0', 20)).toThrow();
    expect(() => parseIntEnv('AI_RATE_LIMIT_PER_MIN', '-3', 20)).toThrow();
    expect(() => parseIntEnv('AI_RATE_LIMIT_PER_MIN', '1.5', 20)).toThrow();
    expect(() => parseIntEnv('AI_RATE_LIMIT_PER_MIN', 'abc', 20)).toThrow();
  });

  it('uses the fallback when unset/empty and accepts valid integers', () => {
    expect(parseIntEnv('X', undefined, 20)).toBe(20);
    expect(parseIntEnv('X', '', 20)).toBe(20);
    expect(parseIntEnv('X', '5', 20)).toBe(5);
  });

  it('respects a custom minimum', () => {
    expect(() => parseIntEnv('X', '0', 8080, 1)).toThrow();
    expect(parseIntEnv('X', '1', 8080, 1)).toBe(1);
  });
});
