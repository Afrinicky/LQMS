import { Suspense, lazy, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { AlertTriangle, Ban, Bell, CheckCircle2, Download, FileSignature, Loader2, PlayCircle, X } from 'lucide-react';
import { api, API_BASE, getToken } from '../../services/api';
import { useDutyReminders } from '../../hooks/useDutyReminders';
import { downloadFileById, dueTone, titleCase, usePortal, type PortalFace } from './portalData';
import type { ActivityOccurrence, MyDeclaration, NotificationRecord } from '../../../shared/types/api';

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
 * gone. Nothing navigates. The kinds are genuinely different jobs — signing a
 * declaration is not attesting to a document, and neither is reporting
 * progress on an action — so this is a switch over small purpose-built panels
 * rather than one form pretending to fit them all.
 *
 * The inbox opens through here too. An alert is a pointer at a record, and the
 * record it points at is usually one of the kinds above, so clicking an alert
 * lands on the same panel the task list would have opened. The alerts that
 * point at work the portal genuinely cannot do — an equipment calibration, an
 * IQC review — still open here, as a reader, and are acknowledged, resolved or
 * dismissed here. Only if the reader then asks to be taken to the module does
 * anything navigate, and only if they hold the rights to it.
 */

// Document control's viewer, borrowed. It already renders a controlled
// document, its versions and the "I have read & understood" control, and it is
// lazy so the portal does not carry it for everyone who never attests.
const DocumentViewer = lazy(() => import('../DocumentControlPage').then(m => ({ default: m.DocumentViewer })));

export type PortalTaskTarget =
  | { kind: 'declaration'; declaration: MyDeclaration }
  | { kind: 'attestation'; attestationId: number; documentId: number; versionId: number; title: string }
  | { kind: 'action'; id: number; title: string; description?: string | null; status: string; dueDate?: string | null }
  | { kind: 'queueTask'; id: number; title: string; description?: string | null; status: string }
  /** A recurring unit activity due today — completed here, in one press. */
  | { kind: 'occurrence'; occurrence: ActivityOccurrence }
  /** A controlled document to read. No signature is owed; this is the reader. */
  | { kind: 'document'; documentId: number; title: string }
  /**
   * An alert about work that lives elsewhere. Read here, dealt with here — see
   * `AlertTask` for why this exists and what it deliberately does not do.
   */
  | { kind: 'alert'; notification: NotificationRecord };

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

export default function PortalTaskDrawer({ target, onClose, onOpenFace }: {
  target: PortalTaskTarget;
  onClose: (completed?: boolean) => void;
  /** Step to another face of the portal — still the portal, never another module. */
  onOpenFace?: (face: PortalFace) => void;
}) {
  // Escape closes it, like every other overlay in the application.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The document viewer is a window in its own right and brings its own frame.
  if (target.kind === 'attestation' || target.kind === 'document') {
    return (
      <Suspense fallback={<div className="portal-drawer-wrap"><div className="portal-drawer"><p className="muted">Opening the document…</p></div></div>}>
        {target.kind === 'attestation'
          ? <AttestationTask target={target} onClose={onClose} />
          : <DocumentTask target={target} onClose={onClose} />}
      </Suspense>
    );
  }

  return (
    <div className="portal-drawer-wrap" role="dialog" aria-modal="true" onClick={() => onClose(false)}>
      <div className="portal-drawer" onClick={e => e.stopPropagation()}>
        {target.kind === 'declaration' && <DeclarationTask declaration={target.declaration} onClose={onClose} />}
        {target.kind === 'action' && <ActionTask target={target} onClose={onClose} />}
        {target.kind === 'queueTask' && <QueueTask target={target} onClose={onClose} />}
        {target.kind === 'occurrence' && <OccurrenceTask occurrence={target.occurrence} onClose={onClose} />}
        {target.kind === 'alert' && <AlertTask notification={target.notification} onClose={onClose} onOpenFace={onOpenFace} />}
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


/* ----------------------------------------------------------------------------
   Do today's unit activity
   ------------------------------------------------------------------------- */
/**
 * A recurring activity — a fridge temperature, a bench decontamination — raised
 * as an alert. These are the shortest jobs in the laboratory and the ones most
 * often skipped when recording them is a chore, so this panel is one press:
 * "Done", with a note only for whoever wants to leave one.
 */
function OccurrenceTask({ occurrence, onClose }: { occurrence: ActivityOccurrence; onClose: (completed?: boolean) => void }) {
  const { setNotice } = usePortal();
  const { complete, start, markNotApplicable, refresh } = useDutyReminders();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [showNa, setShowNa] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const o = occurrence;
  const open = o.status === 'pending' || o.status === 'in_progress';

  async function run(what: 'done' | 'start' | 'na') {
    setBusy(what); setProblem(null);
    try {
      if (what === 'done') await complete(o.id, { note: note.trim() || undefined });
      else if (what === 'start') await start(o.id);
      else await markNotApplicable(o.id, reason.trim());
      await refresh();
      setNotice(what === 'done' ? `Recorded: ${o.activity_name}.`
        : what === 'start' ? `Started: ${o.activity_name}.`
        : `Marked not applicable: ${o.activity_name}.`);
      onClose(true);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <DrawerHead
        eyebrow={[o.section_name, o.bench_name, o.occurrence_date].filter(Boolean).join(' · ') || 'Unit activity'}
        title={o.activity_name || 'Unit activity'}
        onClose={() => onClose(false)}
      />
      <div className="pd-body">
        {o.instructions ? <p className="pd-desc">{o.instructions}</p> : <p className="muted">No standing instruction was recorded for this one.</p>}
        {!open && <p className="pd-meta">Already {o.status === 'not_applicable' ? 'marked not applicable' : o.status}{o.completed_by_name ? ` by ${o.completed_by_name}` : ''}.</p>}

        {open && (
          <div className="pd-form">
            <label className="pd-field">
              <span>Note (optional)</span>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Anything worth recording — a reading, a fault, a substitution." />
            </label>
            {showNa && (
              <label className="pd-field">
                <span>Why does this not apply today? <em>Required</em></span>
                <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Bench closed, analyser down, no samples…" />
              </label>
            )}
          </div>
        )}

        {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
      </div>
      <div className="pd-foot">
        {open && !showNa && (
          <>
            <button type="button" disabled={!!busy} onClick={() => void run('done')}>
              {busy === 'done' ? <><Loader2 size={14} className="pd-spin" /> Recording…</> : <><CheckCircle2 size={14} /> Done</>}
            </button>
            {o.status === 'pending' && (
              <button type="button" className="secondary" disabled={!!busy} onClick={() => void run('start')}>
                <PlayCircle size={14} /> {busy === 'start' ? 'Starting…' : 'I have started'}
              </button>
            )}
            <button type="button" className="secondary" disabled={!!busy} onClick={() => setShowNa(true)}>
              <Ban size={14} /> Not applicable
            </button>
          </>
        )}
        {open && showNa && (
          <>
            <button type="button" disabled={!reason.trim() || !!busy} onClick={() => void run('na')}>
              {busy === 'na' ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : 'Record it as not applicable'}
            </button>
            <button type="button" className="secondary" onClick={() => setShowNa(false)}>Back</button>
          </>
        )}
        <button type="button" className="secondary" onClick={() => onClose(false)}>Close</button>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------
   Read a controlled document
   ------------------------------------------------------------------------- */
/**
 * An alert about a document — issued, revised, due for review — opens the
 * document, here. Only the id is known at that point, so the current version is
 * resolved first; a person without document rights is told so plainly rather
 * than shown an empty window.
 */
function DocumentTask({ target, onClose }: {
  target: Extract<PortalTaskTarget, { kind: 'document' }>;
  onClose: (completed?: boolean) => void;
}) {
  const { setError } = usePortal();
  const [versionId, setVersionId] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ current_version_id?: number | null; versions?: Array<{ id: number }> }>(`/documents/${target.documentId}`)
      .then(d => {
        if (!live) return;
        const id = Number(d.current_version_id ?? d.versions?.[d.versions.length - 1]?.id ?? 0);
        if (id) setVersionId(id);
        else setProblem('This document has no file attached yet, so there is nothing to read.');
      })
      .catch(e => { if (live) setProblem((e as Error).message); });
    return () => { live = false; };
  }, [target.documentId]);

  if (problem) {
    return (
      <div className="portal-drawer-wrap" role="dialog" aria-modal="true" onClick={() => onClose(false)}>
        <div className="portal-drawer" onClick={e => e.stopPropagation()}>
          <DrawerHead eyebrow="Controlled document" title={target.title} onClose={() => onClose(false)} />
          <div className="pd-body"><p className="pd-error"><AlertTriangle size={14} /> {problem}</p></div>
          <div className="pd-foot"><button type="button" className="secondary" onClick={() => onClose(false)}>Close</button></div>
        </div>
      </div>
    );
  }

  if (!versionId) {
    return <div className="portal-drawer-wrap"><div className="portal-drawer"><p className="muted">Opening the document…</p></div></div>;
  }

  return (
    <DocumentViewer
      docId={target.documentId}
      versionId={versionId}
      onClose={() => onClose(false)}
      onAttest={() => undefined}
      onSaved={() => undefined}
      onError={setError}
    />
  );
}

/* ----------------------------------------------------------------------------
   Read an alert whose work lives in another module
   ------------------------------------------------------------------------- */
/**
 * The honest fallback.
 *
 * Most alerts point at something the portal can finish. Some do not: an
 * equipment calibration falls due, a batch of reagent expires, an IQC run wants
 * reviewing. Those are done at the analyser, in the module that holds the
 * record, and pretending otherwise would be a worse lie than a jump.
 *
 * What the portal can still do is refuse to throw the person out for reading
 * one. The whole alert opens here — what it says, what it is about, when it is
 * due, and everything that has happened to it — and acknowledging, resolving or
 * dismissing it happens here too, which is what most of these alerts actually
 * need. Only the "Open in …" button navigates, and it appears only when the
 * reader holds view rights on that module. It is a choice, not a consequence of
 * having clicked.
 */
const ALERT_FACE: Record<string, PortalFace> = {
  staff_documents: 'My Documents',
  training_records: 'My Training',
  training_events: 'My Training',
  competency_assessments: 'My Training',
  performance_appraisals: 'My Record',
  technical_authorizations: 'My Record',
  duty_rosters: 'My Schedule',
  duty_roster_assignments: 'My Schedule',
  bench_schedules: 'My Schedule',
  staff_declarations: 'My Declarations',
};

function AlertTask({ notification, onClose, onOpenFace }: {
  notification: NotificationRecord;
  onClose: (completed?: boolean) => void;
  onOpenFace?: (face: PortalFace) => void;
}) {
  const navigate = useNavigate();
  const { canView } = usePermissions();
  const { reloadInbox, setNotice } = usePortal();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ id: number; event_type: string; note?: string | null; created_at: string }>>(notification.events ?? []);

  const n = notification;
  const due = dueTone(n.due_date);
  const face = n.record_type ? ALERT_FACE[n.record_type] : undefined;
  // Where the record actually lives. Offered, never taken automatically, and
  // only to somebody who may open that module at all.
  const elsewhere = n.action_url && n.module_key && canView(n.module_key) ? n.action_url : null;

  // The history is worth having and cheap; a reader who may not see it simply
  // gets the alert without it.
  useEffect(() => {
    let live = true;
    api<{ events?: typeof events }>(`/notifications/${n.id}`)
      .then(r => { if (live && r.events) setEvents(r.events); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [n.id]);

  async function transition(action: 'acknowledge' | 'resolve' | 'dismiss') {
    setBusy(action); setProblem(null);
    try {
      await api(`/notifications/${n.id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      await reloadInbox();
      setNotice(action === 'resolve' ? 'Marked resolved.' : action === 'dismiss' ? 'Dismissed.' : 'Acknowledged.');
      onClose(true);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <DrawerHead
        eyebrow={[(n.module_key || 'general').replace(/_/g, ' '), (n.notification_type || '').replace(/_/g, ' ')].filter(Boolean).join(' · ')}
        title={n.title}
        onClose={() => onClose(false)}
      />
      <div className="pd-body">
        {n.message && <p className="pd-desc">{n.message}</p>}
        <p className="pd-meta">
          <span className={`badge${n.severity === 'urgent' || n.severity === 'high' ? ' overdue' : n.severity === 'medium' ? ' warning' : ''}`}>{titleCase(n.severity)}</span>
          {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
          <span>Raised {String(n.created_at).slice(0, 16).replace('T', ' ')}</span>
          {n.notification_number && <span>{n.notification_number}</span>}
        </p>

        {events.length > 0 && (
          <ul className="pd-events">
            {events.map(e => (
              <li key={e.id}>
                <strong>{titleCase(e.event_type)}</strong>
                <span>{String(e.created_at).slice(0, 16).replace('T', ' ')}</span>
                {e.note && <em>{e.note}</em>}
              </li>
            ))}
          </ul>
        )}

        <p className="pd-hint">
          {face
            ? 'This is about your own record — you can look at it in your portal.'
            : 'This one is carried out where the record lives. Deal with the alert here; open the module only if you need to.'}
        </p>

        {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
      </div>
      <div className="pd-foot">
        <button type="button" disabled={!!busy} onClick={() => void transition('resolve')}>
          {busy === 'resolve' ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : <><CheckCircle2 size={14} /> It is dealt with</>}
        </button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void transition('acknowledge')}>
          <Bell size={14} /> {busy === 'acknowledge' ? 'Saving…' : 'Seen it'}
        </button>
        <button type="button" className="secondary" disabled={!!busy} onClick={() => void transition('dismiss')}>
          {busy === 'dismiss' ? 'Saving…' : 'Does not apply'}
        </button>
        {face && onOpenFace && (
          <button type="button" className="secondary" onClick={() => { onOpenFace(face); onClose(false); }}>
            Open my {face.replace(/^My /, '')}
          </button>
        )}
        {elsewhere && (
          <button type="button" className="link" title="Leaves your portal"
            onClick={() => { onClose(false); navigate(elsewhere); }}>
            Open in {(n.module_key || '').replace(/_/g, ' ')}
          </button>
        )}
      </div>
    </>
  );
}

export { uploadPersonalFile };
