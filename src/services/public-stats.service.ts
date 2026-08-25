import { prisma } from "../db/prisma";

export async function getPublicVisitorCount(siteKey: string) {
  const site = await prisma.site.findUnique({
    where: { siteKey },
    select: { id: true },
  });

  if (!site) return null;

  const totalVisitors = await prisma.visitor.count({ where: { siteId: site.id } });

  return { totalVisitors: Number(totalVisitors) };
}
