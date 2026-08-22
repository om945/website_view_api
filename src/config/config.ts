import { isHttpsOrigin, isLocalDevelopmentOrigin } from "../utils/origin";

const bool = (value: string | undefined) => value === "true";

const numberFromEnv = (
  value: string | undefined,
  fallback: number,
) => {
  const parsed = Number(value ?? fallback);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function requiredInProduction(name: string, value: string) {
  if (config.nodeEnv === "production" && !value) {
    throw new Error(`${name} is required in production`);
  }
}

export const config = {
  nodeEnv: Bun.env.NODE_ENV ?? "development",
  host: Bun.env.HOST ?? "0.0.0.0",
  port: numberFromEnv(Bun.env.PORT, 3000),

  databaseUrl:
    Bun.env.DATABASE_URL ??
    (Bun.env.NODE_ENV === "production" ? "" : "postgresql://analytics:analytics@localhost:5432/analytics"),

  redisUrl: Bun.env.REDIS_URL ?? (Bun.env.NODE_ENV === "production" ? "" : "redis://localhost:6379"),

  googleClientId: Bun.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: Bun.env.GOOGLE_CLIENT_SECRET ?? "",

  googleRedirectUri:
    Bun.env.GOOGLE_REDIRECT_URI ??
    (Bun.env.NODE_ENV === "production" ? "" : "http://localhost:3000/api/v1/auth/google/callback"),

  authSuccessRedirectUrl:
    Bun.env.AUTH_SUCCESS_REDIRECT_URL ??
    (Bun.env.NODE_ENV === "production" ? "" : "http://localhost:3000/dashboard"),

  sessionSecret:
    Bun.env.SESSION_SECRET ?? (Bun.env.NODE_ENV === "production" ? "" : "dev-session-secret-change-me"),

  visitorHashSecret:
    Bun.env.VISITOR_HASH_SECRET ?? (Bun.env.NODE_ENV === "production" ? "" : "dev-visitor-secret-change-me"),

  trackerBaseUrl:
    Bun.env.TRACKER_BASE_URL ?? (Bun.env.NODE_ENV === "production" ? "" : "http://localhost:3000"),

  corsOrigins: (Bun.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),

  allowLocalhostCorsInProduction: bool(
    Bun.env.ALLOW_LOCALHOST_CORS_IN_PRODUCTION,
  ),

  trustedProxy: bool(Bun.env.TRUSTED_PROXY),

  sessionTtl: numberFromEnv(Bun.env.SESSION_TTL, 604800),

  rateWindow: numberFromEnv(
    Bun.env.RATE_LIMIT_WINDOW_SECONDS,
    60,
  ),

  rateMax: numberFromEnv(
    Bun.env.RATE_LIMIT_MAX_REQUESTS,
    120,
  ),

  dashboardRateMax: numberFromEnv(
    Bun.env.DASHBOARD_RATE_LIMIT_MAX_REQUESTS,
    60,
  ),

  authRateMax: numberFromEnv(
    Bun.env.AUTH_RATE_LIMIT_MAX_REQUESTS,
    30,
  ),

  publicStatsRateWindow: numberFromEnv(
    Bun.env.PUBLIC_STATS_RATE_LIMIT_WINDOW_SECONDS,
    60,
  ),

  publicStatsRateMax: numberFromEnv(
    Bun.env.PUBLIC_STATS_RATE_LIMIT_MAX_REQUESTS,
    60,
  ),

  activeTtl: numberFromEnv(
    Bun.env.ACTIVE_VISITOR_TTL_SECONDS,
    45,
  ),

  heartbeatIntervalSeconds: numberFromEnv(
    Bun.env.HEARTBEAT_INTERVAL_SECONDS,
    15,
  ),

  dataRetentionDays: numberFromEnv(
    Bun.env.DATA_RETENTION_DAYS,
    90,
  ),

  retentionCleanupEnabled: bool(
    Bun.env.ENABLE_RETENTION_CLEANUP,
  ),

  maxRequestBodyBytes: numberFromEnv(
    Bun.env.MAX_REQUEST_BODY_BYTES,
    16 * 1024,
  ),

  sessionTimeoutMs: 2 * 60 * 60 * 1000,
} as const;

if (config.nodeEnv === "production") {
  for (const [name, value] of Object.entries({
    DATABASE_URL: config.databaseUrl,
    REDIS_URL: config.redisUrl,
    GOOGLE_CLIENT_ID: config.googleClientId,
    GOOGLE_CLIENT_SECRET: config.googleClientSecret,
    GOOGLE_REDIRECT_URI: config.googleRedirectUri,
    AUTH_SUCCESS_REDIRECT_URL: config.authSuccessRedirectUrl,
    SESSION_SECRET: config.sessionSecret,
    VISITOR_HASH_SECRET: config.visitorHashSecret,
    TRACKER_BASE_URL: config.trackerBaseUrl,
  })) {
    requiredInProduction(name, value);
  }

  if (
    config.sessionSecret.length < 32 ||
    config.visitorHashSecret.length < 32 ||
    config.sessionSecret.includes("dev-") ||
    config.visitorHashSecret.includes("dev-")
  ) {
    throw new Error(
      "Production session and visitor hash secrets must be unique values of at least 32 characters",
    );
  }

  if (
    config.databaseUrl.includes("localhost") ||
    config.redisUrl.includes("localhost") ||
    config.databaseUrl.includes("analytics:analytics")
  ) {
    throw new Error(
      "Production DATABASE_URL and REDIS_URL must not use local development defaults",
    );
  }

  if (
    !config.googleRedirectUri.startsWith("https://") ||
    !config.authSuccessRedirectUrl.startsWith("https://") ||
    !config.trackerBaseUrl.startsWith("https://")
  ) {
    throw new Error("Production public URLs must use HTTPS");
  }

  if (
    !config.corsOrigins.includes(
      new URL(config.authSuccessRedirectUrl).origin,
    )
  ) {
    throw new Error(
      "AUTH_SUCCESS_REDIRECT_URL must point to an origin listed in CORS_ORIGINS",
    );
  }

  if (!config.trustedProxy) {
    throw new Error(
      "TRUSTED_PROXY=true is required for production reverse-proxy deployments",
    );
  }

  if (
    config.corsOrigins.length === 0 ||
    config.corsOrigins.includes("*") ||
    config.corsOrigins.some(
      (origin) =>
        !isHttpsOrigin(origin) &&
        !(
          config.allowLocalhostCorsInProduction &&
          isLocalDevelopmentOrigin(origin)
        ),
    )
  ) {
    throw new Error(
      "CORS_ORIGINS must contain explicit HTTPS dashboard origins in production, except localhost origins when ALLOW_LOCALHOST_CORS_IN_PRODUCTION=true",
    );
  }
}