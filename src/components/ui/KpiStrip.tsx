import type { ReactNode } from 'react';

export type KpiItem = {
  label: string;
  value: ReactNode;
  /** Optional accent for the value: 'danger' | 'warning' | 'success'. */
  tone?: 'danger' | 'warning' | 'success';
};

/**
 * KpiStrip — a single slim band of key numbers. Replaces the old grids of
 * large metric cards so every dashboard leads with one compact row of KPIs
 * and leaves the page to charts. Values fall back to an em dash.
 */
export default function KpiStrip({ items, flat = false }: { items: KpiItem[]; flat?: boolean }) {
  return (
    <div className={flat ? 'kpi-strip' : 'card kpi-strip'}>
      {items.map((item, i) => {
        const display = item.value === null || item.value === undefined || item.value === '' ? '—' : item.value;
        return (
          <div className={`kpi ${item.tone ? `t-${item.tone}` : ''}`} key={i}>
            <strong className="kpi-value">{display}</strong>
            <span className="kpi-label">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
