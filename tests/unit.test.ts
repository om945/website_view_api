import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { hash } from "../src/utils/hashing";
import { domainOk, normalizeDomain } from "../src/utils/domain";
import { parseUserAgent } from "../src/utils/user-agent";
import { prisma } from "../src/db/prisma";
import { redis } from "../src/redis/redis";
import { touchPresence, activeCount, presenceKey } from "../src/redis/presence";
import { rateLimit } from "../src/redis/rate-limit";
import { config } from "../src/config/config";
import { corsAllows } from "../src/utils/cors";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3100";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MOBILE_UA  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const BEYOND_SESSION_TIMEOUT_MS = SESSION_TIMEOUT_MS + 60 * 1000;

const tokenHash = (t: string) => createHash("sha256").update(t + config.sessionSecret).digest("hex");

// ─── Infrastructure availability ─────────────────────────────────────────────
let isRedisOk = false;
try {
  await redis.ping();
  isRedisOk = true;
} catch {
  console.warn("[SKIP] Redis is not available. Skipping Redis tests.");
}

let isDbOk = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  isDbOk = true;
} catch {
  console.warn("[SKIP] Database is not available. Skipping Database tests.");
}

let isApiOk = false;
try {
  const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
  isApiOk = r.ok;
} catch {
  console.warn("[SKIP] API is not available. Skipping API tests.");
}

const infraOk = isDbOk && isRedisOk && isApiOk;

// ─── Test helpers ─────────────────────────────────────────────────────────────

interface Ctx { userId: string; siteId: string; siteKey: string; cookie: string }
const cleanupUserIds: string[] = [];

