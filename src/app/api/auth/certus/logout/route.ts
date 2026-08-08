import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { authModeGate } from "@/server/auth/auth-mode";
import { certusGlobalLogout } from "@/server/auth/logout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RP-Initiated Logout via certus; POST only (GET is CSRF-prone). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = authModeGate("certus");
  if (gate) return gate;
  return certusGlobalLogout(request);
}
