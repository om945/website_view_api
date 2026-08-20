import { config } from "../config/config";
import { logger } from "../utils/logger";
import { redis } from "./redis";

export async function rateLimit(key: string, max = config.rateMax, windowSeconds = config.rateWindow) {
  const bucket = `rate:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  try {
    const count = await redis.eval(
      "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count;",
      1,
      bucket,
      windowSeconds,
    );
    return Number(count) <= max;
  } catch (error) {
    logger.warn("rate_limit.unavailable", { message: error instanceof Error ? error.message : "unknown" });
    return true;
  }
}
