import { NextResponse } from "next/server";

import { db } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness: process is up (no external dependencies). */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}

void db;
