import { Suspense, lazy, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSignature, Loader2, X } from 'lucide-react';
import { api, API_BASE, getToken } from '../../services/api';
import { downloadFileById, titleCase, usePortal } from './portalData';
import type { MyDeclaration } from '../../../shared/types/api';

/**
 * Doing the work, without leaving the portal.
 *
 * The portal's first version told a member of staff exactly what they owed and
 * then sent them somewhere else to do it. That is most of the way to useless:
 * the whole reason the list is worth having is that the list is where the work
 * happens. Clicking "Read & sign" left the portal, loaded a module the person
 * may never have opened before, and dropped them on a tab to hunt for the row
 * they had just clicked on.
 *
 * So every kind of task the portal can raise now opens its own completion
 * surface here, over the portal, and closes back onto the list with the item
 * gone. Nothing navigates. The four kinds are genuinely different jobs —
 * signing a declaration is not attesting to a document, and neither is
 * reporting progress on an action — so this is a switch over four small
 * purpose-built panels rather than one form pretending to fit them all.
 */

// Document control's viewer, borrowed. It already renders a controlled
// document, its versions and the "I have read & understood" control, and it is
// lazy so the portal does not carry it for everyone who never attests.
const DocumentViewer = lazy(() => import('../DocumentControlPage').then(m => ({ default: m.DocumentViewer })));

export type PortalTaskTarget =
  | { kind: 'declaration'; declaration: MyDeclaration }
  | { kind: 'attestation'; attestationId: number; documentId: number; versionId: number; title: string }
  | { kind: 'action'; id: number; title: string; description?: string | null; status: string; dueDate?: string | null }
  | { kind: 'queueTask'; id: number; title: string; description?: string | null; status: string };

