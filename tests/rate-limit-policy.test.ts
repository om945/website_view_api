import { describe, expect, test } from "bun:test";
import { rateLimitPolicy } from "../src/utils/rate-limit-policy";
import { localRateLimit } from "../src/utils/local-rate-limit";

describe("rateLimitPolicy", () => {
  test("skips health and static assets", () => {
    expect(rateLimitPolicy("/health", "GET")).toBeNull();
    expect(rateLimitPolicy("/ready", "GET")).toBeNull();
    expect(rateLimitPolicy("/script.js", "GET")).toBeNull();
  });

  test("uses oauth scope only for Google auth endpoints", () => {
    expect(rateLimitPolicy("/api/v1/auth/google", "GET")?.scope).toBe("oauth");
    expect(rateLimitPolicy("/api/v1/auth/google/callback", "GET")?.scope).toBe("oauth");
    expect(rateLimitPolicy("/api/v1/auth/me", "GET")?.scope).toBe("dashboard");
    expect(rateLimitPolicy("/api/v1/auth/logout", "POST")?.scope).toBe("dashboard");
  });

  test("skips analytics reads and public ingestion", () => {
    expect(rateLimitPolicy("/api/v1/stats", "GET")).toBeNull();
    expect(rateLimitPolicy("/api/v1/stats/pages", "GET")).toBeNull();
    expect(rateLimitPolicy("/api/v1/track", "POST")).toBeNull();
    expect(rateLimitPolicy("/api/v1/events", "POST")).toBeNull();
    expect(rateLimitPolicy("/api/v1/public/sites/site_abc/visitor-count", "GET")).toBeNull();
  });

  test("keeps distributed protection for site mutations", () => {
    expect(rateLimitPolicy("/api/v1/sites", "POST")?.scope).toBe("dashboard");
    expect(rateLimitPolicy("/api/v1/sites/site_abc", "DELETE")?.scope).toBe("dashboard");
  });

  test("local protection is bounded and does not require Redis", () => {
    const key = `test-local-${Date.now()}`;
    expect(localRateLimit(key, 2, 60, 1_000)).toBe(true);
    expect(localRateLimit(key, 2, 60, 1_001)).toBe(true);
    expect(localRateLimit(key, 2, 60, 1_002)).toBe(false);
    expect(localRateLimit(key, 2, 60, 61_000)).toBe(true);
  });
});
