import { describe, expect, test } from "bun:test";

import { ProgressivePenaltyLimiter, TokenBucketRateLimiter } from "./rate-limit";

describe("TokenBucketRateLimiter", () => {
  test("permits a short burst and then refills gradually", () => {
    const limiter = new TokenBucketRateLimiter(2, 0.5, 0);

    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0).allowed).toBe(true);
    expect(limiter.consume(0)).toEqual({ allowed: false, retryAfterSeconds: 2 });
    expect(limiter.consume(2_000).allowed).toBe(true);
  });
});

describe("ProgressivePenaltyLimiter", () => {
  test("increases penalties for repeated violations and resets after a quiet period", () => {
    const limiter = new ProgressivePenaltyLimiter([5, 15, 30], 10_000);

    expect(limiter.registerViolation("127.0.0.1", 0)).toBe(5);
    expect(limiter.getRemainingPenaltySeconds("127.0.0.1", 1_000)).toBe(4);
    expect(limiter.registerViolation("127.0.0.1", 5_000)).toBe(15);
    expect(limiter.registerViolation("127.0.0.1", 14_999)).toBe(30);
    expect(limiter.registerViolation("127.0.0.1", 25_000)).toBe(5);
  });
});
