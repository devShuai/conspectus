import { NextResponse } from "next/server";

import { db } from "@/server/db";
import { fetchClientCapabilities, evaluateCapabilities } from "@/server/auth/certus-client-api";
import { loadStartupConfig } from "@/server/auth/startup-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 60s in-memory cache keyed by (issuer, clientId). */
const deepCache = new Map<string, { at: number; body: unknown }>();
const DEEP_CACHE_TTL_MS = 60_000;
const deepInFlight = new Map<string, Promise<unknown>>();

/**
 * Lightweight readiness: DB reachable + migration applied (schema_migrations).
 * Never touches certus. Deep probe requires the deploy secret and checks
 * certus machine-readable capabilities (single-flight + 60s cache).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    const dbOk = await checkDatabase();
    return NextResponse.json(
      dbOk ? { status: "ready" } : { status: "not_ready", reason: "database" },
      { status: dbOk ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  }

  // Deep probe: bearer deploy secret required; absent/unknown → 404 (design §5.4).
  const authorization = request.headers.get("authorization");
  let startup;
  try {
    startup = loadStartupConfig();
  } catch {
    return NextResponse.json({ status: "not_ready", reason: "config" }, { status: 503 });
  }
  if (authorization !== `Bearer ${startup.deployProbeSecret}`) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const dbOk = await checkDatabase();
  if (!dbOk) {
    return NextResponse.json(
      { status: "not_ready", reason: "database" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  // local 模式无 certus 可探：深探针如实报告跳过（§5.4 就绪分层）
  const auth = startup.auth;
  if (!auth) {
    return NextResponse.json(
      { status: "ready", deep: { ok: true, skipped: "certus disabled (AUTH_MODE=local)" } },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const key = `${auth.issuerIdentifier}\0${auth.clientId}`;
  const cached = deepCache.get(key);
  if (cached && Date.now() - cached.at < DEEP_CACHE_TTL_MS) {
    return jsonFrom(cached.body);
  }

  // single-flight: only one worker hits certus at a time.
  let pending = deepInFlight.get(key);
  if (!pending) {
    pending = (async () => {
      const evidence = await fetchClientCapabilities(auth);
      const evaluation = evaluateCapabilities(evidence);
      return {
        ok:
          evidence.httpStatus === 200 &&
          evaluation.go &&
          evidence.hasClientUserStatus &&
          evidence.hasEmailVerifiedFeature,
        httpStatus: evidence.httpStatus,
        schemaVersion: evidence.schemaVersion,
        features: evidence.features,
        introspectionSources: evidence.introspectionSources,
        configRevision: evidence.configRevision,
        checks: evaluation.checks,
      };
    })().finally(() => deepInFlight.delete(key));
    deepInFlight.set(key, pending);
  }

  try {
    const body = await pending;
    deepCache.set(key, { at: Date.now(), body });
    return jsonFrom(body);
  } catch {
    return NextResponse.json(
      { status: "not_ready", reason: "capabilities_upstream" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}

async function checkDatabase(): Promise<boolean> {
  try {
    const row = await db.$queryRaw<
      Array<{ ok: number }>
    >`SELECT 1 AS ok`;
    return row.length === 1;
  } catch {
    return false;
  }
}

function jsonFrom(body: unknown): NextResponse {
  const ready = (body as { ok?: boolean }).ok === true;
  return NextResponse.json(
    ready ? { status: "ready", deep: body } : { status: "not_ready", deep: body },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
