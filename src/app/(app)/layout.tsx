import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import AppNav from "@/components/app-nav";
import InstallPrompt from "@/components/install-prompt";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await currentAppSession();
  if (!session) redirect("/login");

  return (
    <div className="app-layout">
      <AppNav />
      <div className="app-content">{children}</div>
      <InstallPrompt />
    </div>
  );
}
