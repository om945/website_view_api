import { Elysia, t } from "elysia";
import cors from "@elysiajs/cors";
import { createHash, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { prisma } from "./db/prisma";
import { redis } from "./redis/redis";
import { rateLimit } from "./redis/rate-limit";
import { config } from "./config/config";
import { clientIp } from "./utils/ip";
import { domainOk, normalizeDomain } from "./utils/domain";
import { hash, newKey } from "./utils/hashing";
import { parseUserAgent } from "./utils/user-agent";
import { apiError, userFacingMessage, type ApiErrorCode } from "./utils/errors";
import { logger } from "./utils/logger";
import { requestId } from "./middleware/request-context";
import { securityHeaders } from "./middleware/security";
import { getPublicVisitorCount } from "./services/public-stats.service";
import { corsAllows, corsOriginAllowed } from "./utils/cors";
import { rateLimitPolicy } from "./utils/rate-limit-policy";
import { localRateLimit } from "./utils/local-rate-limit";

const error = apiError;

const tokenHash = (token: string) =>
  createHash("sha256")
    .update(token + config.sessionSecret)
    .digest("hex");

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const oauthStateHash = (state: string) =>
  createHash("sha256")
    .update(state + config.sessionSecret)
    .digest("hex");

async function currentUser(request: Request) {
  const raw = request.headers
    .get("cookie")
    ?.match(/analytics_session=([^;]+)/)?.[1];

  if (!raw) {
    return null;
  }

  const session = await prisma.authSession.findUnique({
    where: {
      tokenHash: tokenHash(raw),
    },
    include: {
      user: true,
    },
  });

  return session && session.expiresAt > new Date()
    ? session.user
    : null;
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function resolveAuthRedirect(encoded: string | undefined) {
  const configured = new URL(config.authSuccessRedirectUrl);
  const requested = encoded
    ? decodeURIComponent(encoded)
    : "/dashboard";

  const target = new URL(requested, configured.origin);
  const allowed =
    target.pathname === "/dashboard" ||
    target.pathname.startsWith("/dashboard/");

  return target.origin === configured.origin && allowed
    ? target.toString()
    : new URL("/dashboard", configured.origin).toString();
}

const authCookieAttrs =
  `HttpOnly; SameSite=${config.nodeEnv === "production" ? "None" : "Lax"}; Path=/`;

const secureCookieSuffix =
  config.nodeEnv === "production" ? "; Secure" : "";

type SiteAccess =
  | {
      ok: true;
      site: NonNullable<
        Awaited<ReturnType<typeof prisma.site.findUnique>>
      >;
    }
  | {
      ok: false;
      error: ReturnType<typeof error>;
    };

async function siteFor(
  request: Request,
  key: string,
): Promise<SiteAccess> {
  const user = await currentUser(request);

  if (!user) {
    return {
      ok: false,
      error: error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401),
    };
  }

  const site = await prisma.site.findUnique({
    where: {
      siteKey: key,
    },
  });

  if (!site) {
    return {
      ok: false,
      error: error("NOT_FOUND", "Website not found. It may have been deleted.", 404),
    };
  }

  if (site.userId !== user.id) {
    return {
      ok: false,
      error: error("FORBIDDEN", userFacingMessage("FORBIDDEN"), 403),
    };
  }

  return {
    ok: true,
    site,
  };
}

function source(
  ref: string | null,
  u: { source?: string | null },
) {
  if (u.source) {
    return u.source.toLowerCase();
  }

  if (!ref) {
    return "direct";
  }

  try {
    const hostname = new URL(ref).hostname.replace(/^www\./, "");

    if (hostname.includes("google")) return "google";
    if (hostname.includes("youtube")) return "youtube";
    if (hostname.includes("discord")) return "discord";
    if (hostname.includes("telegram")) return "telegram";
    if (
      hostname.includes("twitter") ||
      hostname.includes("x.com")
    ) {
      return "twitter";
    }
    if (hostname.includes("instagram")) return "instagram";

    return "referral";
  } catch {
    return "referral";
  }
}

const tracking = t.Object({
  siteKey: t.String({
    minLength: 5,
    maxLength: 100,
  }),
  visitorId: t.String({
    minLength: 10,
    maxLength: 100,
  }),
  eventId: t.Optional(
    t.String({
      maxLength: 100,
    }),
  ),
  path: t.String({
    minLength: 1,
    maxLength: 2000,
  }),
  fullUrl: t.Optional(
    t.String({
      maxLength: 4000,
    }),
  ),
  referrer: t.Optional(
    t.Union([
      t.String({
        maxLength: 4000,
      }),
      t.Null(),
    ]),
  ),
  language: t.Optional(
    t.String({
      maxLength: 50,
    }),
  ),
  timezone: t.Optional(
    t.String({
      maxLength: 100,
    }),
  ),
  screenWidth: t.Optional(
    t.Integer({
      minimum: 0,
      maximum: 10000,
    }),
  ),
  screenHeight: t.Optional(
    t.Integer({
      minimum: 0,
      maximum: 10000,
    }),
  ),
  userAgent: t.Optional(
    t.String({
      maxLength: 1000,
    }),
  ),
  utm: t.Optional(
    t.Object({
      source: t.Optional(
        t.Union([
          t.String({
            maxLength: 200,
          }),
          t.Null(),
        ]),
      ),
      medium: t.Optional(
        t.Union([
          t.String({
            maxLength: 200,
          }),
          t.Null(),
        ]),
      ),
      campaign: t.Optional(
        t.Union([
          t.String({
            maxLength: 200,
          }),
          t.Null(),
        ]),
      ),
    }),
  ),
});

const app = new Elysia()
  .use(
    cors({
      origin: corsAllows,
      credentials: true,
    }),
  )
  .onBeforeHandle(async ({ request, set, server }) => {
    if (request.method !== "OPTIONS") {
      const path = new URL(request.url).pathname;
      const method = request.method;
      const policy = rateLimitPolicy(path, method);
      const ip = clientIp(request, server);

      const localPolicy =
        method === "POST" && path === "/api/v1/track"
          ? {
              scope: "analytics-ingestion",
              max: config.rateMax,
              windowSeconds: config.rateWindow,
            }
          : method === "POST" && path === "/api/v1/events"
            ? {
                scope: "analytics-ingestion",
                max: config.rateMax,
                windowSeconds: config.rateWindow,
              }
            : method === "GET" && path.startsWith("/api/v1/public/sites/")
              ? {
                  scope: "public-stats",
                  max: config.publicStatsRateMax,
                  windowSeconds: config.publicStatsRateWindow,
                }
              : null;

      if (policy) {
        if (
          !(await rateLimit(
            `${policy.scope}:${ip}`,
            policy.max,
            policy.windowSeconds,
          ))
        ) {
          set.status = 429;
          return error(
            "RATE_LIMITED",
            "Too many requests",
            429,
          );
        }
      }

      if (
        localPolicy &&
        !localRateLimit(
          `${localPolicy.scope}:${ip}`,
          localPolicy.max,
          localPolicy.windowSeconds,
        )
      ) {
        set.status = 429;
        return error(
          "RATE_LIMITED",
          "Too many requests",
          429,
        );
      }
    }
  })
  .onError(({ code, error: err, set, request }) => {
    logger.error("http.error", {
      code,
      message: err instanceof Error ? err.name : "request error",
    });

    set.status = code === "VALIDATION" ? 400 : 500;

    return {
      error: {
        code:
          code === "VALIDATION"
            ? "VALIDATION_ERROR"
            : "INTERNAL_ERROR",
        message:
          code === "VALIDATION"
            ? "Invalid request parameters"
            : config.nodeEnv === "production"
              ? "Something went wrong while processing your request."
              : err instanceof Error
                ? err.message
                : "Internal server error",
        status: set.status as number,
        requestId: requestId(request),
      },
    };
  });

app.onRequest(({ request, set }) => {
  set.headers["x-request-id"] = requestId(request);

  const origin = request.headers.get("origin");

  if (origin && corsAllows(request)) {
    set.headers["access-control-allow-origin"] = origin;
    set.headers["access-control-allow-credentials"] = "true";
    set.headers["vary"] = "Origin";
  }
});

app.onBeforeHandle(({ request }) => {
  if (
    config.nodeEnv !== "production" &&
    request.method === "GET" &&
    new URL(request.url).pathname === "/api/v1/auth/google"
  ) {
    logger.info("oauth.google_authorize", {
      redirectUri: config.googleRedirectUri,
    });
  }
});

app.onRequest(({ request, set }) => {
  const origin = request.headers.get("origin");

  if (origin && corsAllows(request)) {
    set.headers["access-control-allow-origin"] = origin;
    set.headers["access-control-allow-credentials"] = "true";
    set.headers["vary"] = "Origin";
  }
});

app.mapResponse(({ response, request, set }) => {
  if (response && typeof response === "object" && "error" in response) {
    const errObj = (response as any).error;
    const statusCode = errObj.status ?? set.status ?? 400;
    set.status = statusCode;
    
    return new Response(
      JSON.stringify({
        ...response,
        error: {
          ...errObj,
          requestId: requestId(request),
        },
      }),
      {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

app.onAfterHandle(({ request, set }) => {
  Object.assign(set.headers, securityHeaders, {
    "x-request-id": requestId(request),
  });

  if (
    new URL(request.url).pathname !== "/script.js" &&
    !set.headers["cache-control"]
  ) {
    set.headers["cache-control"] = "no-store";
  }
  logger.info("http.request", {
    route: new URL(request.url).pathname,
    status: set.status ?? 200,
    requestId: requestId(request),
  });
});

app.onBeforeHandle(({ request, set }) => {
  const method = request.method;
  const url = new URL(request.url);


  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    (url.pathname.startsWith("/api/v1/sites") ||
      url.pathname === "/api/v1/auth/logout")
  ) {
    const originHeader = request.headers.get("origin");
    const refererHeader = request.headers.get("referer");
    
    let originToVerify = originHeader;
    if (!originToVerify && refererHeader) {
      try {
        originToVerify = new URL(refererHeader).origin;
      } catch {}
    }

    if (!originToVerify) {
      set.status = 403;
      return error("CSRF_FAILED", userFacingMessage("CSRF_FAILED"), 403);
    }

    const isAllowed = corsOriginAllowed(originToVerify, url.pathname, {
      allowedOrigins: config.corsOrigins,
      nodeEnv: config.nodeEnv,
      allowLocalhostCorsInProduction: config.allowLocalhostCorsInProduction,
    });

    if (!isAllowed) {
      set.status = 403;
      return error("CSRF_FAILED", userFacingMessage("CSRF_FAILED"), 403);
    }
  }
});

app.get("/health", () => ({
  ok: true,
}));

app.get("/ready", async ({ set }) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();

    return {
      ok: true,
      status: "ready",
    };
  } catch {
    set.status = 503;
    return error("SERVICE_UNAVAILABLE", userFacingMessage("SERVICE_UNAVAILABLE"), 503);
  }
});

app.get(
  "/script.js",
  () =>
    new Response(Bun.file("tracking/script.js"), {
      headers: {
        "content-type":
          "application/javascript; charset=utf-8",
        "cache-control": "public,max-age=300",
      },
    }),
);

app.get("/api/v1/auth/google", ({ query, set }) => {
  if (!config.googleClientId) {
    set.status = 503;
    return error("AUTH_NOT_CONFIGURED", userFacingMessage("AUTH_NOT_CONFIGURED"), 503);
  }

  const configured = new URL(config.authSuccessRedirectUrl);
  const requested =
    typeof query.redirect === "string" &&
    query.redirect.startsWith("/dashboard")
      ? query.redirect
      : null;

  const redirectUrl = new URL(
    requested ?? "/dashboard",
    configured.origin,
  ).toString();

  const baseState = randomUUID() + randomUUID();
  const state =
    baseState + "___" + encodeURIComponent(redirectUrl);

  const u = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth",
  );

  u.searchParams.set("client_id", config.googleClientId);
  u.searchParams.set("redirect_uri", config.googleRedirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);

  logger.info("oauth.google_authorize", {
    redirectUri: config.googleRedirectUri,
    appRedirectOrigin: originOf(redirectUrl),
  });

  set.status = 302;
  set.headers = {
    location: u.toString(),
    "set-cookie":
      `oauth_state=${oauthStateHash(baseState)}; ` +
      `${authCookieAttrs}; Max-Age=600${secureCookieSuffix}`,
  };
});

app.get(
  "/api/v1/auth/google/callback",
  async ({ query, request, set }) => {
    const stateCookie = request.headers
      .get("cookie")
      ?.match(/(?:^|; )oauth_state=([^;]+)/)?.[1];

    if (!query.code || !query.state) {
      logger.warn("oauth.google_callback.invalid", {
        reason: "missing_code_or_state",
        hasStateCookie: Boolean(stateCookie),
      });

      set.status = 400;
      return error("OAUTH_STATE_INVALID", userFacingMessage("OAUTH_STATE_INVALID"), 400);
    }

    const [baseState, redirectEncoded] = (
      query.state as string
    ).split("___");

    if (
      !stateCookie ||
      stateCookie !== oauthStateHash(baseState)
    ) {
      logger.warn("oauth.google_callback.invalid", {
        reason: "state_mismatch",
        hasStateCookie: Boolean(stateCookie),
      });

      set.status = 400;
      return error("OAUTH_STATE_INVALID", userFacingMessage("OAUTH_STATE_INVALID"), 400);
    }

    const redirectUrl = resolveAuthRedirect(redirectEncoded);

    const body = new URLSearchParams({
      code: query.code as string,
      client_id: config.googleClientId,
      client_secret: Bun.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
    });

    const tok = (await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
        },
        body,
      },
    ).then((r) => r.json())) as {
      id_token?: string;
    };

    if (!tok.id_token) {
      logger.warn("oauth.google_callback.failed", {
        reason: "missing_id_token",
        redirectOrigin: originOf(redirectUrl),
      });

      set.status = 401;
      return error("OAUTH_FAILED", userFacingMessage("OAUTH_FAILED"), 401);
    }

    let c;

    try {
      c = (
        await jwtVerify(tok.id_token, googleKeys, {
          issuer: [
            "https://accounts.google.com",
            "accounts.google.com",
          ],
          audience: config.googleClientId,
        })
      ).payload;
    } catch {
      logger.warn("oauth.google_callback.failed", {
        reason: "invalid_identity",
        redirectOrigin: originOf(redirectUrl),
      });

      set.status = 401;
      return error("OAUTH_FAILED", userFacingMessage("OAUTH_FAILED"), 401);
    }

    if (
      typeof c.sub !== "string" ||
      typeof c.email !== "string"
    ) {
      logger.warn("oauth.google_callback.failed", {
        reason: "incomplete_identity",
        redirectOrigin: originOf(redirectUrl),
      });

      set.status = 401;
      return error("OAUTH_FAILED", userFacingMessage("OAUTH_FAILED"), 401);
    }

    const u = await prisma.user.upsert({
      where: {
        googleId: c.sub,
      },
      create: {
        googleId: c.sub,
        email: c.email,
        name: typeof c.name === "string" ? c.name : c.email,
        avatarUrl:
          typeof c.picture === "string" ? c.picture : null,
      },
      update: {
        email: c.email,
        name: typeof c.name === "string" ? c.name : c.email,
        avatarUrl:
          typeof c.picture === "string" ? c.picture : null,
      },
    });

    const raw = randomUUID() + randomUUID();
    const expiresAt = new Date(
      Date.now() + config.sessionTtl * 1000,
    );

    await prisma.authSession.create({
      data: {
        tokenHash: tokenHash(raw),
        userId: u.id,
        expiresAt,
      },
    });

    logger.info("oauth.google_callback.success", {
      redirectOrigin: originOf(redirectUrl),
      sessionExpiresAt: expiresAt.toISOString(),
    });

    set.status = 302;
    set.headers = {
      "set-cookie":
        `analytics_session=${raw}; ${authCookieAttrs}; ` +
        `Max-Age=${config.sessionTtl}${secureCookieSuffix}`,
      location: redirectUrl,
    };
  },
);

