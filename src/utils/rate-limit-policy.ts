import { config } from "../config/config";

export type RateLimitPolicy = {
  scope: string;
  max: number;
  windowSeconds: number;
};

/** Per-scope buckets so dashboard polling cannot exhaust OAuth limits. */
export function rateLimitPolicy(path: string): RateLimitPolicy | null {
  if (path === "/health" || path === "/ready" || path === "/script.js") {
    return null;
  }

  if (path.startsWith("/api/v1/public/sites/")) {
    return {
      scope: "public-stats",
      max: config.publicStatsRateMax,
      windowSeconds: config.publicStatsRateWindow,
    };
  }

  if (path === "/api/v1/auth/google" || path === "/api/v1/auth/google/callback") {
    return {
      scope: "oauth",
      max: config.authRateMax,
      windowSeconds: config.rateWindow,
    };
  }

  if (
    path.startsWith("/api/v1/auth") ||
    path.startsWith("/api/v1/stats") ||
    path.startsWith("/api/v1/sites")
  ) {
    return {
      scope: "dashboard",
      max: config.dashboardRateMax,
      windowSeconds: config.rateWindow,
    };
  }

  return {
    scope: "default",
    max: config.rateMax,
    windowSeconds: config.rateWindow,
  };
}
