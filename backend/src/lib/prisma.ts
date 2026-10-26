import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () => {
  return new PrismaClient();
};

declare global {
  var prisma: ReturnType<typeof prismaClientSingleton> | undefined;
}

export const prisma = global.prisma ?? prismaClientSingleton();

/**
 * Budget for every interactive transaction. Prisma's defaults (2 s to obtain a pool
 * connection, 5 s overall) turn a burst of concurrent requests into 500s: with 100
 * simultaneous verify/webhook calls or credits, most failed with "Unable to start a
 * transaction in the given time". A burst should queue (latency), not fail (errors).
 */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 };

if (process.env.NODE_ENV !== "production") {
  global.prisma = prisma;
}
