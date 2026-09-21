// Where a risk sits in its lifecycle, shown wherever a stage is being worked.
// The same steps every risk travels, in the same order, so a user always knows
// what has happened and what happens next.

export const RISK_STEPS = [
  { key: 'identification', label: 'Identification' },
  { key: 'analysis', label: 'Assessment' },
  { key: 'evaluation', label: 'Evaluation' },
  { key: 'treatment', label: 'Control' },
  { key: 'residual', label: 'Residual risk' },
  { key: 'acceptance', label: 'Acceptance' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'closed', label: 'Closure' },
];

export default function RiskStepper({ active }: { active: string }) {
  const idx = RISK_STEPS.findIndex(s => s.key === active);
  return <div className="risk-steps">
    {RISK_STEPS.map((s, i) => <span key={s.key}>
      <span className={`risk-step${i === idx ? ' is-current' : i < idx ? ' is-done' : ''}`}>
        {i < idx ? '✓ ' : ''}{s.label}
      </span>
      {i < RISK_STEPS.length - 1 && <span className="risk-steps-arrow">→</span>}
    </span>)}
  </div>;
}
