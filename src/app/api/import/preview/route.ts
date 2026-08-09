import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { currentAppSession } from "@/server/auth/current-session";
import {
  CONFLICT_STRATEGIES,
  ImportError,
  previewSubscriptionImport,
  type ConflictStrategy,
} from "@/server/import/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 与确认 Server Action 的 1MB body 上限对齐，留足表单开销。 */
const MAX_IMPORT_FILE_BYTES = 512 * 1024;

/**
 * CSV 导入第一步（design §7.7）：上传 + 预检。会话鉴权，不写库；
 * 逐行 Zod 校验，返回错误行与新建/更新/跳过/复制分类。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await currentAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", limit: MAX_IMPORT_FILE_BYTES },
      { status: 413 },
    );
  }

  const strategyParam = String(form.get("strategy") ?? "skip");
  const strategy: ConflictStrategy = (CONFLICT_STRATEGIES as readonly string[]).includes(
    strategyParam,
  )
    ? (strategyParam as ConflictStrategy)
    : "skip";

  try {
    const preview = await previewSubscriptionImport(session.userId, await file.text(), strategy);
    return NextResponse.json({ ok: true, data: preview });
  } catch (cause) {
    if (cause instanceof ImportError) {
      return NextResponse.json(
        { ok: false, error: { code: cause.code, message: cause.message } },
        { status: 400 },
      );
    }
    throw cause;
  }
}
