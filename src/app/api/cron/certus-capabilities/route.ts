import { NextResponse } from "next/server";

import { fetchClientCapabilities, evaluateCapabilities } from "@/server/auth/certus-client-api";
import { loadStartupConfig } from "@/server/auth/startup-config";

import { cronJson } from "../json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily capabilities recheck（§5.4）：结果写结构化日志（JSON 行，落点为
 * 容器/平台日志采集，指标与运维面板从这些字段提取）；失败只告警（error
 * 级日志），不把高频 readiness 拉红。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  let startup;
  try {
    startup = loadStartupConfig();
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: "certus_capabilities_check",
        ok: false,
        error: "config_invalid",
      }),
    );
    return cronJson({ ok: false, error: "config_invalid" }, { status: 503 });
  }
  if (authorization !== `Bearer ${startup.cronSecret}`) {
    return cronJson({ error: "unauthorized" }, { status: 401 });
  }
  // local 模式无 certus 能力可查：空转而不是报错（§12.4）
  if (!startup.auth) {
    return cronJson({ ok: true, skipped: "certus disabled (AUTH_MODE=local)" });
  }

  try {
    const evidence = await fetchClientCapabilities(startup.auth);
    const evaluation = evaluateCapabilities(evidence);
    const ok =
      evidence.httpStatus === 200 &&
      evaluation.go &&
      evidence.hasClientUserStatus &&
      evidence.hasEmailVerifiedFeature;
    // 指标字段：ok/httpStatus/features/introspectionSources/configRevision/失败项 id
    const record = {
      event: "certus_capabilities_check",
      ok,
      httpStatus: evidence.httpStatus,
      schemaVersion: evidence.schemaVersion ?? null,
      features: evidence.features,
      introspectionSources: evidence.introspectionSources,
      configRevision: evidence.configRevision ?? null,
      failedChecks: evaluation.checks.filter((c) => !c.ok).map((c) => c.id),
    };
    if (ok) {
      console.log(JSON.stringify(record));
    } else {
      // 失败只告警：error 级结构化日志即告警落点，不影响 ready
      console.error(JSON.stringify(record));
    }
    return cronJson({
      ok,
      httpStatus: evidence.httpStatus,
      features: evidence.features,
      introspectionSources: evidence.introspectionSources,
      configRevision: evidence.configRevision,
    });
  } catch (cause) {
    console.error(
      JSON.stringify({
        event: "certus_capabilities_check",
        ok: false,
        error: cause instanceof Error ? cause.name : "unknown",
      }),
    );
    return cronJson({ ok: false, error: "upstream_failure" }, { status: 200 });
  }
}
