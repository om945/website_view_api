import { config } from "../config/config";
import { prisma } from "../db/prisma";
import { logger } from "../utils/logger";

const batchSize = 10_000;

async function deleteBatch(table: "PageView" | "Event" | "Session", timestampColumn: "createdAt" | "lastActivityAt", cutoff: Date) {
  return prisma.$executeRawUnsafe(
    `DELETE FROM "${table}" WHERE "id" IN (SELECT "id" FROM "${table}" WHERE "${timestampColumn}" < $1 LIMIT ${batchSize})`,
    cutoff,
  );
}

if (!config.retentionCleanupEnabled) {
  throw new Error("Retention cleanup is disabled. Set ENABLE_RETENTION_CLEANUP=true only for an explicit scheduled job.");
}

const cutoff = new Date(Date.now() - config.dataRetentionDays * 86_400_000);
let total = 0;
for (const [table, column] of [["PageView", "createdAt"], ["Event", "createdAt"], ["Session", "lastActivityAt"]] as const) {
  let deleted = 0;
  do {
    deleted = await deleteBatch(table, column, cutoff);
    total += deleted;
  } while (deleted === batchSize);
}

logger.info("retention.completed", { cutoff: cutoff.toISOString(), deleted: total });
await prisma.$disconnect();
