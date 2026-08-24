import { config } from "../config/config";
import { logger } from "../utils/logger";
import { redis } from "./redis";

const presenceKey = (siteId: string) => `presence:${siteId}`;

// Keep the whole site presence set short-lived when a site becomes inactive.
// Individual members still use their score as the authoritative expiry.
const presenceKeyTtl = () =>
  Math.max(config.activeTtl + config.heartbeatIntervalSeconds, config.activeTtl + 1);

export async function touchPresence(siteId: string, visitorHash: string) {
  try {
    const now = Date.now();
    return Number(await redis.eval(
      "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]); redis.call('EXPIRE', KEYS[1], ARGV[3]); return redis.call('ZCOUNT', KEYS[1], ARGV[4], '+inf');",
      1,
      presenceKey(siteId),
      now + config.activeTtl * 1000,
      visitorHash,
      presenceKeyTtl(),
      now,
    ));
  } catch (error) {
    logger.warn("presence.unavailable", { message: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

export async function activeCount(siteId: string) {
  try {
    const now = Date.now();
    return Number(await redis.zcount(presenceKey(siteId), now, "+inf"));
  } catch (error) {
    logger.warn("presence.count_unavailable", { message: error instanceof Error ? error.message : "unknown" });
    return 0;
  }
}

export { presenceKey };
