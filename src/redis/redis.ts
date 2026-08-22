import Redis from "ioredis";
import { config } from "../config/config";
import { logger } from "../utils/logger";

export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
});

redis.on("error",
  (error) => logger.error("redis.connection_error", { message: error.message }));
