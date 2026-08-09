import { NextResponse } from "next/server";

/**
 * §5.4 定时任务统一契约：所有 /api/cron/* 端点的每个响应都带
 * `Cache-Control: no-store`（含 401/400/503），不依赖框架默认。
 */
export function cronJson(data: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
