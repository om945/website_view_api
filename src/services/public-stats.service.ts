import { prisma } from "../db/prisma";
import { activeCount } from "../redis/presence";

export async function getPublicVisitorCount(siteKey: string) {
  const site = await prisma.site.findUnique({
    where: { siteKey },
    select: { id: true },
  });

  if (!site) return null;

  const [totalVisitors, activeVisitors] = await Promise.all([
    prisma.visitor.count({ where: { siteId: site.id } }),
    activeCount(site.id),
  ]);

  return { totalVisitors: Number(totalVisitors), activeVisitors: Number(activeVisitors) };
}
