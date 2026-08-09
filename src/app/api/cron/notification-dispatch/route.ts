import { NextResponse } from "next/server";

import { dispatchDueDeliveries } from "@/server/notify/dispatch";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }
  const result = await dispatchDueDeliveries();
  return cronJson({ ok: true, ...result });
}
