import type { ReactNode } from 'react';

/* ============================================================================
   Lightweight, dependency-free SVG chart kit for the SECH_LIMS dashboards.
   All charts are theme-aware (use the dark palette), responsive (viewBox based)
   and gracefully render an empty state when there is no data. No external
   charting library is used so the offline Electron build stays dependency-free.
   ========================================================================= */

export const CHART_COLORS = [
  '#4E8DFF', // accent bright
  '#34D399', // success
  '#F5B544', // warning
  '#FF6B7D', // danger
  '#A78BFA', // violet
  '#2DD4BF', // teal
  '#F472B6', // pink
  '#60A5FA', // sky
];

type Datum = {
  label: string;
  value: number | null | undefined;
  color?: string;
  /** When set, the row/segment/legend entry is clickable and opens its source data. */
  onClick?: () => void;
};

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

function ChartEmpty({ height = 140, label = 'No data yet' }: { height?: number; label?: string }) {
  return (
    <div className="chart-empty" style={{ minHeight: height }}>
      <span>{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * DonutChart — composition of parts. Center shows total (or custom).
 * ------------------------------------------------------------------ */
export function DonutChart({
  data,
  size = 168,
  thickness = 18,
  centerValue,
  centerLabel,
  legend = true,
}: {
  data: Datum[];
  size?: number;
  thickness?: number;
  centerValue?: ReactNode;
  centerLabel?: string;
  legend?: boolean;
}) {
  const items = data.map((d, i) => ({ ...d, value: num(d.value), color: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const total = items.reduce((s, d) => s + d.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;

  let offset = 0;

  return (
    <div className="chart-donut">
      <div className="donut-svg" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={thickness} />
          {total > 0 && (
            <g transform={`rotate(-90 ${cx} ${cx})`}>
              {items.map((d, i) => {
                if (d.value <= 0) return null;
                const frac = d.value / total;
                const len = frac * c;
                const dash = `${len} ${c - len}`;
                const el = (
                  <circle
                    key={i}
                    cx={cx}
                    cy={cx}
                    r={r}
                    fill="none"
                    stroke={d.color}
                    strokeWidth={thickness}
                    strokeDasharray={dash}
                    strokeDashoffset={-offset}
                    strokeLinecap="butt"
                  />
                );
                offset += len;
                return el;
              })}
            </g>
          )}
        </svg>
        <div className="donut-center">
          <strong>{centerValue ?? total}</strong>
          {centerLabel && <span>{centerLabel}</span>}
        </div>
      </div>
      {legend && (
        <ul className="chart-legend">
          {items.map((d, i) => (
            <li key={i} className={d.onClick ? 'chart-click' : undefined} onClick={d.onClick}
              role={d.onClick ? 'button' : undefined} title={d.onClick ? `Open ${d.label}` : undefined}>
              <span className="lg-dot" style={{ background: d.color }} />
              <span className="lg-label">{d.label}</span>
              <span className="lg-val">{d.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BarChart — vertical bars for comparing categories.
 * ------------------------------------------------------------------ */
export function BarChart({ data, height = 168 }: { data: Datum[]; height?: number }) {
  const items = data.map((d, i) => ({ ...d, value: num(d.value), color: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const max = Math.max(1, ...items.map(d => d.value));
  const hasData = items.some(d => d.value > 0);
  if (!hasData) return <ChartEmpty height={height} />;

  return (
    <div className="chart-bars" style={{ height }}>
      {items.map((d, i) => {
        const h = Math.max(2, (d.value / max) * 100);
        return (
          <div className={`bar-col ${d.onClick ? 'chart-click' : ''}`} key={i} onClick={d.onClick}
            role={d.onClick ? 'button' : undefined} title={d.onClick ? `Open ${d.label}` : d.label}>
            <span className="bar-val">{d.value}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ height: `${h}%`, background: `linear-gradient(180deg, ${d.color}, ${d.color}99)` }} />
            </div>
            <span className="bar-label" title={d.label}>{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BarMeter — labelled horizontal bars (great for ranked counts).
 * ------------------------------------------------------------------ */
export function BarMeter({ data }: { data: Datum[] }) {
  const items = data.map((d, i) => ({ ...d, value: num(d.value), color: d.color ?? CHART_COLORS[i % CHART_COLORS.length] }));
  const max = Math.max(1, ...items.map(d => d.value));

  return (
    <ul className="chart-meter">
      {items.map((d, i) => (
        <li key={i} className={d.onClick ? 'chart-click' : undefined} onClick={d.onClick}
          role={d.onClick ? 'button' : undefined} title={d.onClick ? `Open ${d.label}` : undefined}>
          <div className="meter-head">
            <span className="meter-label">{d.label}</span>
            <span className="meter-val">{d.value}</span>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${(d.value / max) * 100}%`, background: `linear-gradient(90deg, ${d.color}AA, ${d.color})` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * RadialGauge — a single value against a max as a sweeping arc.
 * ------------------------------------------------------------------ */
export function RadialGauge({
  value,
  max,
  label,
  sublabel,
  color = CHART_COLORS[0],
  size = 150,
}: {
  value: number | null | undefined;
  max: number | null | undefined;
  label?: string;
  sublabel?: string;
  color?: string;
  size?: number;
}) {
  const v = num(value);
  const m = Math.max(1, num(max));
  const pct = Math.min(1, v / m);
  const thickness = 14;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  // 270° sweep starting bottom-left.
  const sweep = 0.75;
  const c = 2 * Math.PI * r;
  const arcLen = c * sweep;
  const dash = `${arcLen * pct} ${c}`;
  const trackDash = `${arcLen} ${c}`;

  return (
    <div className="chart-gauge" style={{ width: size }}>
      <div className="gauge-svg" style={{ width: size, height: size * 0.82 }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          <g transform={`rotate(135 ${cx} ${cx})`}>
            <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={thickness} strokeDasharray={trackDash} strokeLinecap="round" />
            <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth={thickness} strokeDasharray={dash} strokeLinecap="round" />
          </g>
        </svg>
        <div className="gauge-center">
          <strong>{v}</strong>
          {label && <span>{label}</span>}
        </div>
      </div>
      {sublabel && <span className="gauge-sub">{sublabel}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sparkline / area trend — for ordered numeric series.
 * ------------------------------------------------------------------ */
export function Sparkline({
  data,
  height = 56,
  color = CHART_COLORS[0],
  fill = true,
}: {
  data: (number | null | undefined)[];
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  const pts = data.map(num);
  if (pts.length < 2) return <ChartEmpty height={height} />;
  const w = 100;
  const max = Math.max(1, ...pts);
  const min = Math.min(0, ...pts);
  const range = max - min || 1;
  const step = w / (pts.length - 1);
  const coords = pts.map((p, i) => [i * step, height - ((p - min) / range) * (height - 6) - 3]);
  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(' ');
  const area = `${line} L${w},${height} L0,${height} Z`;
  const id = `spark-${color.replace('#', '')}`;

  return (
    <svg className="chart-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * ChartCard — a titled container so charts sit consistently in grids.
 * ------------------------------------------------------------------ */
export function ChartCard({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card chart-card ${className}`}>
      <div className="chart-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="chart-card-body">{children}</div>
    </div>
  );
}
