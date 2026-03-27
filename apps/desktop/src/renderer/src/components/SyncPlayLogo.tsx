interface SyncPlayLogoProps {
  className?: string;
  title?: string;
}

export function SyncPlayLogo({ className, title = "SyncPlay" }: SyncPlayLogoProps) {
  const titleId = "syncplay-logo-title";

  return (
    <svg
      className={className}
      viewBox="0 0 160 160"
      role="img"
      aria-labelledby={titleId}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>{title}</title>
      <defs>
        <linearGradient id="syncplay-logo-orbit" x1="22" y1="28" x2="134" y2="138" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="0.52" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22c55e" />
        </linearGradient>
        <linearGradient id="syncplay-logo-core" x1="50" y1="42" x2="106" y2="114" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#faf5ff" stopOpacity="0.96" />
          <stop offset="1" stopColor="#ddd6fe" stopOpacity="0.86" />
        </linearGradient>
        <radialGradient id="syncplay-logo-glow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(80 80) rotate(90) scale(58)">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.26" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="160" height="160" rx="40" fill="#0f0f13" />
      <rect x="8" y="8" width="144" height="144" rx="32" fill="url(#syncplay-logo-glow)" />

      <path
        d="M42 48C49 40 61 34 76 34c16 0 31 6 42 18 5 5 10 12 13 19"
        fill="none"
        stroke="url(#syncplay-logo-orbit)"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path
        d="M118 112c-8 9-21 14-36 14-16 0-31-6-42-18-5-5-10-12-13-19"
        fill="none"
        stroke="url(#syncplay-logo-orbit)"
        strokeWidth="12"
        strokeLinecap="round"
      />

      <circle cx="126" cy="70" r="7" fill="#22c55e" />
      <circle cx="34" cy="90" r="7" fill="#7c3aed" />

      <path d="M70 61.5v37l30-18.5-30-18.5Z" fill="url(#syncplay-logo-core)" />
    </svg>
  );
}
