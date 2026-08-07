import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __conspectusPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL (or TEST_DATABASE_URL) is required");
  }
  const client = new PrismaClient({
    datasources: {
      db: { url },
    },
  });
  return client;
}

export const db: PrismaClient =
  globalThis.__conspectusPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__conspectusPrisma = db;
}
