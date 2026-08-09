import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { SESSION_COOKIE_NAME } from "@/server/auth/cookies";
import { dbSessionWriter } from "@/server/auth/db-flow";
import { consumeReauthTransaction } from "@/server/auth/reauth";
import { csvLine } from "@/server/billing/csv";
import { billingCsvChunks, subscriptionCsvChunks } from "@/server/billing/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sensitive-operation export (design §7.1): requires a valid Session AND a
 * one-time ReauthTransaction bound to action="export". Streams CSV with BOM
 * and injection escaping; paged keyset reads keep memory flat (§7.7).
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

  const chunks =
    entity === "subscriptions"
      ? subscriptionCsvChunks(session.userId)
      : entity === "billing"
        ? billingCsvChunks(session.userId)
        : usageCsvChunks();

  return new NextResponse(csvStream(chunks), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${entity}-export.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

async function* usageCsvChunks(): AsyncGenerator<string> {
  // usage: placeholder for M3 (quota rows)
  yield csvLine(["note", "usage export lands with M3"]);
}

/**
 * Wrap CSV chunks into a byte stream. pull()-driven so the consumer's
 * backpressure throttles DB pages; BOM goes out as the first chunk.
 */
function csvStream(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  let bomPending = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bomPending) {
        bomPending = false;
        controller.enqueue(encoder.encode("\uFEFF"));
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
