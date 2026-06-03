// Tiny fixed-window in-memory rate limiter. Keyed by an arbitrary string
// (e.g. `${userId}:${bucket}`). Good enough for a single-node app; swap for a
// shared store (Redis) if horizontally scaled.

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export function rateLimit(key: string, limit: number, windowMs = 60_000): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now >= w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (w.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count++;
  return { ok: true, retryAfter: 0 };
}

// Periodically drop expired windows so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
}, 60_000).unref?.();
