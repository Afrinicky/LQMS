/**
 * WaveBackground — faint ocean-depth / signal-flow wave motif.
 * Rendered as a non-interactive SVG layer. Designed to sit behind hero
 * sections, dashboard headers, and section banners. Very subtle by design.
 */
type WaveBackgroundProps = {
  /** Visual intensity. 'hero' is a touch stronger for the homepage. */
  variant?: 'hero' | 'header';
  className?: string;
};

export default function WaveBackground({ variant = 'header', className }: WaveBackgroundProps) {
  const strong = variant === 'hero';
  return (
    <svg
      className={`wave-layer ${className ?? ''}`}
      viewBox="0 0 1440 420"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="wave-royal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#2F6BFF" stopOpacity="0" />
          <stop offset="45%" stopColor="#4E8DFF" stopOpacity={strong ? 0.55 : 0.4} />
          <stop offset="100%" stopColor="#2F6BFF" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="wave-white" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#F5F8FF" stopOpacity="0" />
          <stop offset="50%" stopColor="#F5F8FF" stopOpacity={strong ? 0.16 : 0.1} />
          <stop offset="100%" stopColor="#F5F8FF" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="wave-glow" cx="78%" cy="8%" r="60%">
          <stop offset="0%" stopColor="#2F6BFF" stopOpacity={strong ? 0.22 : 0.14} />
          <stop offset="100%" stopColor="#2F6BFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width="1440" height="420" fill="url(#wave-glow)" />

      {/* Bright royal-blue signal waves */}
      <path
        d="M0,210 C220,140 360,300 620,230 C880,160 1040,300 1440,200"
        fill="none"
        stroke="url(#wave-royal)"
        strokeWidth={strong ? 2.4 : 1.8}
      />
      <path
        d="M0,260 C260,200 420,340 700,260 C980,180 1120,320 1440,250"
        fill="none"
        stroke="url(#wave-royal)"
        strokeWidth="1.2"
        opacity="0.7"
      />

      {/* Faint white depth waves */}
      <path
        d="M0,300 C240,250 420,360 720,300 C1020,240 1180,350 1440,300"
        fill="none"
        stroke="url(#wave-white)"
        strokeWidth="1"
      />
      <path
        d="M0,160 C300,110 460,230 760,170 C1060,110 1200,210 1440,150"
        fill="none"
        stroke="url(#wave-white)"
        strokeWidth="0.8"
        opacity="0.8"
      />

      {/* Dotted data-flow accents */}
      <path
        d="M0,235 C260,175 420,315 700,235 C980,155 1120,295 1440,225"
        fill="none"
        stroke="#4E8DFF"
        strokeWidth="1.2"
        strokeDasharray="2 12"
        strokeLinecap="round"
        opacity={strong ? 0.5 : 0.32}
      />
    </svg>
  );
}
