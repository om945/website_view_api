import { config } from "../config/config";

export type RateLimitPolicy = {
  scope: string;
  max: number;
  windowSeconds: number;
};

/**
 * Redis is reserved for distributed protection of authentication and mutations.
 * Analytics reads and public ingestion use local protection in the request
 * middleware so normal analytics traffic does not consume Redis commands.
 */
export function rateLimitPolicy(
  path: string,
  method: string,
): RateLimitPolicy | null {
  if (path === "/health" || path === "/ready" || path === "/script.js") {
    return null;
  }

  if (path === "/api/v1/auth/google" || path === "/api/v1/auth/google/callback") {
    return {
      scope: "oauth",
      max: config.authRateMax,
      windowSeconds: config.rateWindow,
    };
  }

  if (path.startsWith("/api/v1/auth")) {
    return {
      scope: "dashboard",
      max: config.dashboardRateMax,
      windowSeconds: config.rateWindow,
    };
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    path.startsWith("/api/v1/sites")
  ) {
    return {
      scope: "dashboard",
      max: config.dashboardRateMax,
      windowSeconds: config.rateWindow,
    };
  }

  return null;
}
