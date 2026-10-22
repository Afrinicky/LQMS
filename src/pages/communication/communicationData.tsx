import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiRead, errorText } from '../../services/api';
import type {
  Communication, CommunicationAudience, CommunicationAudienceOption, CommunicationLogRow,
  CommunicationSummary, CommunicationTemplate, CommunicationThread, Staff,
} from '../../../shared/types/api';
import {
  COMMUNICATION_TYPE_LABELS, CHANNEL_LABELS, DELIVERY_STATUS_LABELS,
  COMMUNICATION_STATUS_LABELS, DIRECTION_LABELS, DISPATCH_METHOD_LABELS,
  type CommunicationType, type CommunicationChannel, type DeliveryStatus,
  type CommunicationStatus, type CommunicationDirection, type DispatchMethod,
} from '../../../shared/constants/communications';

/**
 * The data layer behind the Communication workspace.
 *
 * Four tabs read from the same handful of endpoints, so the loading lives here
 * rather than four times over. Everything is a plain hook: the workspace is a
 * tab inside Information Management, not a route of its own, so it cannot rely
 * on a provider being mounted above it.
 */

/* ---------------------------------------------------------------- labels */

export const typeLabel = (value?: string | null) =>
  COMMUNICATION_TYPE_LABELS[(value ?? '') as CommunicationType] ?? pretty(value);
export const channelLabel = (value?: string | null) =>
  CHANNEL_LABELS[(value ?? '') as CommunicationChannel] ?? pretty(value);
export const deliveryLabel = (value?: string | null) =>
  DELIVERY_STATUS_LABELS[(value ?? '') as DeliveryStatus] ?? pretty(value);
export const statusLabel = (value?: string | null) =>
  COMMUNICATION_STATUS_LABELS[(value ?? '') as CommunicationStatus] ?? pretty(value);
export const directionLabel = (value?: string | null) =>
  DIRECTION_LABELS[(value ?? '') as CommunicationDirection] ?? pretty(value);
export const methodLabel = (value?: string | null) =>
  DISPATCH_METHOD_LABELS[(value ?? '') as DispatchMethod] ?? pretty(value);

export function pretty(value?: string | null): string {
  if (!value) return '—';
  return String(value).replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

/** A timestamp as a reader wants it: the date and the time, no timezone noise. */
export function stamp(value?: string | null): string {
  if (!value) return '—';
  return String(value).slice(0, 16).replace('T', ' ');
}

/** "4 min ago" for anything today, the date and time for anything older. */
export function relative(value?: string | null): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return stamp(value);
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 10080) return `${Math.round(minutes / 1440)} d ago`;
  return stamp(value);
}

/** The tone a status or priority carries in the tables and chips. */
export function toneFor(row: { status?: string; priority?: string }): 'crit' | 'warn' | 'ok' | 'info' {
  if (row.priority === 'urgent') return 'crit';
  if (row.status === 'pending_approval' || row.priority === 'high') return 'warn';
  if (row.status === 'sent' || row.status === 'received' || row.status === 'approved') return 'ok';
  return 'info';
}

export const badge = (value?: string | null) =>
  <span className={`badge ${String(value ?? 'unknown').toLowerCase().replace(/\s+/g, '-')}`}>{pretty(value)}</span>;

/* ------------------------------------------------------------- audiences */

/**
 * The audiences a sender may address, grouped the way the picker shows them.
 *
 * The server does the resolving and the counting, because "All laboratory
 * staff (42)" is a sender checking they mean it, and the client has no
 * business holding the staff register to work that out.
 */
export function useAudienceOptions(enabled: boolean) {
  const [options, setOptions] = useState<CommunicationAudienceOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    apiRead<CommunicationAudienceOption[]>('/communications/audience-options', [])
      .then(setOptions).catch(() => setOptions([])).finally(() => setLoading(false));
  }, [enabled]);

  const groups = useMemo(() => {
    const order = ['laboratory_staff', 'all_users', 'audience_group', 'department', 'section', 'position', 'role', 'stakeholder_group', 'user', 'staff', 'stakeholder'];
    const titles: Record<string, string> = {
      laboratory_staff: 'Everyone', all_users: 'Everyone', audience_group: 'Configured audiences',
      department: 'Departments', section: 'Units', position: 'Positions', role: 'Access profiles',
      stakeholder_group: 'Stakeholder groups', user: 'Individual users', staff: 'Individual staff',
      stakeholder: 'Individual stakeholders',
    };
    const map = new Map<string, { title: string; items: CommunicationAudienceOption[] }>();
    for (const kind of order) {
      const title = titles[kind] ?? pretty(kind);
      if (!map.has(title)) map.set(title, { title, items: [] });
      map.get(title)!.items.push(...options.filter(o => o.kind === kind));
    }
    return [...map.values()].filter(g => g.items.length > 0);
  }, [options]);

  return { options, groups, loading };
}

export type AudiencePick = { kind: string; ref: string | null; label: string };

export function sameAudience(a: AudiencePick, b: { kind: string; ref: string | null }) {
  return a.kind === b.kind && String(a.ref ?? '') === String(b.ref ?? '');
}

/* --------------------------------------------------------------- loading */

export function useCommunicationWorkspace(active: boolean) {
  const [summary, setSummary] = useState<CommunicationSummary | null>(null);
  const [threads, setThreads] = useState<CommunicationThread[]>([]);
  const [templates, setTemplates] = useState<CommunicationTemplate[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sum, th, tpl, st] = await Promise.all([
        apiRead<CommunicationSummary | null>('/communications/summary', null),
        apiRead<CommunicationThread[]>('/communications/threads', []),
        apiRead<CommunicationTemplate[]>('/communications/templates', []),
        apiRead<Staff[]>('/staff', []),
      ]);
      setSummary(sum); setThreads(th); setTemplates(tpl); setStaff(st);
    } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { if (active) void load(); }, [active, load]);

  return { summary, threads, templates, staff, error, setError, reload: load };
}

export async function loadThread(id: number): Promise<CommunicationThread & { messages: Communication[] }> {
  return api<CommunicationThread & { messages: Communication[] }>(`/communications/threads/${id}`);
}

export async function loadLog(query: Record<string, string>): Promise<CommunicationLogRow[]> {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null));
  const suffix = params.toString();
  return apiRead<CommunicationLogRow[]>(`/communications/log${suffix ? `?${suffix}` : ''}`, []);
}

export async function loadAudiences(): Promise<CommunicationAudience[]> {
  return apiRead<CommunicationAudience[]>('/communications/audiences', []);
}

export function post<T = unknown>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
export function put<T = unknown>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}