app.post(
  "/api/v1/auth/logout",
  async ({ request, set }) => {
    const raw = request.headers
      .get("cookie")
      ?.match(/analytics_session=([^;]+)/)?.[1];

    if (raw) {
      await prisma.authSession.deleteMany({
        where: {
          tokenHash: tokenHash(raw),
        },
      });
    }

    set.headers = {
      "set-cookie":
        `analytics_session=; ${authCookieAttrs}; ` +
        `Max-Age=0${secureCookieSuffix}`,
    };

    return {
      ok: true,
    };
  },
);

app.get(
  "/api/v1/auth/me",
  async ({ request, set }) => {
    const u = await currentUser(request);

    if (!u) {
      set.status = 401;
      return error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401);
    }

    return {
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
    };
  },
);

app.post(
  "/api/v1/sites",
  async ({ request, body, set }) => {
    const u = await currentUser(request);

    if (!u) {
      set.status = 401;
      return error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401);
    }

    if (!domainOk(body.domain)) {
      set.status = 400;
      return error("INVALID_DOMAIN", userFacingMessage("INVALID_DOMAIN"), 400);
    }

    set.status = 201;

    return prisma.site.create({
      data: {
        userId: u.id,
        name: body.name.trim(),
        domain: normalizeDomain(body.domain),
        siteKey: newKey(),
      },
    });
  },
  {
    body: t.Object({
      name: t.String({
        minLength: 1,
        maxLength: 120,
      }),
      domain: t.String({
        minLength: 3,
        maxLength: 255,
      }),
    }),
  },
);