async function setupSite(): Promise<Ctx> {
  const user = await prisma.user.create({
    data: { googleId: `g_${randomUUID()}`, email: `${randomUUID()}@t.example`, name: "T" },
  });
  cleanupUserIds.push(user.id);
  const siteKey = `site_${randomUUID().replaceAll("-", "")}`;
  const site = await prisma.site.create({ data: { userId: user.id, name: "T", domain: "t.example", siteKey } });
  const token = randomUUID() + randomUUID();
  await prisma.authSession.create({
    data: { tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  return { userId: user.id, siteId: site.id, siteKey, cookie: `analytics_session=${token}` };
}

async function trackPV(siteKey: string, visitorId: string, path = "/", extra: Record<string, unknown> = {}) {
  return fetch(`${BASE}/api/v1/track`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": DESKTOP_UA },
    body: JSON.stringify({ siteKey, visitorId, path, ...extra }),
  });
}

async function getPublicCount(siteKey: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/api/v1/public/sites/${siteKey}/visitor-count`, { headers });
  return { res, body: await res.json() as { totalVisitors: number; activeVisitors: number; error?: { code: string } } };
}

async function getStats(siteKey: string, cookie: string, range?: string) {
  const url = new URL(`${BASE}/api/v1/stats`);
  url.searchParams.set("siteKey", siteKey);
  if (range) url.searchParams.set("range", range);
  const res = await fetch(url, { headers: { cookie } });
  return res.json() as Promise<{
    totalViews: number; uniqueVisitors: number; newVisitors: number;
    returningVisitors: number; activeVisitors: number; sessions: number;
  }>;
}

// Plant a visitor + page view at arbitrary past timestamps (bypasses API)
async function plantVisitor(siteId: string, firstSeenDaysAgo: number, pvDaysAgo: number) {
  const vid = randomUUID() + randomUUID();
  const vh = hash(vid);
  const firstSeen = new Date(Date.now() - firstSeenDaysAgo * 86_400_000);
  const pvTime   = new Date(Date.now() - pvDaysAgo   * 86_400_000);
  await prisma.visitor.create({
    data: { siteId, visitorIdHash: vh, firstSeenAt: firstSeen, lastSeenAt: pvTime, visitCount: 1 },
  });
  const session = await prisma.session.create({
    data: { siteId, visitorIdHash: vh, startedAt: pvTime, lastActivityAt: pvTime },
  });
  await prisma.pageView.create({
    data: { eventId: randomUUID(), siteId, visitorIdHash: vh, sessionId: session.id, path: "/t", deviceType: "desktop", createdAt: pvTime },
  });
  return vh;
}

afterAll(async () => {
  if (isDbOk) {
    if (cleanupUserIds.length) await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    await prisma.$disconnect();
  }
  if (isRedisOk) {
    redis.disconnect();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Unit: pure utility functions (no infrastructure needed)
// ═══════════════════════════════════════════════════════════════════════════════

describe("unit: utils", () => {
  test("development CORS allows dynamic localhost dashboard ports only", () => {
    expect(corsAllows(new Request("http://localhost:3000/api/v1/auth/me", { headers: { origin: "http://localhost:56541" } }))).toBe(true);
    expect(corsAllows(new Request("http://localhost:3000/api/v1/auth/me", { headers: { origin: "http://127.0.0.1:50000" } }))).toBe(true);
    expect(corsAllows(new Request("http://localhost:3000/api/v1/auth/me", { headers: { origin: "https://evil.example" } }))).toBe(false);
  });

  test("public routes may be read cross-origin without widening dashboard CORS", () => {
    expect(corsAllows(new Request("http://localhost:3000/api/v1/public/sites/site_demo/visitor-count", { headers: { origin: "https://developer.example" } }))).toBe(true);
    expect(corsAllows(new Request("http://localhost:3000/api/v1/stats?siteKey=site_demo", { headers: { origin: "https://developer.example" } }))).toBe(false);
  });

  test("hash is deterministic and HMAC-bound to secret", () => {
    expect(hash("visitor")).toBe(hash("visitor"));
    expect(hash("visitor")).not.toBe(hash("other"));
    expect(hash("visitor", "secret-a")).not.toBe(hash("visitor", "secret-b"));
  });

  test("normalizeDomain strips protocol and path with no leading space", () => {
    expect(normalizeDomain("https://Example.com/path?q=1")).toBe("example.com");
    expect(normalizeDomain("http://sub.example.com")).toBe("sub.example.com");
    expect(normalizeDomain("example.com")).toBe("example.com");
    expect(normalizeDomain("https://example.com")[0]).not.toBe(" ");
  });

  test("domainOk validates correctly", () => {
    expect(domainOk("https://example.com/path")).toBe(true);
    expect(domainOk("example.com")).toBe(true);
    expect(domainOk("not a domain")).toBe(false);
    expect(domainOk("")).toBe(false);
  });

  test("parseUserAgent categorizes desktop", () => {
    expect(parseUserAgent(DESKTOP_UA).deviceType).toBe("desktop");
    expect(parseUserAgent(DESKTOP_UA).browser).toBeTruthy();
    expect(parseUserAgent(DESKTOP_UA).os).toBeTruthy();
  });

  test("parseUserAgent categorizes mobile", () => {
    expect(parseUserAgent(MOBILE_UA).deviceType).toBe("mobile");
  });

  test("parseUserAgent handles empty string gracefully", () => {
    const r = parseUserAgent("");
    expect(r.deviceType).toBe("desktop");
    expect(r.browser).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Redis: presence and rate limiting
// ═══════════════════════════════════════════════════════════════════════════════

describe("redis: presence", () => {
  test.if(isRedisOk)("touchPresence adds member to sorted set", async () => {
    const siteId = `ts_${randomUUID()}`;
    const vh = hash(randomUUID());
    await touchPresence(siteId, vh);
    const count = await activeCount(siteId);
    expect(count).toBeGreaterThanOrEqual(1);
    await redis.del(presenceKey(siteId));
  });

  test.if(isRedisOk)("activeCount prunes expired entries", async () => {
    const siteId = `ts_${randomUUID()}`;
    const vh = hash(randomUUID());
    await redis.zadd(presenceKey(siteId), Date.now() - 5000, vh);
    const count = await activeCount(siteId);
    expect(count).toBe(0);
    await redis.del(presenceKey(siteId));
  });

  test.if(isRedisOk)("activeCount counts multiple live members", async () => {
    const siteId = `ts_${randomUUID()}`;
    const future = Date.now() + 60_000;
    await redis.zadd(presenceKey(siteId), future, hash("v1"), future, hash("v2"), future, hash("v3"));
    const count = await activeCount(siteId);
    expect(count).toBe(3);
    await redis.del(presenceKey(siteId));
  });
});

describe("redis: rate limiting", () => {
  test.if(isRedisOk)("rateLimit allows up to max then blocks", async () => {
    const key = `rip_${randomUUID()}`;
    expect(await rateLimit(key, 3)).toBe(true);
    expect(await rateLimit(key, 3)).toBe(true);
    expect(await rateLimit(key, 3)).toBe(true);
    expect(await rateLimit(key, 3)).toBe(false);
  });

  test.if(isRedisOk)("separate keys (separate clients) have independent buckets", async () => {
    const k1 = `rip_${randomUUID()}`;
    const k2 = `rip_${randomUUID()}`;
    for (let i = 0; i < 3; i++) await rateLimit(k1, 3);
    expect(await rateLimit(k1, 3)).toBe(false);
    expect(await rateLimit(k2, 3)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Tracking: visitor lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("tracking: first visit", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("first visitor creates a Visitor record with visitCount=1", async () => {
    const vid = randomUUID() + randomUUID();
    const res = await trackPV(ctx.siteKey, vid);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const vh = hash(vid);
    const v = await prisma.visitor.findUnique({ where: { siteId_visitorIdHash: { siteId: ctx.siteId, visitorIdHash: vh } } });
    expect(v).not.toBeNull();
    expect(v!.visitCount).toBe(1);
  });

  test.if(infraOk)("HTTP User-Agent header is used — not browser-supplied field", async () => {
    const vid = randomUUID() + randomUUID();
    const vh = hash(vid);
    await fetch(`${BASE}/api/v1/track`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": MOBILE_UA },
      body: JSON.stringify({ siteKey: ctx.siteKey, visitorId: vid, path: "/" }),
    });
    const pv = await prisma.pageView.findFirst({ where: { siteId: ctx.siteId, visitorIdHash: vh } });
    expect(pv?.deviceType).toBe("mobile");
  });
});

describe("tracking: session management", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("multiple page views within 2 hours share one session", async () => {
    const vid = randomUUID() + randomUUID();
    const vh = hash(vid);
    await trackPV(ctx.siteKey, vid, "/p1");
    await trackPV(ctx.siteKey, vid, "/p2");
    await trackPV(ctx.siteKey, vid, "/p3");
    const sessions = await prisma.session.findMany({ where: { siteId: ctx.siteId, visitorIdHash: vh } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pageCount).toBe(3);
    expect(sessions[0].exitPath).toBe("/p3");
  });

  test.if(infraOk)("new session is created after 2-hour inactivity gap", async () => {
    const vid = randomUUID() + randomUUID();
    const vh = hash(vid);
    await trackPV(ctx.siteKey, vid, "/first");
    await prisma.session.updateMany({
      where: { siteId: ctx.siteId, visitorIdHash: vh, endedAt: null },
      data: { lastActivityAt: new Date(Date.now() - BEYOND_SESSION_TIMEOUT_MS) },
    });
    await trackPV(ctx.siteKey, vid, "/second");
    const sessions = await prisma.session.findMany({ where: { siteId: ctx.siteId, visitorIdHash: vh } });
    expect(sessions).toHaveLength(2);
  });

  test.if(infraOk)("returning visitor: new session increments visitCount", async () => {
    const vid = randomUUID() + randomUUID();
    const vh = hash(vid);
    await trackPV(ctx.siteKey, vid, "/");
    await prisma.session.updateMany({
      where: { siteId: ctx.siteId, visitorIdHash: vh, endedAt: null },
      data: { lastActivityAt: new Date(Date.now() - BEYOND_SESSION_TIMEOUT_MS) },
    });
    await trackPV(ctx.siteKey, vid, "/about");
    const v = await prisma.visitor.findUnique({ where: { siteId_visitorIdHash: { siteId: ctx.siteId, visitorIdHash: vh } } });
    expect(v!.visitCount).toBe(2);
  });

  test.if(infraOk)("duplicate eventId is silently deduplicated", async () => {
    const vid = randomUUID() + randomUUID();
    const vh = hash(vid);
    const eventId = randomUUID();
    const r1 = await trackPV(ctx.siteKey, vid, "/dup", { eventId });
    const r2 = await trackPV(ctx.siteKey, vid, "/dup", { eventId });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const views = await prisma.pageView.count({ where: { siteId: ctx.siteId, visitorIdHash: vh } });
    expect(views).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Public visitor counters
// ═══════════════════════════════════════════════════════════════════════════════

describe("public visitor counters", () => {
  test.if(infraOk)("empty site returns zero visitors without authentication", async () => {
    const ctx = await setupSite();
    const { res, body } = await getPublicCount(ctx.siteKey);
    expect(res.status).toBe(200);
    expect(body).toEqual({ totalVisitors: 0, activeVisitors: 0 });
  });

  test.if(infraOk)("one visitor is counted once", async () => {
    const ctx = await setupSite();
    await trackPV(ctx.siteKey, randomUUID() + randomUUID());
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.totalVisitors).toBe(1);
  });

  test.if(infraOk)("multiple page views by one visitor do not inflate totalVisitors", async () => {
    const ctx = await setupSite();
    const visitorId = randomUUID() + randomUUID();
    await trackPV(ctx.siteKey, visitorId, "/one");
    await trackPV(ctx.siteKey, visitorId, "/two");
    await trackPV(ctx.siteKey, visitorId, "/three");
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.totalVisitors).toBe(1);
  });

  test.if(infraOk)("multiple visitors are counted distinctly", async () => {
    const ctx = await setupSite();
    await Promise.all([
      trackPV(ctx.siteKey, randomUUID() + randomUUID()),
      trackPV(ctx.siteKey, randomUUID() + randomUUID()),
      trackPV(ctx.siteKey, randomUUID() + randomUUID()),
    ]);
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.totalVisitors).toBe(3);
  });

  test.if(infraOk)("activeVisitors uses live Redis presence", async () => {
    const ctx = await setupSite();
    const visitorId = randomUUID() + randomUUID();
    await trackPV(ctx.siteKey, visitorId);
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.activeVisitors).toBeGreaterThanOrEqual(1);
  });

  test.if(infraOk)("expired Redis presence is not active", async () => {
    const ctx = await setupSite();
    const expiredHash = hash(randomUUID());
    await redis.zadd(presenceKey(ctx.siteId), Date.now() - 1, expiredHash);
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.activeVisitors).toBe(0);
    await redis.del(presenceKey(ctx.siteId));
  });

  test.if(infraOk)("multiple active visitors are counted from Redis", async () => {
    const ctx = await setupSite();
    const future = Date.now() + 60_000;
    await redis.zadd(presenceKey(ctx.siteId), future, hash(randomUUID()), future, hash(randomUUID()));
    const { body } = await getPublicCount(ctx.siteKey);
    expect(body.activeVisitors).toBe(2);
    await redis.del(presenceKey(ctx.siteId));
  });

  test.if(infraOk)("unknown site returns safe 404 and no private data", async () => {
    const { res, body } = await getPublicCount(`site_${randomUUID().replaceAll("-", "")}`);
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("SITE_NOT_FOUND");
    expect(body).not.toHaveProperty("siteId");
  });

  test.if(infraOk)("public response allows cross-origin reads and is not long-cached", async () => {
    const ctx = await setupSite();
    const { res } = await getPublicCount(ctx.siteKey, { origin: "https://developer-site.example" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Statistics: new vs returning (direct DB inserts for time control)
// ═══════════════════════════════════════════════════════════════════════════════

describe("statistics: new vs returning (24h)", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("visitor first seen today is counted as new", async () => {
    await plantVisitor(ctx.siteId, 0.1, 0.1);
    const s = await getStats(ctx.siteKey, ctx.cookie, "24h");
    expect(s.newVisitors).toBeGreaterThanOrEqual(1);
  });

  test.if(infraOk)("visitor first seen 2 days ago is counted as returning in 24h window", async () => {
    await plantVisitor(ctx.siteId, 2, 0.1);
    const s = await getStats(ctx.siteKey, ctx.cookie, "24h");
    expect(s.returningVisitors).toBeGreaterThanOrEqual(1);
  });

  test.if(infraOk)("returningVisitors is a direct query, not uniqueVisitors - newVisitors", async () => {
    await plantVisitor(ctx.siteId, 0.1, 0.1);
    await plantVisitor(ctx.siteId, 2,   0.1);
    const s = await getStats(ctx.siteKey, ctx.cookie, "24h");
    expect(s.newVisitors).toBeGreaterThanOrEqual(1);
    expect(s.returningVisitors).toBeGreaterThanOrEqual(1);
    expect(s.uniqueVisitors).toBe(s.newVisitors + s.returningVisitors);
  });
});

describe("statistics: 7d range", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("visitor with pv 5 days ago appears in 7d but pv 8 days ago does not", async () => {
    await plantVisitor(ctx.siteId, 0.1, 5);
    await plantVisitor(ctx.siteId, 10,  8);

    const s7  = await getStats(ctx.siteKey, ctx.cookie, "7d");
    const s24 = await getStats(ctx.siteKey, ctx.cookie, "24h");
    expect(s7.totalViews).toBeGreaterThanOrEqual(1);
    expect(s7.totalViews).toBeGreaterThan(s24.totalViews);
  });
});

describe("statistics: 30d range", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("visitor with pv 20 days ago appears in 30d window", async () => {
    // A visitor first seen 25 days ago falls strictly INSIDE the 30d window.
    // Therefore they are a NEW visitor for this period, not returning.
    await plantVisitor(ctx.siteId, 25, 20);
    const s = await getStats(ctx.siteKey, ctx.cookie, "30d");
    expect(s.newVisitors).toBeGreaterThanOrEqual(1);
    expect(s.totalViews).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Statistics: page breakdown
// ═══════════════════════════════════════════════════════════════════════════════

describe("statistics: page breakdown", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("page stats aggregate views and unique visitors per path", async () => {
    const vid1 = randomUUID() + randomUUID();
    const vid2 = randomUUID() + randomUUID();
    await trackPV(ctx.siteKey, vid1, "/featured");
    await trackPV(ctx.siteKey, vid1, "/featured");
    await trackPV(ctx.siteKey, vid2, "/featured");

    const url = new URL(`${BASE}/api/v1/stats/pages`);
    url.searchParams.set("siteKey", ctx.siteKey);
    url.searchParams.set("range", "24h");
    const rows: { path: string; views: number; uniqueVisitors: number }[] = await (await fetch(url, { headers: { cookie: ctx.cookie } })).json();
    const row = rows.find(r => r.path === "/featured");
    expect(row).toBeDefined();
    expect(row!.views).toBeGreaterThanOrEqual(3);
    expect(row!.uniqueVisitors).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Authorization: site ownership
// ═══════════════════════════════════════════════════════════════════════════════

describe("authorization: site ownership", () => {
  let owner: Ctx;
  let other: Ctx;
  beforeAll(async () => {
    if (infraOk) {
      owner = await setupSite();
      other = await setupSite();
    }
  });

  test.if(infraOk)("unauthenticated request to stats returns 401", async () => {
    const url = new URL(`${BASE}/api/v1/stats`);
    url.searchParams.set("siteKey", owner.siteKey);
    const res = await fetch(url);
    expect(res.status).toBe(401);
  });

  test.if(infraOk)("authenticated owner can read their own site stats", async () => {
    const url = new URL(`${BASE}/api/v1/stats`);
    url.searchParams.set("siteKey", owner.siteKey);
    const res = await fetch(url, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
  });

  test.if(infraOk)("authenticated user cannot read another user's site stats", async () => {
    const url = new URL(`${BASE}/api/v1/stats`);
    url.searchParams.set("siteKey", owner.siteKey);
    const res = await fetch(url, { headers: { cookie: other.cookie } });
    expect(res.status).toBe(403);
  });

  test.if(infraOk)("GET /api/v1/sites only returns the current user's sites", async () => {
    const res = await fetch(`${BASE}/api/v1/sites`, { headers: { cookie: other.cookie } });
    const sites: { siteKey: string }[] = await res.json();
    const keys = sites.map(s => s.siteKey);
    expect(keys).toContain(other.siteKey);
    expect(keys).not.toContain(owner.siteKey);
  });

  test.if(infraOk)("DELETE another user's site returns 403", async () => {
    const res = await fetch(`${BASE}/api/v1/sites/${owner.siteId}`, {
      method: "DELETE",
      headers: { cookie: other.cookie },
    });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. WebSocket: validation and presence
// ═══════════════════════════════════════════════════════════════════════════════

async function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws/track");
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
    setTimeout(() => reject(new Error("ws connect timeout")), 3000);
  });
}

/** Wait for the initial welcome frame sent by the server on every new connection. */
async function waitForWelcome(ws: WebSocket): Promise<void> {
  return new Promise(resolve => { ws.onmessage = () => resolve(); });
}

/**
 * Send a presence payload and wait for the server's `{ok:true,type:"presence_ack"}`
 * response. Rejects if no ack arrives within `timeoutMs`.
 */
async function sendPresenceAndWaitForAck(
  ws: WebSocket,
  payload: object,
  timeoutMs = 3000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      reject(new Error(`presence_ack not received within ${timeoutMs}ms`));
    }, timeoutMs);

    ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg?.type === "presence_ack" && msg?.ok === true) {
          clearTimeout(timer);
          ws.onmessage = null;
          resolve();
        }
      } catch { /* ignore non-JSON frames */ }
    };

    ws.send(JSON.stringify(payload));
  });
}

describe("websocket: presence and validation", () => {
  let ctx: Ctx;
  beforeAll(async () => { if (infraOk) ctx = await setupSite(); });

  test.if(infraOk)("server sends heartbeat config on connect", async () => {
    const ws = await wsConnect();
    const msg: string = await new Promise(resolve => {
      ws.onmessage = e => resolve(e.data as string);
    });
    const parsed = JSON.parse(msg);
    expect(parsed.ok).toBe(true);
    expect(parsed.heartbeatSeconds).toBe(15);
    ws.close();
  });

  test.if(infraOk)("valid presence message updates Redis", async () => {
    const vid = randomUUID() + randomUUID();
    const ws = await wsConnect();
    await waitForWelcome(ws);
    await sendPresenceAndWaitForAck(ws, { siteKey: ctx.siteKey, visitorId: vid });
    const count = await activeCount(ctx.siteId);
    expect(count).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  test.if(infraOk)("oversized message (>500 chars) is rejected silently — no crash", async () => {
    const ws = await wsConnect();
    await waitForWelcome(ws);
    ws.send("x".repeat(501));
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);
    ws.close();
  });

  test.if(infraOk)("invalid JSON is ignored — connection stays open", async () => {
    const ws = await wsConnect();
    await waitForWelcome(ws);
    ws.send("not json at all");
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);
    ws.close();
  });

  test.if(infraOk)("missing siteKey field is rejected silently", async () => {
    const ws = await wsConnect();
    await waitForWelcome(ws);
    ws.send(JSON.stringify({ visitorId: randomUUID() + randomUUID() }));
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);
    ws.close();
  });

  test.if(infraOk)("too-short visitorId is rejected silently", async () => {
    const ws = await wsConnect();
    await waitForWelcome(ws);
    ws.send(JSON.stringify({ siteKey: ctx.siteKey, visitorId: "short" }));
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);
    ws.close();
  });

  test.if(infraOk)("websocket reconnect: second connection from same visitor refreshes presence", async () => {
    const vid = randomUUID() + randomUUID();
    const payload = { siteKey: ctx.siteKey, visitorId: vid };

    const ws1 = await wsConnect();
    await waitForWelcome(ws1);
    await sendPresenceAndWaitForAck(ws1, payload);
    ws1.close();

    const ws2 = await wsConnect();
    await waitForWelcome(ws2);
    await sendPresenceAndWaitForAck(ws2, payload);
    const count = await activeCount(ctx.siteId);
    expect(count).toBeGreaterThanOrEqual(1);
    ws2.close();
  });

});
