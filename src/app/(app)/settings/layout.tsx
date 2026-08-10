import SettingsNav from "@/components/settings-nav";

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="settings-layout">
      <SettingsNav />
      {children}
    </div>
  );
}
