export {};

async function loadTestEnvironment() {
  const contents = await Bun.file(".env.test").text();
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
}

await loadTestEnvironment();

const [{ app }, { config }, { prisma }, { redis }, { logger }] = await Promise.all([
  import("./app"),
  import("./config/config"),
  import("./db/prisma"),
  import("./redis/redis"),
  import("./utils/logger"),
]);

const port = Number(process.env.TEST_PORT ?? config.port ?? 3100);
const server = app.listen({ port, maxRequestBodySize: config.maxRequestBodyBytes });
logger.info("test_server.started", { port, environment: config.nodeEnv, testBaseUrl: process.env.TEST_BASE_URL });

async function shutdown(signal: string) {
  logger.info("test_server.shutdown", { signal });
  server.stop();
  await prisma.$disconnect();
  redis.disconnect();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
