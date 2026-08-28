import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import type {
  MyProfile, MyTasks, MyDeclarations, StaffDocument, NotificationRecord,
  StaffSuggestionsResponse, UserTaskQueueItem, ReviewCalendarItem, StaffCpdRecord,
  JobDescriptionDoc,
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
  licence_expiry_date?: string | null;
  signature_file_id?: number | null; photo_file_id?: number | null;
  date_of_birth?: string | null; gender?: string | null;
  national_id_type?: string | null; national_id_number?: string | null;
  emergency_contact?: string | null; emergency_contact_phone?: string | null;
  emergency_contact_relation?: string | null; staff_file_location?: string | null;
};

/**
 * The details a member of staff may change about themselves.
 *
 * This mirrors the server's own list exactly (`SELF_EDITABLE_STAFF_FIELDS` in
 * server/routes/personnel.ts). It is repeated here rather than imported
 * because the two answer different questions — the server decides what is
 * allowed, this decides what to draw — but they must not drift, so any change
 * to one belongs in the other.
 */
export type SelfEditableProfile = {
  phone?: string; email?: string; dateOfBirth?: string; gender?: string;
  nationalIdType?: string; nationalIdNumber?: string;
  emergencyContact?: string; emergencyContactPhone?: string; emergencyContactRelation?: string;
  qualifications?: string; professionalRegulator?: string;
  professionalLicence?: string; licenceExpiryDate?: string;
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
  cpd: StaffCpdRecord[];
  jobDescriptions: JobDescriptionDoc[];
  hasSignature: boolean;
  signatureUrl: string | null;
  photoUrl: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  setNotice: (message: string | null) => void;
  setError: (message: string | null) => void;
  reload: () => Promise<void>;
  reloadInbox: () => Promise<void>;
  uploadSignature: (file: File) => Promise<void>;
  uploadPhoto: (file: File) => Promise<void>;
  removePhoto: () => Promise<void>;
  saveProfile: (patch: SelfEditableProfile) => Promise<void>;
  linkStaff: (staffId: number) => Promise<void>;
};

/**
 * The faces of the portal.
 *
 * Declared here rather than on the page because more than the page needs to
 * name one: a notification opened in place may offer "take me to my training",
 * and the drawer that offers it must not import the page that mounts it.
 */
export type PortalFace =
  | 'Portal' | 'My Tasks' | 'Routine Work' | 'My Inbox' | 'My Schedule' | 'My Record'
  | 'My Documents' | 'My Training' | 'My Declarations' | 'Preferences';

