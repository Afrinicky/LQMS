// 5x5 risk assessment matrix picker. Click a cell to set the row (occurrence /
// likelihood) and the column (severity); the score and band are computed and
// shown. The scales and bands are overridable so every module can render the
// same picker with the laboratory's own risk criteria.

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

export type MatrixStep = { score: number; label: string; description?: string };
export type MatrixBand = { level: string; label: string; min: number; max: number; action: string; color: string };

export function bandFor(score: number, bands: MatrixBand[] = RISK_BANDS) {
  return bands.find(b => score >= b.min && score <= b.max) || null;
}
export function riskLevelBadge(level?: string | null, bands: MatrixBand[] = RISK_BANDS) {
  const b = bands.find(x => x.level === level);
  if (!b) return <span className="badge">—</span>;
  return <span style={{ background: b.color, color: '#fff', fontWeight: 700, fontSize: 11, padding: '2px 8px', borderRadius: 4 }}>{b.label}</span>;
}

export default function RiskMatrix({
  occurrence, severity, onChange, rows = OCCURRENCE, columns = SEVERITY, bands = RISK_BANDS,
  rowLabel = 'Occurrence', columnLabel = 'Severity', scoreLabel,
}: {
  occurrence: number | null; severity: number | null; onChange: (occurrence: number, severity: number) => void;
  rows?: MatrixStep[]; columns?: MatrixStep[]; bands?: MatrixBand[];
  rowLabel?: string; columnLabel?: string; scoreLabel?: string;
}) {
  const score = occurrence && severity ? occurrence * severity : null;
  const band = score ? bandFor(score, bands) : null;
  return <div>
    <div style={{ overflowX: 'auto' }}>
      <table className="risk-matrix">
        <thead>
          <tr>
            <th style={{ minWidth: 130 }}>{rowLabel}&nbsp;↓ / {columnLabel}&nbsp;→</th>
            {columns.map(s => <th key={s.score} style={{ minWidth: 92 }} title={s.description}>
              {s.score}. {s.label}{s.description && <small>{s.description}</small>}
            </th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice().reverse().map(o => <tr key={o.score}>
            <th style={{ textAlign: 'left', minWidth: 130 }} title={o.description}>
              {o.score}. {o.label}{o.description && <small>{o.description}</small>}
            </th>
            {columns.map(s => {
              const sc = o.score * s.score; const b = bandFor(sc, bands);
              const active = occurrence === o.score && severity === s.score;
              return <td key={s.score} onClick={() => onChange(o.score, s.score)} title={`${b?.label ?? ''} risk`}
                data-active={active ? 'true' : 'false'}
                style={{ background: b?.color ?? '#999', opacity: active ? 1 : 0.62 }}>
                {sc}<span>{b?.label}</span>
              </td>;
            })}
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="risk-matrix-foot">
      <strong>{scoreLabel ?? `Risk score (${rowLabel.charAt(0)}×${columnLabel.charAt(0)})`}: {score ?? '—'}</strong>
      {band && <span className="risk-matrix-band" style={{ background: band.color }}>{band.label} risk</span>}
      {band && <span className="muted" style={{ fontSize: 12 }}>{band.action}</span>}
    </div>
  </div>;
}
