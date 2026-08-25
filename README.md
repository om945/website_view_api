# Website View Tracker Backend

Small website analytics backend for page views, anonymous visitors, sessions, custom events, and historical analytics.

## Architecture

```text
Browser → Vanilla tracking script → Bun/Elysia → PostgreSQL/Prisma
                                      └──────→ Redis rate limiting
```

Stack: Bun, TypeScript, ElysiaJS, PostgreSQL, Prisma, Redis, Vanilla JavaScript, and Playwright.

## Project structure

- `src/app.ts` exposes the application without starting a listener.
- `src/server.ts` starts the HTTP server and handles shutdown.
- `src/config/` centralizes environment configuration.
- `src/db/` owns the Prisma client.
- `src/redis/` contains the connection and rate limiting.
- `src/utils/` contains hashing, domains, IP handling, user-agent parsing, and API errors.
- `src/index.ts` contains the current Elysia route composition and is retained as the compatibility entry module for the app export.
- `tracking/script.js` is the standalone browser SDK.
- `prisma/` contains the schema, seed, and migrations.
- `tests/unit.test.ts` contains Bun unit/integration checks; `tests/browser.test.ts` contains Playwright tests.
- `public/test-tracker.html` is the single manual test page.

## Local setup

```bash
docker compose up -d
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

Copy `.env.example` to `.env`. Production requires strong `SESSION_SECRET` and `VISITOR_HASH_SECRET` values. Google OAuth additionally requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the exact `GOOGLE_REDIRECT_URI` configured in Google Cloud.

## Testing

```bash
bun test
bun run test:browser
bun run test:all
```

Unit tests skip PostgreSQL/Redis cases when those services are unavailable. Start Docker before expecting the integration cases to execute.

## Tracking script

```html
<script
  src="https://your-domain.com/script.js"
  data-site="SITE_KEY"
  defer>
</script>
```

Use `data-debug="true"` for diagnostic console messages. The SDK persists an anonymous first-party visitor ID, sends page views, supports `pushState`, `replaceState`, and `popstate`, and persists scalar custom events through `/api/v1/events`. ViziAPI v1 is analytics-only; realtime Active Users are planned for v2.

## Metrics

- New visitor: the first-ever page view observed for the site.
- Returning visitor: a visitor whose first-ever page view predates the selected range and who has a page view in the range.
- Unique visitor: a distinct anonymous visitor hash with a page view in the selected range.
- Session: continuous activity from one visitor; a new session begins after **2 hours of inactivity**.
- Page view: one accepted, idempotent page-view event.

Statistics use UTC server timestamps and PostgreSQL aggregation. Page results are capped at 100 paths.

## API

Health: `GET /health`, `GET /ready`.

Authentication: `GET /api/v1/auth/google`, callback, logout, and `/api/v1/auth/me`.

Sites: `POST/GET /api/v1/sites`, `GET/PATCH/DELETE /api/v1/sites/:id`.

Public ingestion: `POST /api/v1/track` and `POST /api/v1/events`.

Authenticated analytics: `GET /api/v1/stats?siteKey=...&range=24h|7d|30d` and `GET /api/v1/stats/pages?...`.

Public visitor counter: `GET /api/v1/public/sites/:siteKey/visitor-count` requires no developer authentication and returns the total visitor count:

```bash
curl https://api.yourdomain.com/api/v1/public/sites/site_abc123/visitor-count
```

```json
{
  "totalVisitors": 12840
}
```

`totalVisitors` is the count of distinct anonymous visitors recorded for the site. The endpoint returns `404` for an unknown site and is protected by its dedicated public-read rate limit (`PUBLIC_STATS_RATE_LIMIT_WINDOW_SECONDS` and `PUBLIC_STATS_RATE_LIMIT_MAX_REQUESTS`, defaulting to 60 requests per minute).

## Privacy

The browser ID is the primary anonymous identity and is HMAC-SHA-256 hashed before persistence. IP addresses and user agents are hashed; raw IPs are never returned. IP is only a secondary signal. The system does not collect form contents, keystrokes, GPS, private LAN IPs, hardware identifiers, advertising IDs, camera, microphone, or invasive fingerprints.

## Production deployment

### Render

The repository includes `render.yaml` for a Docker web service. Use the repository root (`Backend`) as the Render root directory.

- Build command: Docker build from `Dockerfile` (or `bun install --frozen-lockfile && bun run db:generate && bun run build` for a native Bun service).
- Start command: `bun run start` (Docker uses the equivalent `bun dist/server.js`).
- Health check: `/health`; `/ready` is available for dependency readiness checks.
- Production OAuth callback: `https://<real-api-domain>/api/v1/auth/google/callback`.

Set the `DATABASE_URL`, `REDIS_URL`, OAuth, secrets, `TRACKER_BASE_URL`, and explicit `CORS_ORIGINS` values in Render’s environment settings. `CORS_ORIGINS` must include the deployed dashboard origin, for example `https://dashboard.example.com`. If you are intentionally testing the deployed Render API from a local Flutter Web dashboard, temporarily set `ALLOW_LOCALHOST_CORS_IN_PRODUCTION=true`; that switch allows dynamic `http://localhost:<port>` and `http://127.0.0.1:<port>` origins without reflecting arbitrary remote domains. Run `bun run db:migrate:deploy` against the production database as a release/migration step before serving traffic; do not use `db push`.

```text
Internet → HTTPS reverse proxy → Bun/Elysia → PostgreSQL + Redis
```

Run PostgreSQL and Redis on a private network with authentication and TLS where your provider supports it. The application database user should have only the permissions it needs; do not use a database superuser. Redis is used for rate limiting, while PostgreSQL remains the analytics source of truth.

1. Create production secrets in your secret manager and set the variable names in `.env.example`.
2. Configure Google Cloud OAuth with `GOOGLE_REDIRECT_URI` as `https://api.example.com/api/v1/auth/google/callback`.
3. Run `bun run config:check`; it validates production configuration without printing secrets.
4. Deploy migrations with `bun run db:deploy`. Use `bun run db:migrate` only during local development; never use `db push` for production deployment.
5. Build and start with `docker build -t website-view-api .` and inject environment variables at runtime.

Use [deploy/nginx.conf.example](deploy/nginx.conf.example) as the reverse-proxy baseline. Terminate HTTPS there, pass `X-Forwarded-For` and `X-Forwarded-Proto`, and set `TRUSTED_PROXY=true` only when traffic can reach Bun exclusively through that controlled proxy. Cloudflare/Caddy deployments follow the same rule. `/script.js` is cacheable for five minutes; analytics and authenticated API responses are `no-store`.

### Retention, backups, and rollback

Retention is deliberately disabled by default. Schedule `bun run retention:cleanup` only after setting `ENABLE_RETENTION_CLEANUP=true`; it deletes old page views, events, and sessions in bounded batches and never deletes users or sites.

Take encrypted PostgreSQL backups at least daily, retain them according to policy, and regularly test restoring one into an isolated database. A Docker volume is not a backup. For rollback, keep the previous application image, back up before migrations, and prefer forward-only corrective migrations; restoring a backup is the recovery path for destructive migration mistakes.

### Monitoring and load checks

Collect the JSON logs emitted by the service. Alert on 5xx spikes, readiness failures, Redis/PostgreSQL connection failures, high latency, disk use, and memory use. Run `LOAD_TEST_SITE_KEY=... bun run load:test` against a non-production site key to measure ingestion throughput and latency; do not load-test production without capacity approval.
