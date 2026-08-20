import { useEffect, useState } from 'react';
import { api, API_BASE, getToken } from '../services/api';
import type { CapaRecord, ComplaintEvent, ComplaintRecord, NonconformingEvent, RiskRecord, Section, Staff } from '../../shared/types/api';

// Shared vocabulary and helpers for the quality modules (nonconformities,
// incidents, CAPA, complaints and risks) so every register speaks the same
// visual language.

export async function openPrintWindow(path: string, onError: (m: string) => void) {
  try {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error(await res.text() || res.statusText);
    const w = window.open('', '_blank'); if (!w) { onError('Allow pop-ups to open the report.'); return; }
    w.document.open(); w.document.write(await res.text()); w.document.close();
  } catch (e) { onError((e as Error).message); }
}

export const NC_TYPE_OPTIONS = [
  { v: 'pre_analytical', l: 'Pre-analytical (sample collection, labelling, transport)' },
  { v: 'analytical', l: 'Analytical (equipment malfunction, reagent issue, SOP deviation)' },
  { v: 'post_analytical', l: 'Post-analytical (reporting error, result communication)' },
  { v: 'safety_environment', l: 'Safety / Environment (spill, exposure, waste handling)' },
  { v: 'other', l: 'Other' },
];

export const RCA_METHOD_OPTIONS = [
  { v: '5_whys', l: '5 Whys' }, { v: 'fishbone', l: 'Fishbone (Ishikawa)' },
  { v: 'pareto', l: 'Pareto analysis' }, { v: 'fault_tree', l: 'Fault tree' }, { v: 'other', l: 'Other' },
];

export type RecordLink = { id: number; source_module_key: string; source_record_type: string; source_record_id: string; target_module_key: string; target_record_type: string; target_record_id: string; notes?: string };
export type NonconformingEventDetail = NonconformingEvent & { links?: RecordLink[] };
export type CapaDetail = CapaRecord & { links?: RecordLink[]; updates?: { id: number; update_date: string; update_text: string; status: string }[] };
export type ComplaintDetail = ComplaintRecord & { links?: RecordLink[]; events?: ComplaintEvent[]; targets?: { acknowledgeDays: number; resolveDays: number } };
export type RiskDetail = RiskRecord & { links?: RecordLink[]; reviews?: { id: number; review_date: string; review_notes: string; risk_score: number; risk_level: string; next_review_date?: string }[] };
export type LoadState = { loading: boolean; error: string | null };

/** Laboratory-wide workflow configuration + this user's capabilities. */
export type WorkflowConfig = {
  remedialActionEnabled: boolean;
  autoEscalateRiskLevel: 'off' | 'moderate' | 'high' | 'very_high';
  autoEscalatePatientSafety: boolean;
  autoCreateCapaOnEscalation: boolean;
  canFollowUp: boolean;
  canCreate: boolean;
  canAmend: boolean;
  amendRoles: string[];
};

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  remedialActionEnabled: true, autoEscalateRiskLevel: 'high', autoEscalatePatientSafety: true,
  autoCreateCapaOnEscalation: true, canFollowUp: true, canCreate: true, canAmend: false, amendRoles: [],
};

export function useWorkflowConfig() {
  const [config, setConfig] = useState<WorkflowConfig>(DEFAULT_WORKFLOW_CONFIG);
  useEffect(() => { api<WorkflowConfig>('/nonconformities/config').then(c => setConfig({ ...DEFAULT_WORKFLOW_CONFIG, ...c })).catch(() => {}); }, []);
  return config;
}

export const badgeStyles: Record<string, string> = {
  open: 'badge badge--blue',
  reviewed: 'badge badge--info',
  capa_required: 'badge badge--warning',
  closed: 'badge badge--success',
  in_progress: 'badge badge--warning',
  completed: 'badge badge--info',
  verified: 'badge badge--success',
  effectiveness_pending: 'badge badge--warning',
  reopened: 'badge badge--danger',
  overdue: 'badge badge--danger',
  new: 'badge badge--info',
  assigned: 'badge badge--warning',
  investigating: 'badge badge--warning',
  action_required: 'badge badge--warning',
  active: 'badge badge--info',
  mitigation_in_progress: 'badge badge--warning',
  review_due: 'badge badge--warning',
  pending: 'badge badge--warning',
  reported: 'badge badge--info',
  under_investigation: 'badge badge--warning',
  effective: 'badge badge--success',
  not_effective: 'badge badge--danger',
};

export const capaSourceLabel = (c: { source_module?: string | null; nc_id?: number | null; incident_id?: number | null; complaint_id?: number | null; risk_id?: number | null }) => {
  const m = (c.source_module || '').toLowerCase();
  if (m === 'nonconformities' || c.nc_id) return 'Nonconformity';
  if (m === 'incidents' || c.incident_id) return 'Incident';
  if (m === 'complaints' || c.complaint_id) return 'Complaint';
  if (m === 'risks' || c.risk_id) return 'Risk';
  return 'Manual';
};

export const formatBadge = (status: string | undefined) => {
  if (!status) return <span className="badge">Unknown</span>;
  return <span className={badgeStyles[status] || 'badge'}>{status.replace(/_/g, ' ')}</span>;
};

export const toDisplay = (value: unknown) => (value || value === 0 ? String(value) : '—');

/** Short, human date (falls back to a dash). */
export const fmtDate = (v: unknown) => (v ? String(v).slice(0, 10) : '—');

export function useLookupData() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);

  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
  }, []);

  return { staff, sections };
}

/** Empty-state row used across the registers so they read consistently. */
export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return <tr><td colSpan={colSpan} className="muted" style={{ textAlign: 'center', padding: '18px 8px' }}>{children}</td></tr>;
}
