import { redirect } from "next/navigation";

/** 已迁入设置分区（issue #71），保留旧链接跳转。 */
export default function NotificationsRedirect() {
  redirect("/settings/notifications");
}