/** Upload a file to my own record and return its id. Self-scoped, no rights needed. */
async function uploadPersonalFile(file: File, purpose: string): Promise<number> {
  const form = new FormData();
  form.append('file', file);
  form.append('purpose', purpose);
  const token = getToken();
  const res = await fetch(`${API_BASE}/personnel/my-upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return Number((await res.json()).id);
}

export default function PortalTaskDrawer({ target, onClose }: { target: PortalTaskTarget; onClose: (completed?: boolean) => void }) {
  // Escape closes it, like every other overlay in the application.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The document viewer is a window in its own right and brings its own frame.
  if (target.kind === 'attestation') {
    return (
      <Suspense fallback={<div className="portal-drawer-wrap"><div className="portal-drawer"><p className="muted">Opening the document…</p></div></div>}>
        <AttestationTask target={target} onClose={onClose} />
      </Suspense>
    );
  }

  return (
    <div className="portal-drawer-wrap" role="dialog" aria-modal="true" onClick={() => onClose(false)}>
      <div className="portal-drawer" onClick={e => e.stopPropagation()}>
        {target.kind === 'declaration' && <DeclarationTask declaration={target.declaration} onClose={onClose} />}
        {target.kind === 'action' && <ActionTask target={target} onClose={onClose} />}
        {target.kind === 'queueTask' && <QueueTask target={target} onClose={onClose} />}
      </div>
    </div>
  );
}

function DrawerHead({ eyebrow, title, onClose }: { eyebrow: string; title: string; onClose: () => void }) {
  return (
    <div className="pd-head">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
      </div>
      <button type="button" className="pd-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Sign a declaration
   ------------------------------------------------------------------------- */
function DeclarationTask({ declaration, onClose }: { declaration: MyDeclaration; onClose: (completed?: boolean) => void }) {
  const { reload, setNotice, setError } = usePortal();
  const d = declaration;
  const [read, setRead] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [conflictDetails, setConflictDetails] = useState('');
  const [notes, setNotes] = useState('');
  const [signedFile, setSignedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A declaration issued as a form file (no text in the app) is signed on the
  // paper: download it, sign it, attach the signed copy. One with text in the
  // app is acknowledged in the app. The server enforces the same rule.
  const fileOnly = Boolean(d.file_id) && !d.body_content;
  const blocked = !read || (fileOnly && !signedFile) || (conflict && !conflictDetails.trim());

  async function sign() {
    setBusy(true); setProblem(null);
    try {
      const signedFileId = signedFile ? await uploadPersonalFile(signedFile, 'signed_declaration') : undefined;
      await api(`/organisation/ethical-forms/${d.id}/sign`, {
        method: 'POST',
        body: JSON.stringify({
          signedFileId,
          conflictDeclared: conflict,
          conflictDetails: conflict ? conflictDetails.trim() : null,
          affirmationText: d.acknowledgement_statement ?? null,
          notes: notes.trim() || null,
        }),
      });
      await reload();
      setNotice(`Signed: ${d.title}.`);
      onClose(true);
    } catch (e) {
      setProblem((e as Error).message);
      setError(null);
    } finally { setBusy(false); }
  }

  return (
    <>
      <DrawerHead eyebrow={`${titleCase(d.form_type)} · v${d.version || '—'}`} title={d.title} onClose={() => onClose(false)} />
      <div className="pd-body">
        {d.body_content
          ? <div className="pd-doc">{d.body_content}</div>
          : (
            <div className="pd-fileonly">
              <p>This declaration was issued as a form. Download it, sign it, then attach the signed copy below.</p>
              {d.file_id && (
                <button type="button" className="secondary" onClick={() => downloadFileById(d.file_id!, d.file_name || `${d.form_number || 'declaration'}.pdf`).catch(e => setProblem((e as Error).message))}>
                  <Download size={14} /> Download the form
                </button>
              )}
            </div>
          )}

        {d.acknowledgement_statement && <p className="pd-ack">{d.acknowledgement_statement}</p>}

        <div className="pd-form">
          <label className="pd-check">
            <input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} />
            <span>I have read and understood this declaration, and I agree to be bound by it.</span>
          </label>

          <label className="pd-check">
            <input type="checkbox" checked={conflict} onChange={e => setConflict(e.target.checked)} />
            <span>I have a conflict of interest to declare.</span>
          </label>
          {conflict && (
            <label className="pd-field">
              <span>What is the conflict? <em>Required</em></span>
              <textarea value={conflictDetails} onChange={e => setConflictDetails(e.target.value)} rows={3}
                placeholder="Describe the interest, who it involves, and how it could affect your work." />
            </label>
          )}

          {fileOnly && (
            <label className="pd-field">
              <span>Signed copy <em>Required</em></span>
              <input type="file" accept=".pdf,image/*,.doc,.docx"
                onChange={e => setSignedFile(e.target.files?.[0] ?? null)} />
              {signedFile && <small className="pd-hint">{signedFile.name}</small>}
            </label>
          )}

          <label className="pd-field">
            <span>Anything to note (optional)</span>
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
          </label>
        </div>

        {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
      </div>

      <div className="pd-foot">
        <button type="button" disabled={blocked || busy} onClick={() => void sign()}>
          {busy ? <><Loader2 size={14} className="pd-spin" /> Signing…</> : <><FileSignature size={14} /> Sign this declaration</>}
        </button>
        <button type="button" className="secondary" onClick={() => onClose(false)}>Not now</button>
        {!read && <span className="pd-hint">Confirm you have read it before signing.</span>}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Read and attest to a controlled document
   ------------------------------------------------------------------------- */
function AttestationTask({ target, onClose }: {
  target: Extract<PortalTaskTarget, { kind: 'attestation' }>;
  onClose: (completed?: boolean) => void;
}) {
  const { reload, setNotice, setError } = usePortal();

  async function attest(attestationId: number, documentId: number) {
    try {
      await api(`/documents/${documentId}/attest`, { method: 'POST', body: JSON.stringify({ attestationId }) });
      await reload();
      setNotice('Attestation signed. It is recorded against the document.');
      onClose(true);
    } catch (e) { setError((e as Error).message); onClose(false); }
  }

  return (
    <DocumentViewer
      docId={target.documentId}
      versionId={target.versionId}
      attestationId={target.attestationId}
      onClose={() => onClose(false)}
      onAttest={(attId, docId) => void attest(attId, docId)}
      onSaved={() => undefined}
      onError={setError}
    />
  );
}

/* ----------------------------------------------------------------------------
   Report progress on an action assigned to me
   ------------------------------------------------------------------------- */
const ASSIGNEE_STATUSES = ['In progress', 'Waiting for evidence', 'Submitted for review', 'Completed'];

function ActionTask({ target, onClose }: {
  target: Extract<PortalTaskTarget, { kind: 'action' }>;
  onClose: (completed?: boolean) => void;
}) {
  const { reload, setNotice } = usePortal();
  const [status, setStatus] = useState(ASSIGNEE_STATUSES.includes(target.status) ? target.status : 'In progress');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    setBusy(true); setProblem(null);
    try {
      await api(`/actions/${target.id}/my-progress`, {
        method: 'POST',
        body: JSON.stringify({ status, completionNotes: notes.trim() || undefined }),
      });
      await reload();
      setNotice(status === 'Completed' ? `Marked done: ${target.title}.` : `Updated: ${target.title} — ${status}.`);
      onClose(true);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <DrawerHead eyebrow={`Action · currently ${target.status}`} title={target.title} onClose={() => onClose(false)} />
      <div className="pd-body">
        {target.description && <p className="pd-desc">{target.description}</p>}
        {target.dueDate && <p className="pd-meta">Due {target.dueDate}</p>}

        <div className="pd-form">
          <div className="pd-field">
            <span>Where has it got to?</span>
            <div className="pd-choices">
              {ASSIGNEE_STATUSES.map(s => (
                <button key={s} type="button" className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s}</button>
              ))}
            </div>
          </div>
          <label className="pd-field">
            <span>What did you do? {status === 'Completed' && <em>Worth recording</em>}</span>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
              placeholder="What you did, what you found, anything the person who raised it needs to know." />
          </label>
          <p className="pd-hint">
            Verifying and closing an action belong to whoever raised it — your update tells them it is ready.
          </p>
        </div>

        {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
      </div>
      <div className="pd-foot">
        <button type="button" disabled={busy} onClick={() => void save()}>
          {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : <><CheckCircle2 size={14} /> Save my update</>}
        </button>
        <button type="button" className="secondary" onClick={() => onClose(false)}>Cancel</button>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Start or complete a queue task
   ------------------------------------------------------------------------- */
function QueueTask({ target, onClose }: {
  target: Extract<PortalTaskTarget, { kind: 'queueTask' }>;
  onClose: (completed?: boolean) => void;
}) {
  const { reload, setNotice } = usePortal();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(action: 'start' | 'complete') {
    setBusy(action); setProblem(null);
    try {
      await api(`/notifications/tasks/${target.id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      await reload();
      setNotice(action === 'complete' ? `Completed: ${target.title}.` : `Started: ${target.title}.`);
      onClose(true);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <DrawerHead eyebrow={`Task · ${titleCase(target.status)}`} title={target.title} onClose={() => onClose(false)} />
      <div className="pd-body">
        {target.description ? <p className="pd-desc">{target.description}</p> : <p className="muted">No further detail was given with this task.</p>}
      </div>
      <div className="pd-foot">
        {target.status === 'open' && (
          <button type="button" className="secondary" disabled={!!busy} onClick={() => void act('start')}>
            {busy === 'start' ? 'Starting…' : 'I have started it'}
          </button>
        )}
        <button type="button" disabled={!!busy} onClick={() => void act('complete')}>
          {busy === 'complete' ? <><Loader2 size={14} className="pd-spin" /> Completing…</> : <><CheckCircle2 size={14} /> Mark it done</>}
        </button>
        <button type="button" className="secondary" onClick={() => onClose(false)}>Not now</button>
        {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
      </div>
    </>
  );
}

export { uploadPersonalFile };
