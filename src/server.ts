import { app } from "./app";
import { prisma } from "./db/prisma";
import { redis } from "./redis/redis";
import { config } from "./config/config";
import { logger } from "./utils/logger";

const server = app.listen({ hostname: config.host, port: config.port, maxRequestBodySize: config.maxRequestBodyBytes });
logger.info("server.started", { host: config.host, port: server.server?.port ?? config.port, environment: config.nodeEnv });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("server.shutdown", { signal });
  server.stop();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
