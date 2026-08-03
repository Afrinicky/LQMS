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
        background: i === idx ? 'var(--primary, #2563eb)' : i < idx ? '#e6f4ea' : 'var(--surface-2, #eef1f6)',
        color: i === idx ? '#fff' : i < idx ? '#1a7f37' : 'var(--muted, #667)' }}>{i < idx ? '✓ ' : ''}{s.label}</span>
      {i < steps.length - 1 && <span style={{ color: 'var(--muted, #99a)', fontSize: 12 }}>→</span>}
    </span>)}
  </div>;
}
