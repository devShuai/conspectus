import { NextResponse } from "next/server";

import { runPurge } from "@/server/auth/purge";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runPurge();
  return cronJson({ ok: true, ...result });
}