app.get(
  "/api/v1/sites",
  async ({ request, set }) => {
    const u = await currentUser(request);

    if (!u) {
      set.status = 401;

      return error(
        "UNAUTHENTICATED",
        "Authentication required",
        401,
      );
    }

    return prisma.site.findMany({
      where: {
        userId: u.id,
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  },
);

app.get(
  "/api/v1/sites/:id",
  async ({ request, params, set }) => {
    const u = await currentUser(request);
    const s = await prisma.site.findUnique({
      where: {
        id: params.id,
      },
    });

    if (!u) {
      set.status = 401;
      return error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401);
    }

    if (!s) {
      set.status = 404;
      return error("NOT_FOUND", "Website not found. It may have been deleted.", 404);
    }

    if (s.userId !== u.id) {
      set.status = 403;
      return error("FORBIDDEN", userFacingMessage("FORBIDDEN"), 403);
    }

    return s;
  },
);

app.patch(
  "/api/v1/sites/:id",
  async ({ request, params, body, set }) => {
    const u = await currentUser(request);
    const s = await prisma.site.findUnique({
      where: {
        id: params.id,
      },
    });

    if (!u) {
      set.status = 401;
      return error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401);
    }

    if (!s) {
      set.status = 404;
      return error("NOT_FOUND", "Website not found. It may have been deleted.", 404);
    }

    if (s.userId !== u.id) {
      set.status = 403;
      return error("FORBIDDEN", userFacingMessage("FORBIDDEN"), 403);
    }

    if (body.domain && !domainOk(body.domain)) {
      set.status = 400;
      return error("INVALID_DOMAIN", userFacingMessage("INVALID_DOMAIN"), 400);
    }

    return prisma.site.update({
      where: {
        id: s.id,
      },
      data: {
        name: body.name?.trim(),
        domain: body.domain
          ? normalizeDomain(body.domain)
          : undefined,
      },
    });
  },
  {
    body: t.Object({
      name: t.Optional(
        t.String({
          minLength: 1,
          maxLength: 120,
        }),
      ),
      domain: t.Optional(
        t.String({
          minLength: 3,
          maxLength: 255,
        }),
      ),
    }),
  },
);

app.delete(
  "/api/v1/sites/:id",
  async ({ request, params, set }) => {
    const u = await currentUser(request);
    const s = await prisma.site.findUnique({
      where: {
        id: params.id,
      },
    });

    if (!u) {
      set.status = 401;
      return error("UNAUTHENTICATED", userFacingMessage("UNAUTHENTICATED"), 401);
    }

    if (!s) {
      set.status = 404;
      return error("NOT_FOUND", "Website not found. It may have been deleted.", 404);
    }

    if (s.userId !== u.id) {
      set.status = 403;
      return error("FORBIDDEN", userFacingMessage("FORBIDDEN"), 403);
    }

    await prisma.site.delete({
      where: {
        id: s.id,
      },
    });

    return {
      ok: true,
    };
  },
);

app.post(
  "/api/v1/track",
  async ({ body, request }) => {
    const site = await prisma.site.findUnique({
      where: {
        siteKey: body.siteKey,
      },
    });

    if (!site) {
      return { ok: true };
    }

    const vh = hash(body.visitorId);
    const now = new Date();
    const ua = request.headers.get("user-agent") ?? "";
    const p = parseUserAgent(ua);
    const ip = hash(clientIp(request));
    const ref = body.referrer ?? null;
    const utm = body.utm ?? {};
    const src = source(ref, utm);

    const old = await prisma.visitor.findUnique({
      where: {
        siteId_visitorIdHash: {
          siteId: site.id,
          visitorIdHash: vh,
        },
      },
    });

    await prisma.visitor.upsert({
      where: {
        siteId_visitorIdHash: {
          siteId: site.id,
          visitorIdHash: vh,
        },
      },
      create: {
        siteId: site.id,
        visitorIdHash: vh,
        firstSeenAt: now,
        lastSeenAt: now,
        firstIpHash: ip,
        lastIpHash: ip,
        userAgentHash: hash(ua),
      },
      update: {
        lastSeenAt: now,
        lastIpHash: ip,
      },
    });

    let session = await prisma.session.findFirst({
      where: {
        siteId: site.id,
        visitorIdHash: vh,
        lastActivityAt: {
          gte: new Date(
            now.getTime() - config.sessionTimeoutMs,
          ),
        },
        endedAt: null,
      },
      orderBy: {
        lastActivityAt: "desc",
      },
    });

    if (!session) {
      session = await prisma.session.create({
        data: {
          siteId: site.id,
          visitorIdHash: vh,
          startedAt: now,
          lastActivityAt: now,
          entryPath: body.path,
          referrer: ref,
          source: src,
          medium: utm.medium ?? null,
          campaign: utm.campaign ?? null,
        },
      });

      if (old) {
        await prisma.visitor.update({
          where: {
            siteId_visitorIdHash: {
              siteId: site.id,
              visitorIdHash: vh,
            },
          },
          data: {
            visitCount: {
              increment: 1,
            },
          },
        });
      }
    }

    try {
      await prisma.$transaction([
        prisma.pageView.create({
          data: {
            eventId: body.eventId ?? randomUUID(),
            siteId: site.id,
            visitorIdHash: vh,
            sessionId: session.id,
            path: body.path,
            fullUrl: body.fullUrl ?? null,
            referrer: ref,
            source: src,
            medium: utm.medium ?? null,
            campaign: utm.campaign ?? null,
            ...p,
            language: body.language ?? null,
            timezone: body.timezone ?? null,
            screenWidth: body.screenWidth ?? null,
            screenHeight: body.screenHeight ?? null,
          },
        }),
        prisma.session.update({
          where: {
            id: session.id,
          },
          data: {
            lastActivityAt: now,
            pageCount: {
              increment: 1,
            },
            exitPath: body.path,
          },
        }),
      ]);
    } catch (e) {
      if (
        !(e instanceof Error) ||
        !e.message.includes("Unique constraint")
      ) {
        throw e;
      }
    }

    return {
      ok: true,
    };
  },
  {
    body: tracking,
  },
);

const eventBody = t.Object({
  siteKey: t.String({
    minLength: 5,
    maxLength: 100,
  }),
  visitorId: t.String({
    minLength: 10,
    maxLength: 100,
  }),
  name: t.String({
    minLength: 1,
    maxLength: 100,
    pattern: "^[A-Za-z0-9_.:-]+$",
  }),
  properties: t.Optional(
    t.Record(
      t.String({
        maxLength: 50,
      }),
      t.Union([
        t.String({
          maxLength: 500,
        }),
        t.Number(),
        t.Boolean(),
        t.Null(),
      ]),
      {
        maxProperties: 20,
      },
    ),
  ),
});

app.post(
  "/api/v1/events",
  async ({ body, request, set }) => {
    const site = await prisma.site.findUnique({
      where: {
        siteKey: body.siteKey,
      },
    });

    if (!site) {
      return { ok: true };
    }

    const visitorIdHash = hash(body.visitorId);

    const session = await prisma.session.findFirst({
      where: {
        siteId: site.id,
        visitorIdHash,
        endedAt: null,
        lastActivityAt: {
          gte: new Date(
            Date.now() - config.sessionTimeoutMs,
          ),
        },
      },
      orderBy: {
        lastActivityAt: "desc",
      },
    });

    await prisma.event.create({
      data: {
        eventId: randomUUID(),
        siteId: site.id,
        visitorIdHash,
        sessionId: session?.id ?? null,
        name: body.name,
        properties: body.properties ?? {},
      },
    });

    return {
      ok: true,
    };
  },
  {
    body: eventBody,
  },
);

app.get(
  "/api/v1/public/sites/:siteKey/visitor-count",
  async ({ params, set }) => {
    const counts = await getPublicVisitorCount(
      params.siteKey,
    );

    if (!counts) {
      set.status = 404;
      return error("NOT_FOUND", "Website not found. It may have been deleted.", 404);
    }

    set.headers["cache-control"] = "no-cache";

    return counts;
  },
  {
    params: t.Object({
      siteKey: t.String({
        minLength: 5,
        maxLength: 100,
      }),
    }),
  },
);

app.get(
  "/api/v1/stats",
  async ({ request, query, set }) => {
    const o = await siteFor(request, query.siteKey);

    if (!o.ok) {
      set.status = o.error.error.status;
      return o.error;
    }

    const days =
      query.range === "30d"
        ? 30
        : query.range === "7d"
          ? 7
          : 1;

    const since = new Date(
      Date.now() - days * 86400000,
    );

    const where = {
      siteId: o.site.id,
      createdAt: {
        gte: since,
      },
    };

    const [
      views,
      uniqueRows,
      sessions,
      newVisitors,
      returningVisitors,
    ] = await Promise.all([
      prisma.pageView.count({
        where,
      }),

      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "visitorIdHash")::bigint AS count
        FROM "PageView"
        WHERE "siteId" = ${o.site.id}
          AND "createdAt" >= ${since}
      `,

      prisma.session.count({
        where: {
          siteId: o.site.id,
          startedAt: {
            gte: since,
          },
        },
      }),

      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT pv."visitorIdHash")::bigint AS count
        FROM "PageView" pv
        JOIN "Visitor" v
          ON v."siteId" = pv."siteId"
          AND v."visitorIdHash" = pv."visitorIdHash"
        WHERE pv."siteId" = ${o.site.id}
          AND pv."createdAt" >= ${since}
          AND v."firstSeenAt" >= ${since}
      `,

      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT pv."visitorIdHash")::bigint AS count
        FROM "PageView" pv
        JOIN "Visitor" v
          ON v."siteId" = pv."siteId"
          AND v."visitorIdHash" = pv."visitorIdHash"
        WHERE pv."siteId" = ${o.site.id}
          AND pv."createdAt" >= ${since}
          AND v."firstSeenAt" < ${since}
      `,

    ]);

    const uniqueVisitors = Number(
      uniqueRows[0]?.count ?? 0,
    );
    const newCount = Number(
      newVisitors[0]?.count ?? 0,
    );
    const returningCount = Number(
      returningVisitors[0]?.count ?? 0,
    );

    return {
      totalViews: views,
      uniqueVisitors,
      newVisitors: newCount,
      returningVisitors: returningCount,
      sessions,
    };
  },
  {
    query: t.Object({
      siteKey: t.String(),
      range: t.Optional(
        t.Union([
          t.Literal("24h"),
          t.Literal("7d"),
          t.Literal("30d"),
        ]),
      ),
    }),
  },
);

app.get(
  "/api/v1/stats/pages",
  async ({ request, query, set }) => {
    const o = await siteFor(request, query.siteKey);

    if (!o.ok) {
      set.status = o.error.error.status;
      return o.error;
    }

    const days =
      query.range === "30d"
        ? 30
        : query.range === "7d"
          ? 7
          : 1;

    const since = new Date(
      Date.now() - days * 86400000,
    );

    const rows = await prisma.$queryRaw<
      Array<{
        path: string;
        views: bigint;
        uniqueVisitors: bigint;
      }>
    >`
      SELECT
        "path",
        COUNT(*)::bigint AS views,
        COUNT(DISTINCT "visitorIdHash")::bigint AS "uniqueVisitors"
      FROM "PageView"
      WHERE "siteId" = ${o.site.id}
        AND "createdAt" >= ${since}
      GROUP BY "path"
      ORDER BY views DESC
      LIMIT 100
    `;

    return rows.map(
      (row: {
        path: any;
        views: any;
        uniqueVisitors: any;
      }) => ({
        path: row.path,
        views: Number(row.views),
        uniqueVisitors: Number(row.uniqueVisitors),
      }),
    );
  },
  {
    query: t.Object({
      siteKey: t.String(),
      range: t.Optional(
        t.Union([
          t.Literal("24h"),
          t.Literal("7d"),
          t.Literal("30d"),
        ]),
      ),
    }),
  },
);

export { app };
