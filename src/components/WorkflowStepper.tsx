// A horizontal pipeline indicator so users always see where an event sits in the
// ISO nonconformity / incident lifecycle: Log → Risk assessment → (root cause) →
// CAPA → Closure. Shared by Nonconformity and Incident/Adverse Event management.

export default function WorkflowStepper({ active }: { active: string }) {
  const steps = [
    { key: 'log', label: 'Log event' },
    { key: 'risk_assessment', label: 'Risk assessment' },
    { key: 'rca', label: 'Root cause' },
    { key: 'capa', label: 'CAPA' },
    { key: 'closed', label: 'Closure' },
  ];
  const idx = steps.findIndex(s => s.key === active);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0 14px' }}>
    {steps.map((s, i) => <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: i === idx ? 700 : 500, padding: '3px 10px', borderRadius: 999,
        background: i === idx ? 'var(--accent)' : i < idx ? 'var(--success-bg)' : 'var(--panel-2)',
        color: i === idx ? 'var(--on-accent)' : i < idx ? 'var(--success)' : 'var(--muted)' }}>{i < idx ? '✓ ' : ''}{s.label}</span>
      {i < steps.length - 1 && <span style={{ color: 'var(--faint)', fontSize: 12 }}>→</span>}
    </span>)}
  </div>;
}
