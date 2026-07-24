/** Shared mobile form/UI primitives used by the capture and inventory screens. */
import type { ReactNode } from 'react';

export const today = () => new Date().toISOString().slice(0, 10);
export const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export const ICO = {
  back: 'M15 18l-6-6 6-6',
  check: 'M20 6 9 17l-5-5',
};

/** Minimal multi-path icon: splits the path string on "M" sub-paths. */
export const Ico = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
  </svg>
);

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="m-field"><label className="m-lbl">{label}</label>{children}{hint && <div className="m-fieldhint">{hint}</div>}</div>;
}

export type Msg = { kind: 'ok' | 'queued' | 'err'; msg: string } | null;

export function Result({ r }: { r: Msg }) {
  if (!r) return null;
  const cls = r.kind === 'err' ? 'err' : r.kind === 'queued' ? 'queued' : 'ok';
  return <div className={`m-result ${cls}`}>{r.kind === 'ok' && <Ico d={ICO.check} size={16} />}<span>{r.msg}</span></div>;
}

export function Back({ onBack }: { onBack: () => void }) {
  return <button className="m-back" onClick={onBack}><Ico d={ICO.back} size={18} /> Back</button>;
}
