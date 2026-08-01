import type { CSSProperties } from 'react';
// 5x5 risk assessment matrix picker (SECHFO005 / ISO 22367). Click a cell to set
// Occurrence (row) × Severity (column); the score and risk level are computed and
// shown. Shared by Nonconformity and Incident/Adverse Event management.

export const SEVERITY = [
  { score: 1, label: 'Negligible', description: 'No patient impact, minor inconvenience' },
  { score: 2, label: 'Minor', description: 'Delay, rework needed, no harm' },
  { score: 3, label: 'Moderate', description: 'Potential impact on patient care, regulatory issue' },
  { score: 4, label: 'Critical', description: 'Likely patient harm, serious safety risk' },
  { score: 5, label: 'Catastrophic', description: 'Patient death, major system failure' },
];
export const OCCURRENCE = [
  { score: 1, label: 'Rare', description: 'Has not occurred before, first time' },
  { score: 2, label: 'Unlikely', description: 'Has occurred before but not expected' },
  { score: 3, label: 'Occasional', description: 'Intermittent occurrence' },
  { score: 4, label: 'Likely', description: 'Probable to occur' },
  { score: 5, label: 'Frequent', description: 'Occurs always' },
];
export const RISK_BANDS = [
  { level: 'low', label: 'Low', min: 1, max: 4, action: 'Acceptable — document and monitor.', color: '#1a7f37' },
  { level: 'moderate', label: 'Medium', min: 5, max: 9, action: 'Acceptable with controls — document and investigate.', color: '#c9a227' },
  { level: 'high', label: 'High', min: 10, max: 16, action: 'Unacceptable — corrective action required.', color: '#e8590c' },
  { level: 'very_high', label: 'Very High', min: 17, max: 25, action: 'Critical — stop the process, immediate management attention.', color: '#c1121f' },
];
export function bandFor(score: number) { return RISK_BANDS.find(b => score >= b.min && score <= b.max) || null; }
export function riskLevelBadge(level?: string | null) {
  const b = RISK_BANDS.find(x => x.level === level);
  if (!b) return <span className="badge">—</span>;
  return <span style={{ background: b.color, color: '#fff', fontWeight: 700, fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>{b.label}</span>;
}

export default function RiskMatrix({ occurrence, severity, onChange }: {
  occurrence: number | null; severity: number | null; onChange: (occurrence: number, severity: number) => void;
}) {
  const score = occurrence && severity ? occurrence * severity : null;
  const band = score ? bandFor(score) : null;
  return <div>
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 11, minWidth: 620 }}>
        <thead>
          <tr>
            <th style={{ ...cellHead, minWidth: 120 }}>Occurrence&nbsp;↓ / Severity&nbsp;→</th>
            {SEVERITY.map(s => <th key={s.score} style={{ ...cellHead, minWidth: 92 }} title={s.description}>{s.score}. {s.label}<div style={{ fontWeight: 400, fontSize: 9, opacity: 0.8 }}>{s.description}</div></th>)}
          </tr>
        </thead>
        <tbody>
          {OCCURRENCE.slice().reverse().map(o => <tr key={o.score}>
            <th style={{ ...cellHead, textAlign: 'left', minWidth: 120 }} title={o.description}>{o.score}. {o.label}<div style={{ fontWeight: 400, fontSize: 9, opacity: 0.8 }}>{o.description}</div></th>
            {SEVERITY.map(s => {
              const sc = o.score * s.score; const b = bandFor(sc)!;
              const active = occurrence === o.score && severity === s.score;
              return <td key={s.score} onClick={() => onChange(o.score, s.score)} title={`${b.label} risk`}
                style={{ border: '1px solid #999', textAlign: 'center', cursor: 'pointer', padding: '8px 4px', fontWeight: 700, color: '#fff', background: b.color, opacity: active ? 1 : 0.55, outline: active ? '3px solid #111' : 'none', outlineOffset: -3 }}>
                {sc}<div style={{ fontSize: 9, fontWeight: 400 }}>{b.label}</div>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div style={{ marginTop: 8, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>Risk score (O×S): {score ?? '—'}</strong>
      {band && <span style={{ background: band.color, color: '#fff', fontWeight: 700, padding: '2px 10px', borderRadius: 4 }}>{band.label} risk</span>}
      {band && <span className="muted" style={{ fontSize: 12 }}>{band.action}</span>}
    </div>
  </div>;
}
const cellHead: CSSProperties = { border: '1px solid #999', background: '#eef2f7', color: '#111', padding: '4px 6px', fontWeight: 700, textAlign: 'center', verticalAlign: 'middle' };
