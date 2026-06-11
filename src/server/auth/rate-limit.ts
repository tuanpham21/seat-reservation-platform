import { AuthError } from "./errors";

type Bucket = {
  count: number;
  resetAt: number;
};

// TODO(prod): replace per-process buckets with Redis or edge rate limiting before multi-instance deploys.
const buckets = new Map<string, Bucket>();

export function assertRateLimit(key: string, options = { limit: 10, windowMs: 60_000 }) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return;
  }

  if (bucket.count >= options.limit) {
    throw new AuthError("Too many attempts. Try again shortly.", "rate_limited");
  }

  bucket.count += 1;
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
