import { useCallback, useEffect, useRef, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { FileText, ExternalLink, Download, Upload, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { api, API_BASE, getToken, type OfficeFileChangedPayload, errorText } from '../services/api';

/* ============================================================================
   OPENING A CONTROLLED DOCUMENT IN MICROSOFT OFFICE

   A Word file belongs to Word. The in-app preview rendered an approximation of
   one — text and tables, but not diagrams, headers or pagination — and let
   people edit that approximation, so the controlled record and what they read
   could drift. An Office file now goes to Office and the record is whatever
   Office saved.

   Two routes. At the host machine the desktop application copies the file to a
   scratch folder, hands it to the OS, and watches it for saves. Over the LAN or
   the internet Word is given a URL it can open and save back to — the
   `ms-word:ofe|u|…` scheme against this host's WebDAV endpoint
   (server/routes/officeEdit.ts). Where neither is available: download, edit,
   upload. All three land as a new attributed version.

   The panel itself says as little as possible. Somebody opening an SOP knows
   what a Word file is; what they need is the filename, one button, and — once
   it is open — whether their last save arrived.
   ========================================================================= */

export type OfficeSession = {
  token: string; fileName: string; url: string; officeUri: string; appName: string;
  expiresAt: string; expiresInHours: number;
  /** True when the handoff opens the file for reading and cannot save back. */
  readOnly?: boolean;
};

/** Is this a file Office should own, rather than something we preview? */
export function isOfficeDocument(fileName?: string | null, mime?: string | null): boolean {
  if (/\.(docx?|dotx?|xlsx?|xlsm|xltx?|pptx?|potx?|rtf|odt|ods|odp)$/i.test(fileName || '')) return true;
  return [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ].includes(mime || '');
}

/** The application a file will land in, so the button can say so. */
export function officeAppName(fileName?: string | null, mime?: string | null): string {
  const ext = (fileName?.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (/^(xls|xlsx|xlsm|xlt|xltx|ods|csv)$/.test(ext) || /spreadsheet|ms-excel/.test(mime || '')) return 'Microsoft Excel';
  if (/^(ppt|pptx|pot|potx|odp)$/.test(ext) || /presentation|ms-powerpoint/.test(mime || '')) return 'Microsoft PowerPoint';
  return 'Microsoft Word';
}

type Phase = 'idle' | 'opening' | 'open' | 'saving' | 'failed';

export type RoundTripOptions = {
  docId: number;
  versionId: number;
  fileId: number;
  fileName: string;
  fileMime?: string | null;
  /** Auto-open on mount. The Office panel does; a PDF, which reads in place, does not. */
  autoOpen?: boolean;
  /**
   * May this person write a new version back? Reading a Word file always means
   * opening it in Word — there is nowhere else to read it — so opening is
   * governed by the right to read the document. Saving back is not, and when
   * this is false the save paths are not wired up at all.
   */
  canSaveBack?: boolean;
  /** Called with the id of the version a save created, so the viewer follows it. */
  onSavedVersion: (versionId: number) => void;
  onError: (message: string) => void;
};

/**
 * The round trip out to a native application and back, without any of the
 * screen around it.
 *
 * A Word file needs this because it has nowhere else to be read; a PDF needs it
 * only when somebody chooses to leave — it reads perfectly well in place. Both
 * want identical behaviour once they do leave, so the behaviour lives here and
 * the two screens differ only in what they draw.
 */
export function useOfficeRoundTrip(opts: RoundTripOptions) {
  const { docId, versionId, fileId, fileName, fileMime, autoOpen = false, canSaveBack = false, onSavedVersion, onError } = opts;
  const appName = officeAppName(fileName, fileMime);
  // The desktop application can hand the file to the OS directly; a browser has
  // to go through the URL handoff.
  const onDesktop = typeof window !== 'undefined' && !!window.sechLims?.openInOffice;

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [session, setSession] = useState<OfficeSession | null>(null);
  const [watchId, setWatchId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const autoOpened = useRef(false);

  const fetchBlobUrl = useCallback(async (path: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
    return URL.createObjectURL(await res.blob());
  }, []);

  async function downloadCopy() {
    try {
      const url = await fetchBlobUrl(`/files/${fileId}/download`);
      const a = document.createElement('a');
      a.href = url; a.download = fileName || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 8000);
    } catch (e) { onError(errorText(e)); }
  }

  // ---- The desktop route: hand the file to the OS and watch it ------------
  const openOnDesktop = useCallback(async () => {
    if (!window.sechLims?.openInOffice) return;
    setPhase('opening'); setMessage(null);
    try {
      const meta = await api<{ storage_area: string; stored_name: string; original_name: string }>(`/files/${fileId}/meta`);
      const result = await window.sechLims.openInOffice({
        storageArea: meta.storage_area, storedName: meta.stored_name,
        originalName: meta.original_name || fileName || 'document', docId, versionId,
      });
      if (!result.ok || !result.watchId) {
        setPhase('failed');
        setMessage(result.error || `Could not open the file in ${appName}.`);
        return;
      }
      setWatchId(result.watchId);
      setPhase('open');
      setMessage(null);
    } catch (e) { setPhase('failed'); setMessage(errorText(e)); }
  }, [appName, docId, fileId, fileName, versionId]);

  // Each save from Office arrives here as bytes and goes straight back in as a
  // new version, through the same endpoints a manual upload uses.
  useEffect(() => {
    // No watcher for a reader: every save it caught would be pushed at an API
    // that would refuse it, and the person would be told their reading had
    // failed. Word opened the file read-only; nothing is coming back.
    if (!canSaveBack) return;
    if (!watchId || !window.sechLims?.onOfficeFileChanged) return;
    const unsubscribe = window.sechLims.onOfficeFileChanged(async (payload: OfficeFileChangedPayload) => {
      if (payload.watchId !== watchId) return;
      setPhase('saving');
      try {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array(payload.bytes)], { type: payload.mimeGuess || 'application/octet-stream' }), payload.originalName);
        const token = getToken();
        const fr = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
        if (!fr.ok) throw new Error((await fr.json().catch(() => ({ error: fr.statusText }))).error ?? fr.statusText);
        const file = await fr.json();
        const label = `word-${new Date().toISOString().slice(0, 10)}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`;
        const created = await api<{ id: number }>(`/documents/${docId}/versions`, {
          method: 'POST',
          body: JSON.stringify({ versionNumber: label, fileId: file.id, revisionSummary: `Saved from ${appName}`, makeCurrent: true }),
        });
        setSaves(n => n + 1);
        setLastSavedAt(new Date().toISOString());
        setPhase('open');
        onSavedVersion(created.id);
      } catch (e) { setPhase('open'); onError(errorText(e)); }
    });
    return unsubscribe;
  }, [watchId, canSaveBack, docId, appName, onSavedVersion, onError]);

  // ---- The browser route: hand Office a URL it can save back to -----------
  const openInBrowser = useCallback(async () => {
    setPhase('opening'); setMessage(null);
    try {
      const s = await api<OfficeSession>(`/documents/${docId}/versions/${versionId}/office-session`, { method: 'POST', body: JSON.stringify({}) });
      setSession(s);
      setPhase('open');
      // A link click, not a location change: an unregistered `ms-word:` handler
      // then simply does nothing instead of navigating the application away.
      const a = document.createElement('a');
      a.href = s.officeUri; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setPhase('failed'); setMessage(errorText(e)); }
  }, [docId, versionId]);

  // Word saves over the wire without telling this page, so the handoff is
  // asked how it is getting on and the viewer follows what Office wrote.
  useEffect(() => {
    if (!session) return;
    let stopped = false;
    const seen = { saves: 0 };
    const tick = async () => {
      try {
        const s = await api<{ active: boolean; saves: number; lastSavedAt: string | null; versionId: number | null }>(`/documents/office-session/${session.token}`);
        if (stopped || !s.active) return;
        if (s.saves > seen.saves) {
          seen.saves = s.saves;
          setSaves(s.saves);
          setLastSavedAt(s.lastSavedAt);
          if (s.versionId) onSavedVersion(s.versionId);
        }
      } catch { /* a poll that fails is retried on the next tick */ }
    };
    const timer = window.setInterval(tick, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [session, onSavedVersion]);

  const open = onDesktop ? openOnDesktop : openInBrowser;

  // Where the native application is the only way to read the file, opening the
  // document opens the document — it does not wait to be asked twice.
  useEffect(() => {
    if (autoOpened.current || !autoOpen) return;
    autoOpened.current = true;
    void open();
  }, [open, autoOpen]);

  function finish() {
    if (watchId) window.sechLims?.stopOfficeWatch?.(watchId);
    if (session) void api(`/documents/office-session/${session.token}`, { method: 'DELETE' }).catch(() => undefined);
    setWatchId(null); setSession(null); setPhase('idle'); setMessage(null);
  }
  // Leaving the viewer must not leave a watcher or a live URL behind.
  useEffect(() => () => {
    if (watchId) window.sechLims?.stopOfficeWatch?.(watchId);
    if (session) void api(`/documents/office-session/${session.token}`, { method: 'DELETE' }).catch(() => undefined);
  }, [watchId, session]);

  async function checkNow() {
    if (watchId && window.sechLims?.checkOfficeNow) {
      setMessage('Checking for a saved change…');
      const r = await window.sechLims.checkOfficeNow(watchId);
      if (!r.ok) setMessage(r.error || 'Could not check for changes.');
      else setMessage(null);
    }
  }

  // The fallback that always works: edit the downloaded copy in whatever is
  // installed, then put it back.
  async function uploadEdited(file: File) {
    setUploading(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const token = getToken();
      const fr = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
      if (!fr.ok) throw new Error((await fr.json().catch(() => ({ error: fr.statusText }))).error ?? fr.statusText);
      const uploaded = await fr.json();
      const label = `edited-${new Date().toISOString().slice(0, 10)}-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`;
      const created = await api<{ id: number }>(`/documents/${docId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ versionNumber: label, fileId: uploaded.id, revisionSummary: 'Edited outside SECH_LIMS and uploaded', makeCurrent: true }),
      });
      setSaves(n => n + 1);
      setLastSavedAt(new Date().toISOString());
      onSavedVersion(created.id);
    } catch (e) { onError(errorText(e)); }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; }
  }

  const live = phase === 'open' || phase === 'saving';
  const shortApp = appName.replace('Microsoft ', '');

  return {
    phase, message, saves, lastSavedAt, session, uploading, uploadInput,
    onDesktop, appName, shortApp, live,
    open, finish, checkNow, downloadCopy, uploadEdited,
  };
}

/** Bytes, the way a file manager writes them. */
function fileSizeLabel(bytes?: number | null): string | null {
  if (!bytes) return null;
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * The screen a Word, Excel or PowerPoint document shows instead of a preview:
 * what the file is, one button, and — once it is open — whether the last save
 * arrived. Nothing else; the document itself is in Office.
 */
export default function OfficeHandoff(props: {
  docId: number;
  versionId: number;
  fileId: number;
  fileName: string;
  fileMime?: string | null;
  versionLabel?: string | null;
  fileSize?: number | null;
  /**
   * May this person write a new version back? Opening the file is not gated on
   * this — a Word document has no in-app preview, so opening it in Word IS
   * reading it, and anybody who may read the document may do that. This governs
   * the save-back controls only.
   */
  canEdit: boolean;
  onSavedVersion: (versionId: number) => void;
  onError: (message: string) => void;
}) {
  const { can } = usePermissions();
  const { fileName, versionLabel, fileSize, canEdit } = props;
  // Auto-open for everybody who reaches this panel: they reached it by opening
  // a document, and the document is in Word. It used to auto-open only for an
  // author, so a reader was shown a card with a lone Download button — which
  // is not "the document opened".
  const rt = useOfficeRoundTrip({ ...props, autoOpen: true, canSaveBack: canEdit });
  const {
    phase, message, saves, lastSavedAt, uploading, uploadInput,
    onDesktop, shortApp, live, open, finish, checkNow, downloadCopy, uploadEdited,
  } = rt;

  const meta = [versionLabel, fileSizeLabel(fileSize), shortApp].filter(Boolean).join(' · ');

  return <div className="oh">
    <div className="oh-card">
      <div className="oh-icon"><FileText size={26} /></div>
      <h3 className="oh-name" title={fileName}>{fileName}</h3>
      {meta && <p className="oh-meta">{meta}</p>}

      <div className="oh-actions">
        <button type="button" className="oh-primary" onClick={open} disabled={phase === 'opening'}>
          {phase === 'opening' ? <><Loader2 size={16} className="spin" /> Opening…</> : <><ExternalLink size={16} /> Open in {shortApp}</>}
        </button>
        {can('documents.authoring', 'create') && can('documents.library', 'view') && can('documents.library', 'create') && <button type="button" className="secondary" onClick={downloadCopy}><Download size={15} /> Download</button>}
        {canEdit && <>
          <button type="button" className="secondary" onClick={() => uploadInput.current?.click()} disabled={uploading}>
            <Upload size={15} /> {uploading ? 'Uploading…' : 'Upload edit'}
          </button>
          <input ref={uploadInput} type="file" style={{ display: 'none' }}
            accept=".doc,.docx,.rtf,.odt,.xls,.xlsx,.ppt,.pptx,.pdf"
            onChange={e => { const f = e.target.files?.[0]; if (f) void uploadEdited(f); }} />
        </>}
      </div>

      {/* Once it is open the only question is whether the last save arrived. */}
      {live && <div className="oh-state">
        {phase === 'saving'
          ? <><Loader2 size={13} className="spin" /> Saving…</>
          : saves > 0
            ? <><CheckCircle2 size={13} /> Saved{lastSavedAt ? ` ${new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}{saves > 1 ? ` · ${saves} versions` : ''}</>
            : <><span className="oh-dot" /> Opened in {shortApp}{canEdit ? '' : ' · read-only'}</>}
        <span style={{ flex: 1 }} />
        {onDesktop && <button type="button" className="oh-link" onClick={checkNow}><RefreshCw size={12} /> Check now</button>}
        <button type="button" className="oh-link" onClick={finish}>Done</button>
      </div>}

      {phase === 'failed' && <div className="oh-warn">
        <p>{message || `${shortApp} did not open.`}</p>
        <p className="muted">{onDesktop ? 'Use Download, then Upload edit.' : `No ${shortApp} handler on this device — use Download, then Upload edit.`}</p>
      </div>}

      {phase !== 'failed' && message && <div className="oh-note">{message}</div>}
    </div>
  </div>;
}
