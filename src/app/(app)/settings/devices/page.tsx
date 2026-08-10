import { redirect } from "next/navigation";

import ActionButton from "@/components/action-button";
import EmptyState from "@/components/empty-state";
import { formatDateTime } from "@/components/datetime";
import { currentAppSession } from "@/server/auth/current-session";
import { db } from "@/server/db";
import { revokeDeviceAction } from "@/server/settings/actions";

export const dynamic = "force-dynamic";

export default async function DevicesSettingsPage() {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  const [devices, user] = await Promise.all([
    db.collectorDevice.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: "desc" },
    }),
    db.user.findUnique({
      where: { id: session.userId },
      select: { timezone: true },
    }),
  ]);
  const timezone = user?.timezone ?? "UTC";

  return (
    <main className="shell">
      <p className="eyebrow">设置 / 采集设备</p>
      <h1>本地采集器</h1>
      <p className="muted">
        撤销后该设备公钥立即失效；撤销 certus 的 conspectus-cli 授权则全部 CLI 失效（design §7.4）。
      </p>
      {devices.length === 0 ? (
        <EmptyState
          title="暂无设备"
          hint={
            <>
              在本机安装采集器并登录后，设备会自动出现在这里：
              {/* 原提示是 `npm install -g conspectus-collect && conspectus-collect login`。
                  两处都错：无 scope 的裸名字本项目从未在公共 npm 注册，一旦被人抢注，
                  这条印在界面里的命令就会让用户装到陌生人的代码并立刻运行，而本 CLI
                  持有设备授权令牌与签名私钥；且 login 之前必须先 configure，否则直接
                  报 config not found。scope 绑定到自有 registry 后不存在回退到公共源的
                  可能。详见 collector/SCHEDULING.md。 */}
              <pre className="code-block">
                <code>
                  {[
                    "npm config set @devshuai:registry https://nexus.devshuai.com/repository/npm-hosted/",
                    "npm install -g @devshuai/conspectus-collect",
                    "conspectus-collect configure",
                    "conspectus-collect login",
                  ].join("\n")}
                </code>
              </pre>
            </>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th scope="col">名称</th><th scope="col">平台</th><th scope="col">版本</th><th scope="col">最近上报</th><th scope="col">状态</th><th></th></tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                const offline =
                  !device.revokedAt &&
                  (!device.lastSeenAt ||
                    Date.now() - device.lastSeenAt.getTime() > 3 * 86_400_000);
                return (
                  <tr key={device.id}>
                    <td>{device.name}</td>
                    <td>{device.platform}</td>
                    <td>{device.agentVersion}</td>
                    <td className="date">{device.lastSeenAt ? formatDateTime(device.lastSeenAt, timezone) : "从未上报"}</td>
                    <td>
                      {device.revokedAt ? (
                        <span className="tag warn">已撤销</span>
                      ) : offline ? (
                        <span className="tag warn">离线</span>
                      ) : (
                        <span className="tag ok">在线</span>
                      )}
                    </td>
                    <td>
                      {!device.revokedAt && (
                        <ActionButton
                          action={revokeDeviceAction}
                          fields={{ deviceId: device.id }}
                          label="撤销"
                          pendingLabel="撤销中…"
                          confirm={`撤销设备「${device.name}」？其公钥立即失效。`}
                          variant="danger"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
