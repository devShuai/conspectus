type AppLogoProps = {
  className?: string;
  label?: string;
  markClassName?: string;
  subtitle?: string;
};

export function AppLogo({
  className = "",
  label = "conspectus",
  markClassName = "h-9 w-9",
  subtitle,
}: AppLogoProps) {
  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <svg
        className={`shrink-0 ${markClassName}`}
        viewBox="0 0 64 64"
        role="img"
        aria-label="conspectus 订阅资产"
      >
        <rect width="64" height="64" rx="14" fill="#14161F" />
        <rect x="10" y="10" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" strokeWidth="4.5" />
        <rect x="35" y="10" width="19" height="19" rx="4.5" fill="#E07A5F" />
        <rect x="10" y="35" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" strokeWidth="4.5" />
        <rect x="35" y="35" width="19" height="19" rx="4.5" fill="none" stroke="#F2F3F7" strokeWidth="4.5" opacity=".45" />
      </svg>
      <span className="min-w-0">
        <span className="block truncate text-small font-semibold text-zinc-950 dark:text-white">{label}</span>
        {subtitle && <span className="block truncate text-tiny text-zinc-600 dark:text-zinc-400">{subtitle}</span>}
      </span>
    </div>
  );
}
