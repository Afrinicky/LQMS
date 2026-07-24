/**
 * Offline-aware submit + outbox for the mobile companion (M2).
 *
 * Field staff often capture data where there is no signal (cold rooms, plant
 * areas). submit() posts immediately when online; on a network failure — or when
 * the device is offline — it queues the request in localStorage and returns
 * { queued: true }. Queued items flush automatically on reconnect and on app
 * load. A genuine server rejection (validation/permission) is re-thrown so the
 * form can show it, rather than being silently queued.
 */
import { api } from '../src/services/api';

const OUTBOX_KEY = 'sech_m_outbox';
export const OUTBOX_EVENT = 'sech-m-outbox';

export interface Queued { id: string; label: string; path: string; body: unknown; at: number; }

export function readOutbox(): Queued[] {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]') as Queued[]; } catch { return []; }
}
function writeOutbox(q: Queued[]) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(q));
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}
export function outboxCount(): number { return readOutbox().length; }

function enqueue(label: string, path: string, body: unknown) {
  const q = readOutbox();
  q.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), label, path, body, at: Date.now() });
  writeOutbox(q);
}

export interface SubmitResult { queued: boolean; data?: unknown; }

/** POST that survives no connectivity. Throws only on real server rejections. */
export async function submit(path: string, body: unknown, label: string): Promise<SubmitResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    enqueue(label, path, body);
    return { queued: true };
  }
  try {
    const data = await api<unknown>(path, { method: 'POST', body: JSON.stringify(body) });
    return { queued: false, data };
  } catch (e) {
    // fetch() rejects with a TypeError on network failure — queue those. A server
    // that answered with an error status throws a normal Error — surface it.
    if (e instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      enqueue(label, path, body);
      return { queued: true };
    }
    throw e;
  }
}

/**
 * Attach a photo (or any file) as evidence to a just-created record. Uploads to
 * the Host's generic evidence endpoint, which links it by (module, type, id).
 * Online-only: a File cannot be meaningfully queued, so photos are attached only
 * when the record was saved live. Throws on failure so the caller can degrade
 * gracefully (the record itself is already saved).
 */
export async function uploadEvidence(file: File, moduleKey: string, recordType: string, recordId: number | string, notes?: string): Promise<void> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('moduleKey', moduleKey);
  fd.append('recordType', recordType);
  fd.append('recordId', String(recordId));
  if (notes) fd.append('notes', notes);
  await api('/evidence', { method: 'POST', body: fd });
}

/** Drain queued submissions. Keeps items that still fail on the network. */
export async function flushOutbox(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const q = readOutbox();
  if (!q.length) return;
  const remaining: Queued[] = [];
  for (const item of q) {
    try { await api(item.path, { method: 'POST', body: JSON.stringify(item.body) }); }
    catch (e) {
      // Re-queue on network failure; drop on a permanent server rejection so a
      // bad item cannot wedge the queue forever.
      if (e instanceof TypeError) remaining.push(item);
    }
  }
  writeOutbox(remaining);
}