export const PORTAL_FACES: PortalFace[] = [
  'Portal', 'My Tasks', 'Routine Work', 'My Inbox', 'My Schedule', 'My Record',
  'My Documents', 'My Training', 'My Declarations', 'Preferences',
];

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
  const [cpd, setCpd] = useState<StaffCpdRecord[]>([]);
  const [jobDescriptions, setJobDescriptions] = useState<JobDescriptionDoc[]>([]);
  const [hasSignature, setHasSignature] = useState(false);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [photoStamp, setPhotoStamp] = useState(0);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
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
    const prof = await api<MyProfile>('/personnel/my-profile').catch(e => { setError(errorText(e)); return null; });
    if (prof) { setProfile(prof); setError(null); }
    await Promise.all([
      api<MyTasks>('/personnel/my-tasks').then(setTasks).catch(() => undefined),
      api<MyDeclarations>('/personnel/my-declarations').then(setDeclarations).catch(() => undefined),
      api<StaffDocument[]>('/personnel/my-documents').then(setDocuments).catch(() => undefined),
      api<StaffCpdRecord[]>('/personnel/my-training').then(setCpd).catch(() => setCpd([])),
      // The job description for the post they hold, read straight from the
      // document register — not a copy of it.
      api<JobDescriptionDoc[]>('/personnel/my-job-descriptions').then(setJobDescriptions).catch(() => setJobDescriptions([])),
      api<UserTaskQueueItem[]>('/notifications/tasks?mine=true').then(setQueue).catch(() => setQueue([])),
      // The review calendar is laboratory-wide and gated on its own feature;
      // the portal keeps only the rows naming this person, and simply shows
      // nothing when they may not read it.
      api<ReviewCalendarItem[]>('/notifications/calendar').then(setCalendar).catch(() => setCalendar([])),
      api<{ hasSignature: boolean }>('/signatures/me').then(r => setHasSignature(!!r.hasSignature)).catch(() => setHasSignature(false)),
      reloadInbox(),
    ]);
    // Re-fetch the photograph whenever the file is reloaded, so a replacement
    // taken a moment ago is the one on screen.
    setPhotoStamp(n => n + 1);
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

  // The photograph is a private file too, and is fetched the same way. The
  // stamp in the dependency list is what makes "replace picture" show the new
  // one immediately rather than the browser's cached copy of the old.
  useEffect(() => {
    if (!profile?.staff) { setPhotoUrl(null); return; }
    let url: string | null = null;
    let live = true;
    const token = getToken();
    fetch(`${API_BASE}/personnel/my-photo/image`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error('none'))))
      .then(blob => { url = URL.createObjectURL(blob); if (live) setPhotoUrl(url); })
      .catch(() => setPhotoUrl(null));
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [profile?.staff, photoStamp]);

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

  const uploadPhoto = useCallback(async (file: File) => {
    setError(null);
    // Reduced to passport proportions before it leaves the browser, so what
    // reaches the server is already the right shape and a fraction of the cap.
    const passport = await toPassportPhoto(file);
    const form = new FormData();
    form.append('file', passport, passport.name);
    const token = getToken();
    const res = await fetch(`${API_BASE}/personnel/my-photo`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
    setPhotoStamp(n => n + 1);
    setNotice('Profile picture saved.');
  }, []);

  const removePhoto = useCallback(async () => {
    setError(null);
    await api('/personnel/my-photo', { method: 'DELETE' });
    setPhotoUrl(null);
    setPhotoStamp(n => n + 1);
    setNotice('Profile picture removed.');
  }, []);

  const saveProfile = useCallback(async (patch: SelfEditableProfile) => {
    setError(null);
    await api('/personnel/my-profile', { method: 'PUT', body: JSON.stringify(patch) });
    await reload();
    setNotice('Your details have been updated.');
  }, [reload]);

  const linkStaff = useCallback(async (staffId: number) => {
    setError(null);
    await api('/personnel/link-my-staff', { method: 'POST', body: JSON.stringify({ staffId }) });
    await reload();
    setNotice('Your account is now linked to your staff record.');
  }, [reload]);

  const staff = (profile?.staff as unknown as PortalStaff | null) ?? null;

  const value = useMemo<PortalData>(() => ({
    profile, staff, tasks, declarations, documents, inbox, queue, calendar, suggestions, cpd, jobDescriptions,
    hasSignature, signatureUrl, photoUrl, loading, error, notice,
    setNotice, setError, reload, reloadInbox,
    uploadSignature, uploadPhoto, removePhoto, saveProfile, linkStaff,
  }), [profile, staff, tasks, declarations, documents, inbox, queue, calendar, suggestions, cpd, jobDescriptions,
    hasSignature, signatureUrl, photoUrl, loading, error, notice, reload, reloadInbox,
    uploadSignature, uploadPhoto, removePhoto, saveProfile, linkStaff]);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

/* ============================================================================
   Passport photograph
   ----------------------------------------------------------------------------
   A phone camera produces a 4 MB landscape photograph. A personnel file wants
   a small portrait of a face at passport proportions. Asking people to crop
   and resize one into the other before uploading is asking most of them not to
   bother, so the browser does it: centre-crop to the passport ratio, scale to
   a sensible print size, and re-encode as JPEG.

   35 x 45 mm is the passport standard nearly everywhere, which is 7:9. At
   420 x 540 that is a shade over 300 dpi at the printed size — enough for an
   ID badge, and typically well under 100 KB, so the 2 MB server cap is a
   backstop rather than something anyone meets.
   ========================================================================= */
export const PASSPORT_MAX_BYTES = 2 * 1024 * 1024;
const PASSPORT_W = 420;
const PASSPORT_H = 540;

export async function toPassportPhoto(file: File): Promise<File> {
  if (!/^image\//.test(file.type)) throw new Error('A profile picture must be an image file.');
  if (file.size > PASSPORT_MAX_BYTES * 8) throw new Error('That picture is far too large. Choose one under 16 MB.');

  const bitmap = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = PASSPORT_W;
  canvas.height = PASSPORT_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;   // no canvas: send the original and let the cap decide

  // Centre-crop the largest passport-shaped rectangle the picture contains,
  // biased slightly towards the top — a face sits above the middle of a photo,
  // and cropping to the exact centre is how you cut off the top of a head.
  const targetRatio = PASSPORT_W / PASSPORT_H;
  const sourceRatio = bitmap.width / bitmap.height;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sourceRatio > targetRatio) sw = Math.round(bitmap.height * targetRatio);
  else sh = Math.round(bitmap.width / targetRatio);
  const sx = Math.round((bitmap.width - sw) / 2);
  const sy = Math.round((bitmap.height - sh) * 0.35);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PASSPORT_W, PASSPORT_H);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, PASSPORT_W, PASSPORT_H);
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close();

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) return file;
  if (blob.size > PASSPORT_MAX_BYTES) throw new Error('A profile picture must be 2 MB or smaller.');
  const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${base}-passport.jpg`, { type: 'image/jpeg' });
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That file could not be read as an image.'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
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
