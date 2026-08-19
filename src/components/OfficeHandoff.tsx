import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, ExternalLink, Download, Upload, CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { api, API_BASE, getToken, type OfficeFileChangedPayload } from '../services/api';

/* ============================================================================
   OPENING A CONTROLLED DOCUMENT IN MICROSOFT OFFICE

   A Word document belongs in Word. The application used to render its own
   approximation of one — text and tables, but not the diagrams, the headers,
   the exact pagination a laboratory's accredited SOP is laid out in — and
   offered editing in that approximation, which meant the controlled record and
   what people actually saw could drift apart. So for a Word, Excel or
   PowerPoint file the preview is gone: opening it opens it in Office, and the
   record is whatever Office saved.

   Two routes, one screen:

     · At the host machine (the desktop application) the file is copied to a
       scratch folder, handed to the operating system's default application,
       and watched. Every save is picked up and uploaded as a new version.

     · Over the LAN or the internet the browser cannot reach the disk, so the
       document is handed to Office as a URL it can open AND save back to — the
       `ms-word:ofe|u|…` scheme against this host's own small WebDAV endpoint
       (server/routes/officeEdit.ts). Word saves straight into the register.

   Where neither applies — a machine with no Office, a phone — the same panel
   offers the honest fallback: download it, edit it in whatever is installed,
   and put the edited file back. All three end in the same place: a new,
   attributed version of the controlled document.
   ========================================================================= */

export type OfficeSession = {
  token: string; fileName: string; url: string; officeUri: string; appName: string;
  expiresAt: string; expiresInHours: number;
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

export default function OfficeHandoff(props: {
  docId: number;
  versionId: number;
  fileId: number;
  fileName: string;
  fileMime?: string | null;
  /** May this person write a new version, or are they only allowed to read it? */
  canEdit: boolean;
  /** Called with the id of the version a save created, so the viewer follows it. */
  onSavedVersion: (versionId: number) => void;
  onError: (message: string) => void;
}) {
  const { docId, versionId, fileId, fileName, fileMime, canEdit, onSavedVersion, onError } = props;
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
    } catch (e) { onError((e as Error).message); }
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
    } catch (e) { setPhase('failed'); setMessage((e as Error).message); }
  }, [appName, docId, fileId, fileName, versionId]);

  // Each save from Office arrives here as bytes and goes straight back in as a
  // new version, through the same endpoints a manual upload uses.
  useEffect(() => {
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
      } catch (e) { setPhase('open'); onError((e as Error).message); }
    });
    return unsubscribe;
  }, [watchId, docId, appName, onSavedVersion, onError]);

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
    } catch (e) { setPhase('failed'); setMessage((e as Error).message); }
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

  // Opening the document opens the document. The whole point of this screen is
  // that a Word file goes to Word, so it does not wait to be asked twice.
  useEffect(() => {
    if (autoOpened.current || !canEdit) return;
    autoOpened.current = true;
    void open();
  }, [open, canEdit]);

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
    } catch (e) { onError((e as Error).message); }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; }
  }

  const live = phase === 'open' || phase === 'saving';

  return <div className="oh">
    <div className="oh-card">
      <div className="oh-icon"><FileText size={30} /></div>
      <h3 className="oh-name" title={fileName}>{fileName}</h3>
      <p className="oh-lead">
        {canEdit
          ? <>This is a {appName} document, so it opens in {appName} — with its diagrams, headers and layout exactly as they were approved. Anything you save there comes straight back here as a new version of this document.</>
          : <>This is a {appName} document. You may open a copy to read; saving a new version of a controlled document needs authoring rights.</>}
      </p>

      <div className="oh-actions">
        {canEdit && <button type="button" className="oh-primary" onClick={open} disabled={phase === 'opening'}>
          {phase === 'opening' ? <><Loader2 size={16} className="spin" /> Opening…</> : <><ExternalLink size={16} /> Open in {appName}</>}
        </button>}
        <button type="button" className="secondary" onClick={downloadCopy}><Download size={15} /> Download a copy</button>
        {canEdit && <>
          <button type="button" className="secondary" onClick={() => uploadInput.current?.click()} disabled={uploading}>
            <Upload size={15} /> {uploading ? 'Uploading…' : 'Upload an edited copy'}
          </button>
          <input ref={uploadInput} type="file" style={{ display: 'none' }}
            accept=".doc,.docx,.rtf,.odt,.xls,.xlsx,.ppt,.pptx,.pdf"
            onChange={e => { const f = e.target.files?.[0]; if (f) void uploadEdited(f); }} />
        </>}
      </div>

      {/* One line of state, never a wall of instructions. */}
      {live && <div className="oh-state">
        {phase === 'saving'
          ? <><Loader2 size={14} className="spin" /> Saving what {appName} wrote…</>
          : saves > 0
            ? <><CheckCircle2 size={14} /> Saved {saves === 1 ? 'once' : `${saves} times`}{lastSavedAt ? ` · last at ${new Date(lastSavedAt).toLocaleTimeString()}` : ''} — this document now points at the newest version.</>
            : <><CheckCircle2 size={14} /> Open in {appName}. Save there and it lands here automatically{onDesktop ? '' : ' — keep this window open while you edit'}.</>}
        <span style={{ flex: 1 }} />
        {onDesktop && <button type="button" className="oh-link" onClick={checkNow}><RefreshCw size={12} /> Check now</button>}
        <button type="button" className="oh-link" onClick={finish}><X size={12} /> Done editing</button>
      </div>}

      {phase === 'failed' && <div className="oh-warn">
        <p>{message || `Could not open the document in ${appName}.`}</p>
        <p className="muted">
          {onDesktop
            ? 'Check that Office is installed on this machine, or download the copy above and put the edited file back.'
            : `If nothing happened, this browser has no ${appName} handler installed. Download the copy above, edit it, then upload the edited copy — it becomes the next version just the same.`}
        </p>
      </div>}

      {phase !== 'failed' && message && <div className="oh-note">{message}</div>}

      {!onDesktop && session && <p className="oh-fine">
        The link handed to {appName} works for {session.expiresInHours} hours and opens this document only. “Done editing” ends it immediately.
      </p>}
    </div>
  </div>;
}
