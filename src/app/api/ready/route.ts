import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { db } from "@/server/db";
import type { AuthConfig } from "@/server/auth/config";
import { fetchClientCapabilities, evaluateCapabilities } from "@/server/auth/certus-client-api";
import { loadStartupConfig } from "@/server/auth/startup-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** §5.4：deep 结果按 issuer+client_id 缓存 60s，数据库 single-flight。 */
const DEEP_CACHE_TTL_MS = 60_000;
const PROBE_LEASE_MS = 30_000;
const WAIT_FOR_LEASE_MS = 20_000;
const WAIT_POLL_MS = 250;

/**
 * Lightweight readiness: DB reachable + migrations applied（§12.3「迁移落后
 * 时 ready 失败」）. Never touches certus. Deep probe requires the deploy
 * secret and checks certus machine-readable capabilities —— 60s 缓存与
 * single-flight 落在 deep_ready_probes 表，多实例共享，不各自穿透。
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

  const expectedCliSource = process.env.CERTUS_CLI_CLIENT_ID?.trim() || "conspectus-cli";
  // 空格分隔（Postgres TEXT 不允许 NUL，issuer/clientId 均不含空格）。CLI client
  // 也是能力契约的一部分；轮换生产 CLI ID 后不能复用旧 ID 的 deep-ready 缓存。
  const key = `${auth.issuerIdentifier} ${auth.clientId} ${expectedCliSource}`;
  try {
    const body = await deepProbeCached(key, auth, expectedCliSource);
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
    const row = await db.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    if (row.length !== 1) return false;

    // 失败或半截迁移（finished_at 为空）直接 not ready
    const unfinished = await db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::integer AS count
      FROM "_prisma_migrations"
      WHERE "finished_at" IS NULL
    `;
    if ((unfinished[0]?.count ?? 1) !== 0) return false;

    // 代码携带的最新迁移必须已应用，否则视为迁移落后（§12.3）
    const latest = latestLocalMigration();
    if (latest !== null) {
      const applied = await db.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::integer AS count
        FROM "_prisma_migrations"
        WHERE "migration_name" = ${latest} AND "finished_at" IS NOT NULL
      `;
      if ((applied[0]?.count ?? 0) !== 1) return false;
    }
    return true;
  } catch {
    // 连不上库，或 _prisma_migrations 不存在（从未 migrate deploy）都算 not ready
    return false;
  }
}

/**
 * 本地最新迁移目录名。Docker 镜像打包 prisma/ 可读；Vercel 等文件不落盘
 * 的形态返回 null——无法判定时退化为仅校验库内无失败迁移，完整比对交给
 * 部署流水线的 migrate deploy。
 */
function latestLocalMigration(): string | null {
  try {
    const entries = readdirSync(join(process.cwd(), "prisma", "migrations"), {
      withFileTypes: true,
    });
    const names = entries
      .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return names.at(-1) ?? null;
  } catch {
    return null;
  }
}

async function probeCertus(
  auth: AuthConfig,
  expectedCliSource: string,
): Promise<Record<string, unknown>> {
  const evidence = await fetchClientCapabilities(auth, undefined, { expectedCliSource });
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
}

/**
 * 数据库版 60s 缓存 + single-flight：lease CAS 保证全集群同一时刻最多一个
 * worker 请求 certus；没抢到租约的实例轮询等待持租者写入缓存行。
 */
async function deepProbeCached(
  key: string,
  auth: AuthConfig,
  expectedCliSource: string,
): Promise<unknown> {
  const now = new Date();
  const cached = await db.deepReadyProbe.findUnique({ where: { cacheKey: key } });
  if (cached && now.getTime() - cached.checkedAt.getTime() < DEEP_CACHE_TTL_MS) {
    return cached.body;
  }

  const token = randomUUID();
  if (await acquireProbeLease(key, token, now)) {
    try {
      const body = await probeCertus(auth, expectedCliSource);
      await db.deepReadyProbe.updateMany({
        where: { cacheKey: key, leaseToken: token },
        data: {
          body: body as Prisma.InputJsonValue,
          checkedAt: new Date(),
          leaseUntil: null,
          leaseToken: null,
        },
      });
      return body;
    } catch (cause) {
      // 释放租约，下一个实例立即可重试；缓存行保持旧值/占位
      await db.deepReadyProbe.updateMany({
        where: { cacheKey: key, leaseToken: token },
        data: { leaseUntil: null, leaseToken: null },
      });
      throw cause;
    }
  }

  // 没抢到租约：轮询等持租者写入；租约有 30s 上界，不会死等
  const deadline = Date.now() + WAIT_FOR_LEASE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    const row = await db.deepReadyProbe.findUnique({ where: { cacheKey: key } });
    if (row && Date.now() - row.checkedAt.getTime() < DEEP_CACHE_TTL_MS) {
      return row.body;
    }
  }
  // 持租者疑似死亡（进程被杀/卡死）：兜底直探，lease 过期机制保证后续可恢复
  return probeCertus(auth, expectedCliSource);
}

async function acquireProbeLease(
  key: string,
  token: string,
  now: Date,
): Promise<boolean> {
  const leaseUntil = new Date(now.getTime() + PROBE_LEASE_MS);
  const updated = await db.deepReadyProbe.updateMany({
    where: {
      cacheKey: key,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil, leaseToken: token },
  });
  if (updated.count === 1) return true;
  try {
    // 首次探测：占位行 checkedAt=epoch，永不命中 60s 缓存
    await db.deepReadyProbe.create({
      data: {
        cacheKey: key,
        body: {},
        checkedAt: new Date(0),
        leaseUntil,
        leaseToken: token,
      },
    });
    return true;
  } catch {
    // 并发 create 撞主键：对方持租
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
