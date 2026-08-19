import { prisma } from "../src/db/prisma";
console.log(`Database connected: ${await prisma.$queryRaw`SELECT 1`}`);
await prisma.$disconnect();
