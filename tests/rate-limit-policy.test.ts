import { describe, expect, test } from "bun:test";
import { rateLimitPolicy } from "../src/utils/rate-limit-policy";

describe("rateLimitPolicy", () => {
  test("skips health and static assets", () => {
    expect(rateLimitPolicy("/health")).toBeNull();
    expect(rateLimitPolicy("/ready")).toBeNull();
    expect(rateLimitPolicy("/script.js")).toBeNull();
  });

  test("uses oauth scope only for Google auth endpoints", () => {
    expect(rateLimitPolicy("/api/v1/auth/google")?.scope).toBe("oauth");
    expect(rateLimitPolicy("/api/v1/auth/google/callback")?.scope).toBe("oauth");
    expect(rateLimitPolicy("/api/v1/auth/me")?.scope).toBe("dashboard");
    expect(rateLimitPolicy("/api/v1/auth/logout")?.scope).toBe("dashboard");
  });

  test("uses dashboard scope for stats and sites", () => {
    expect(rateLimitPolicy("/api/v1/stats")?.scope).toBe("dashboard");
    expect(rateLimitPolicy("/api/v1/sites")?.scope).toBe("dashboard");
  });
});
