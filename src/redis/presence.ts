import { config } from "../config/config";
import { logger } from "../utils/logger";
import { redis } from "./redis";

const presenceKey = (siteId: string) => `presence:${siteId}`;

export async function touchPresence(siteId: string, visitorHash: string) {
  try {
    await redis.zadd(presenceKey(siteId), Date.now() + config.activeTtl * 1000, visitorHash);
  } catch (error) {
    logger.warn("presence.unavailable", { message: error instanceof Error ? error.message : "unknown" });
  }
}

export async function activeCount(siteId: string) {
  try {
    const now = Date.now();
    await redis.zremrangebyscore(presenceKey(siteId), "-inf", now);
    return redis.zcard(presenceKey(siteId));
  } catch (error) {
    logger.warn("presence.count_unavailable", { message: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

export { presenceKey };
