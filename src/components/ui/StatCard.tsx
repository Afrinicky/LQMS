import type { ReactNode } from 'react';

/**
 * StatCard — a polished KPI tile with optional icon and trend delta.
 * Falls back to an em dash when a value is null/undefined.
 */
export default function StatCard({
  label,
  value,
  icon,
  hint,
  delta,
  trend = 'flat',
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  hint?: string;
  delta?: string;
  trend?: 'up' | 'down' | 'flat';
}) {
  const display = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div className="card stat-card">
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-ico">{icon}</span>}
      </div>
      <div className="stat-value">{display}</div>
      {delta && <span className={`stat-delta ${trend}`}>{delta}</span>}
      {hint && <span className="stat-label">{hint}</span>}
    </div>
  );
}
