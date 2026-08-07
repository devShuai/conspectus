import { redirect } from "next/navigation";

import { currentAppSession } from "@/server/auth/current-session";
import AppNav from "@/components/app-nav";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await currentAppSession();
  if (!session) redirect("/");

  return (
    <div className="app-layout">
      {children}
      <AppNav />
    </div>
  );
}
