import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { loadAuthConfig } from "@/server/auth/config";
import { recheckIdentityStatus } from "@/server/auth/identity-status";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONCURRENCY = 10;

export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }

  const config = loadAuthConfig();
  const now = new Date();
  const due = await db.user.findMany({
    where: {
      certusSub: { not: null },
      OR: [
        { statusCheckFailureCount: { gt: 0 } },
        {
          statusReason: { in: ["certus_locked", "certus_disabled"] },
          nextStatusCheckAt: { lte: now },
        },
        {
          certusLinkStatus: { not: null },
          nextStatusCheckAt: { lte: now },
        },
      ],
    },
    select: { id: true, certusSub: true },
    take: 200,
  });

  const outcomes: Record<string, string> = {};
  let index = 0;
  async function worker() {
    while (index < due.length) {
      const item = due[index++];
      if (!item.certusSub) continue;
      const outcome = await recheckIdentityStatus({
        userId: item.id,
        certusSub: item.certusSub,
        config,
        now,
      });
      outcomes[item.id] = outcome.kind;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, due.length || 1) }, () => worker()),
  );

  return cronJson({
    ok: true,
    scanned: due.length,
    outcomes,
  });
}
