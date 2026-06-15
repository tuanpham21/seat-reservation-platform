import { AuthError } from "./errors";

type Bucket = {
  count: number;
  resetAt: number;
};

type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  retryAfterMs: number;
};

// TODO(prod): replace per-process buckets with Redis or edge rate limiting before multi-instance deploys.
const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  key: string,
  options: RateLimitOptions = { limit: 10, windowMs: 60_000 }
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return {
      allowed: true,
      retryAfterMs: 0
    };
  }

  if (bucket.count >= options.limit) {
    return {
      allowed: false,
      retryAfterMs: bucket.resetAt - now
    };
  }

  bucket.count += 1;

  return {
    allowed: true,
    retryAfterMs: 0
  };
}

export function assertRateLimit(
  key: string,
  options: RateLimitOptions = { limit: 10, windowMs: 60_000 }
) {
  const result = checkRateLimit(key, options);

  if (!result.allowed) {
    throw new AuthError("Too many attempts. Try again shortly.", "rate_limited");
  }
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
