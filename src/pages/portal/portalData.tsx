import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, API_BASE, getToken } from '../../services/api';
import type {
  MyProfile, MyTasks, MyDeclarations, StaffDocument, NotificationRecord,
  StaffSuggestionsResponse, UserTaskQueueItem, ReviewCalendarItem,
} from '../../../shared/types/api';

/**
 * Everything My Portal knows about the signed-in person, fetched once.
 *
 * The portal is one interface with several faces, and every face counts the
 * same things: the landing tiles show "4 to sign", the Declarations face lists
 * those four. Fetching per face is how those two numbers start disagreeing in
 * front of a member of staff, so there is one load here and every panel reads
 * from it.
 *
 * Every endpoint below is self-scoped — the server matches the caller against
 * their own staff record and returns nothing about anybody else — which is why
 * the portal opens for the whole laboratory and needs no module rights.
 */

/** The staff row as `my-profile` returns it (straight from the table, snake_case). */
export type PortalStaff = {
  id: number; full_name?: string; employee_no?: string; email?: string; phone?: string;
  section_name?: string | null; designation?: string | null; job_title?: string | null;
  appointment_date?: string | null; appointment_type?: string | null;
  personnel_category?: string | null; qualifications?: string | null;
  professional_regulator?: string | null; professional_licence?: string | null;
  signature_file_id?: number | null; date_of_birth?: string | null;
  emergency_contact?: string | null; staff_file_location?: string | null;
};

export type PortalData = {
  profile: MyProfile | null;
  staff: PortalStaff | null;
  tasks: MyTasks | null;
  declarations: MyDeclarations;
  documents: StaffDocument[];
  inbox: NotificationRecord[];
  queue: UserTaskQueueItem[];
  calendar: ReviewCalendarItem[];
  suggestions: StaffSuggestionsResponse | null;
  hasSignature: boolean;
  signatureUrl: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
  reload: () => Promise<void>;
  reloadInbox: () => Promise<void>;
  uploadSignature: (file: File) => Promise<void>;
  linkStaff: (staffId: number) => Promise<void>;
};

const PortalContext = createContext<PortalData | undefined>(undefined);

const TODAY = () => new Date().toISOString().slice(0, 10);

/** Open items only — resolved and dismissed alerts are history, not work. */
export const isOpenAlert = (n: NotificationRecord) => n.status !== 'resolved' && n.status !== 'dismissed';

export function usePortal(): PortalData {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used inside PortalProvider');
  return ctx;
}

