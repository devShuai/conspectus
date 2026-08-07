import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __conspectusPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    datasources: {
      db: { url: process.env.DATABASE_URL },
    },
  });
  return client;
}

export const db: PrismaClient =
  globalThis.__conspectusPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__conspectusPrisma = db;
}
