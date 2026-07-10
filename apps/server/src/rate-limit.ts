export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * A small token bucket for actions that are cheap individually but can be
 * abused in a tight loop. Tokens refill gradually, so normal bursts still
 * feel instant while sustained flooding is rejected.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillTokensPerSecond: number,
    now = Date.now()
  ) {
    this.tokens = capacity;
    this.lastRefillAt = now;
  }

  consume(now = Date.now()): RateLimitResult {
    const elapsedSeconds = Math.max(0, now - this.lastRefillAt) / 1_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillTokensPerSecond);
    this.lastRefillAt = now;

    if (this.tokens < 1) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - this.tokens) / this.refillTokensPerSecond))
      };
    }

    this.tokens -= 1;
    return { allowed: true };
  }
}

type PenaltyEntry = {
  blockedUntil: number;
  lastViolationAt: number;
  violations: number;
};

/**
 * Escalates repeated rate-limit violations from the same client. A quiet
 * period clears the history so an accidental burst is not held against a
 * normal user indefinitely.
 */
export class ProgressivePenaltyLimiter {
  private readonly entries = new Map<string, PenaltyEntry>();

  constructor(
    private readonly penaltiesInSeconds = [5, 15, 30, 60, 300],
    private readonly resetAfterMs = 10 * 60 * 1_000
  ) {}

  getRemainingPenaltySeconds(key: string, now = Date.now()) {
    const entry = this.entries.get(key);

    if (!entry || entry.blockedUntil <= now) {
      return 0;
    }

    return Math.ceil((entry.blockedUntil - now) / 1_000);
  }

  registerViolation(key: string, now = Date.now()) {
    const previous = this.entries.get(key);
    const violations = !previous || now - previous.lastViolationAt >= this.resetAfterMs
      ? 1
      : previous.violations + 1;
    const penaltySeconds = this.penaltiesInSeconds[Math.min(violations - 1, this.penaltiesInSeconds.length - 1)]!;

    this.entries.set(key, {
      violations,
      lastViolationAt: now,
      blockedUntil: now + penaltySeconds * 1_000
    });

    return penaltySeconds;
  }
}