export function PortalProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [tasks, setTasks] = useState<MyTasks | null>(null);
  const [declarations, setDeclarations] = useState<MyDeclarations>({ signed: [], pending: [] });
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [inbox, setInbox] = useState<NotificationRecord[]>([]);
  const [queue, setQueue] = useState<UserTaskQueueItem[]>([]);
  const [calendar, setCalendar] = useState<ReviewCalendarItem[]>([]);
  const [suggestions, setSuggestions] = useState<StaffSuggestionsResponse | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reloadInbox = useCallback(async () => {
    const rows = await api<NotificationRecord[]>('/notifications?mine=true').catch(() => [] as NotificationRecord[]);
    setInbox(rows);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    // The profile is the one call the portal cannot do without: it decides
    // whether this account even has a staff record to show. Everything else
    // degrades to an empty panel rather than taking the page down with it.
    const prof = await api<MyProfile>('/personnel/my-profile').catch(e => { setError((e as Error).message); return null; });
    if (prof) { setProfile(prof); setError(null); }
    await Promise.all([
      api<MyTasks>('/personnel/my-tasks').then(setTasks).catch(() => undefined),
      api<MyDeclarations>('/personnel/my-declarations').then(setDeclarations).catch(() => undefined),
      api<StaffDocument[]>('/personnel/my-documents').then(setDocuments).catch(() => undefined),
      api<UserTaskQueueItem[]>('/notifications/tasks?mine=true').then(setQueue).catch(() => setQueue([])),
      // The review calendar is laboratory-wide and gated on its own feature;
      // the portal keeps only the rows naming this person, and simply shows
      // nothing when they may not read it.
      api<ReviewCalendarItem[]>('/notifications/calendar').then(setCalendar).catch(() => setCalendar([])),
      api<{ hasSignature: boolean }>('/signatures/me').then(r => setHasSignature(!!r.hasSignature)).catch(() => setHasSignature(false)),
      reloadInbox(),
    ]);
    if (prof && !prof.staff) api<StaffSuggestionsResponse>('/personnel/staff-suggestions').then(setSuggestions).catch(() => undefined);
    setLoading(false);
  }, [reloadInbox]);

  useEffect(() => { void reload(); }, [reload]);

  // The signature is a private file, so it is fetched with the session token
  // and held as an object URL rather than linked to directly.
  useEffect(() => {
    if (!hasSignature) { setSignatureUrl(null); return; }
    let url: string | null = null;
    let live = true;
    const token = getToken();
    fetch(`${API_BASE}/signatures/me/image`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('unavailable'))))
      .then(blob => { url = URL.createObjectURL(blob); if (live) setSignatureUrl(url); })
      .catch(() => setSignatureUrl(null));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [hasSignature]);

  const uploadSignature = useCallback(async (file: File) => {
    setError(null);
    const form = new FormData();
    form.append('file', file);
    const token = getToken();
    const res = await fetch(`${API_BASE}/signatures/me`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
    setHasSignature(false);          // force the image effect to re-run
    setTimeout(() => setHasSignature(true), 0);
    setNotice('Signature saved. It will now appear wherever you sign.');
  }, []);

  const linkStaff = useCallback(async (staffId: number) => {
    setError(null);
    await api('/personnel/link-my-staff', { method: 'POST', body: JSON.stringify({ staffId }) });
    await reload();
    setNotice('Your account is now linked to your staff record.');
  }, [reload]);

  const staff = (profile?.staff as unknown as PortalStaff | null) ?? null;

  const value = useMemo<PortalData>(() => ({
    profile, staff, tasks, declarations, documents, inbox, queue, calendar, suggestions,
    hasSignature, signatureUrl, loading, error, notice,
    setNotice, setError, reload, reloadInbox, uploadSignature, linkStaff,
  }), [profile, staff, tasks, declarations, documents, inbox, queue, calendar, suggestions,
    hasSignature, signatureUrl, loading, error, notice, reload, reloadInbox, uploadSignature, linkStaff]);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

/* ============================================================================
   Small shared helpers — the portal speaks about dates and counts constantly.
   ========================================================================= */

/** How a due date reads to the person who owes it. */
export function dueTone(dueDate?: string | null): { text: string; tone: 'crit' | 'warn' | 'ok' | 'muted' } | null {
  if (!dueDate) return null;
  const today = TODAY();
  const due = String(dueDate).slice(0, 10);
  if (due < today) {
    const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(due)) / 86400000));
    return { text: days === 1 ? '1 day overdue' : `${days} days overdue`, tone: 'crit' };
  }
  if (due === today) return { text: 'Due today', tone: 'warn' };
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86400000);
  if (days <= 7) return { text: days === 1 ? 'Due tomorrow' : `In ${days} days`, tone: 'ok' };
  return { text: due, tone: 'muted' };
}

export const isOverdue = (dueDate?: string | null) => Boolean(dueDate && String(dueDate).slice(0, 10) < TODAY());

export function initialsOf(name?: string | null): string {
  if (!name) return 'U';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

export function titleCase(value?: string | null): string {
  return String(value ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

/** Download a private file by id, using the session token. */
export async function downloadFileById(fileId: number, name: string) {
  const token = getToken();
  const r = await fetch(`${API_BASE}/files/${fileId}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the file.');
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
