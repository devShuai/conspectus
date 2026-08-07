import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";

export const dynamic = "force-dynamic";

export default async function ProtectedPage() {
  const session = await currentAppSession();
  if (!session) {
    redirect("/");
  }

  return (
    <main className="shell">
      <p className="eyebrow">受保护页面</p>
      <h1>Session 有效</h1>
      <p className="summary">
        业务层只看到本地标识：<code>{session.userId}</code>
      </p>
      <p className="muted">
        页面没有读取或保存 ID Token、access token、邮箱及其他 OIDC profile。
      </p>
      <form action="/api/auth/logout" method="post">
        <button className="button secondary" type="submit">注销 Session</button>
      </form>
    </main>
  );
}
