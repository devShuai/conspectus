import { NextResponse } from "next/server";

import { fetchClientCapabilities, evaluateCapabilities } from "@/server/auth/certus-client-api";
import { loadStartupConfig } from "@/server/auth/startup-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Daily capabilities recheck; writes structured result, alerts on failure only. */
export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  let startup;
  try {
    startup = loadStartupConfig();
  } catch (cause) {
    return NextResponse.json(
      { ok: false, error: "config_invalid" },
      { status: 503 },
    );
  }
  if (authorization !== `Bearer ${startup.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const evidence = await fetchClientCapabilities(startup.auth);
    const evaluation = evaluateCapabilities(evidence);
    return NextResponse.json({
      ok: evaluation.go,
      httpStatus: evidence.httpStatus,
      features: evidence.features,
      introspectionSources: evidence.introspectionSources,
      configRevision: evidence.configRevision,
    });
  } catch (cause) {
    console.error(
      "[cron/certus-capabilities]",
      cause instanceof Error ? cause.name : "unknown",
    );
    return NextResponse.json({ ok: false, error: "upstream_failure" }, { status: 200 });
  }
}
