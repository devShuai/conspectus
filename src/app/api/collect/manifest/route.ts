import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { introspectCliToken } from "@/server/usage/device-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Manifest: bindings this CLI may write (binding-aware ingest contract). */
export async function GET(request: Request): Promise<NextResponse> {
  const sub = await introspectCliToken(request.headers.get("authorization"));
  if (!sub) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = await db.user.findUnique({ where: { certusSub: sub } });
  if (!user) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const bindings = await db.usageBinding.findMany({
    where: {
      userId: user.id,
      status: "active",
      collectorId: { not: null },
    },
    include: { quota: { select: { metric: true, kind: true, unit: true } } },
  });

  return NextResponse.json({
    bindings: bindings.map((b) => ({
      bindingId: b.id,
      collectorId: b.collectorId,
      metric: b.quota.metric,
      kind: b.quota.kind,
      unit: b.quota.unit,
    })),
  });
}
