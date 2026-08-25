type Bucket = {
  count: number;
  expiresAt: number;
};

const buckets = new Map<string, Bucket>();
let lastCleanupAt = 0;

/**
 * Bounded per-process fixed-window protection for high-volume public
 * analytics endpoints. It intentionally uses no Redis commands. Distributed
 * security-sensitive routes remain protected by the Redis limiter.
 */
export function localRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
  now = Date.now(),
) {
  if (now - lastCleanupAt >= 60_000 || buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.expiresAt <= now) buckets.delete(bucketKey);
    }
    lastCleanupAt = now;
  }

  const windowMs = windowSeconds * 1000;
  const bucketId = Math.floor(now / windowMs);
  const bucketKey = `${key}:${bucketId}`;
  const current = buckets.get(bucketKey);

  if (!current) {
    buckets.set(bucketKey, {
      count: 1,
      expiresAt: (bucketId + 1) * windowMs,
    });
    return true;
  }

  current.count += 1;
  return current.count <= max;
}
