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
              <code>npm install -g conspectus-collect && conspectus-collect login</code>
            </>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>名称</th><th>平台</th><th>版本</th><th>最近上报</th><th>状态</th><th></th></tr>
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
                    <td>{device.lastSeenAt ? formatDateTime(device.lastSeenAt, timezone) : "从未上报"}</td>
                    <td>
                      {device.revokedAt ? (
                        <span className="tag warn">已撤销</span>
                      ) : offline ? (
                        <span className="tag warn">离线</span>
                      ) : (
                        <span className="tag">在线</span>
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
