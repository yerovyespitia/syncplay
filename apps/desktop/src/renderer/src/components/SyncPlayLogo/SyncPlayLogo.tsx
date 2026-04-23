import "./SyncPlayLogo.css";

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
      fill="none"
      role="img"
      aria-labelledby={titleId}
      shapeRendering="geometricPrecision"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title id={titleId}>{title}</title>

      {/*
        Triangle centroid = (80, 80) exactly: (73+73+94)/3=80, (62+98+80)/3=80.
        Arc centers at (66,80) and (94,80) — both 14px from canvas center → symmetric.
        Outer arcs reach x=43 and x=117 → both 37px from canvas center → symmetric.
      */}
      {/* Lucide play icon, scaled to match previous triangle bounds (x:65–95, y:62–98) */}
      <g transform="translate(62.5, 63.2) scale(1.4)">
        <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" fill="#8b5cf6" />
      </g>

      {/* Right arcs — centered at tip (94, 80), open rightward */}
      <path d="M 101.5 69.4 A 13 13 0 0 1 101.5 90.6" stroke="#8b5cf6" strokeWidth="6" strokeLinecap="round" />
      <path d="M 107.2 61.2 A 23 23 0 0 1 107.2 98.8" stroke="#8b5cf6" strokeWidth="6" strokeLinecap="round" />

      {/* Left arcs — centered at (66, 80), open leftward */}
      <path d="M 58.5 69.4 A 13 13 0 0 0 58.5 90.6"  stroke="#8b5cf6" strokeWidth="6" strokeLinecap="round" />
      <path d="M 52.8 61.2 A 23 23 0 0 0 52.8 98.8"  stroke="#8b5cf6" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}
