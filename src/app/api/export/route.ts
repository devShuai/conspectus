import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { dbSessionWriter } from "@/server/auth/db-flow";
import { csvLine } from "@/server/billing/csv";
import { consumeReauthTransaction } from "@/server/auth/reauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 500;

/**
 * Sensitive-operation export (design §7.1): requires a valid Session AND a
 * one-time ReauthTransaction bound to action="export". Streams CSV with BOM,
 * injection escaping, paged reads (no full in-memory load).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.slice(SESSION_COOKIE_NAME.length + 1);
  const session = await dbSessionWriter.find(token);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Reauth gate (single-use, bound to action=export)
  const reauthToken = request.nextUrl.searchParams.get("reauth");
  if (!reauthToken) {
    return NextResponse.json(
      { error: "reauth_required", hint: "complete a ReauthTransaction for export" },
      { status: 428 },
    );
  }
  const consumed = await consumeReauthTransaction({
    token: reauthToken,
    // Real session row id: a reauth completed on another device must not be
    // usable by this one (#99).
    sessionId: session.sessionId,
    userId: session.userId,
    action: "export",
  });
  if (!consumed) {
    return NextResponse.json({ error: "reauth_invalid" }, { status: 403 });
  }

  const entity = request.nextUrl.searchParams.get("entity") ?? "subscriptions";
  if (!["subscriptions", "billing", "usage"].includes(entity)) {
    return NextResponse.json({ error: "invalid_entity" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let buffer = "\uFEFF"; // UTF-8 BOM for Excel

  if (entity === "subscriptions") {
    buffer += csvLine(["id", "name", "plan", "status", "price", "currency", "billing_cycle", "cycle_days", "anchor_day", "started_at", "next_billing_at", "auto_renew", "tags", "notes"]);
    let cursor = 0;
    for (;;) {
      const rows = await db.subscription.findMany({
        where: { userId: session.userId },
        orderBy: { createdAt: "asc" },
        skip: cursor,
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        buffer += csvLine([
          row.id, row.name, row.planName ?? "", row.status,
          row.price.toString(), row.currency, row.billingCycle,
          row.cycleDays ?? "", row.anchorDay ?? "",
          row.startedAt.toISOString().slice(0, 10),
          row.nextBillingAt ? row.nextBillingAt.toISOString().slice(0, 10) : "",
          row.autoRenew, row.tags.join(";"), row.notes ?? "",
        ]);
      }
      cursor += rows.length;
    }
  } else if (entity === "billing") {
    buffer += csvLine(["id", "subscription_id", "record_type", "amount", "currency", "billed_at", "status", "source", "occurrence_key"]);
    let cursor = 0;
    for (;;) {
      const rows = await db.billingRecord.findMany({
        where: { userId: session.userId },
        orderBy: { billedAt: "asc" },
        skip: cursor,
        take: PAGE_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        buffer += csvLine([
          row.id, row.subscriptionId, row.recordType,
          row.amount.toString(), row.currency,
          row.billedAt.toISOString().slice(0, 10),
          row.status, row.source, row.occurrenceKey ?? "",
        ]);
      }
      cursor += rows.length;
    }
  } else {
    // usage: placeholder for M3 (quota rows)
    buffer += csvLine(["note", "usage export lands with M3"]);
  }

  return new NextResponse(encoder.encode(buffer), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${entity}-export.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

void db;
