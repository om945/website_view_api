import { app } from "./app";
import { prisma } from "./db/prisma";
import { redis } from "./redis/redis";
import { config } from "./config/config";
import { logger } from "./utils/logger";

const server = app.listen({ port: config.port, maxRequestBodySize: config.maxRequestBodyBytes });
logger.info("server.started", { port: server.server?.port ?? config.port, environment: config.nodeEnv });

async function shutdown(signal: string) {
  logger.info("server.shutdown", { signal });
  server.stop();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
