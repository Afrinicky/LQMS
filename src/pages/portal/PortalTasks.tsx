import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ClipboardList, GraduationCap, Loader2, PenLine, Sparkles } from 'lucide-react';
import DutyTodoCard from '../../components/DutyTodoCard';
import { api } from '../../services/api';
import { dueTone, titleCase, usePortal } from './portalData';
import PortalTaskDrawer, { type PortalTaskTarget } from './PortalTaskDrawer';

/**
 * My tasks — one list of everything this person owes, and the place they do it.
 *
 * A member of staff does not think in modules. They think "what do I have to
 * do?", and the answer used to be spread over six workspaces: an action here,
 * a document to attest there, a declaration to sign in a third.
 *
 * Gathering them into one list was half the job. The other half is that the
 * list is where the work happens: clicking a row opens the thing itself, over
 * the portal, and closes back onto the list with the row gone. Nothing here
 * navigates anywhere. Being told what you owe and then being sent somewhere
 * else to do it is how a to-do list becomes something people stop opening.
 *
 * Today's recurring unit work keeps its own panel above, because it is the one
 * kind of task that is finished with a single tap and needs no panel at all.
 */
export type Owed = {
  key: string;
  title: string;
  detail?: string;
  badge: string;
  due?: string | null;
  cta: string;
  /**
   * What opens when the row is clicked, in place, over the portal. Absent on a
   * row there is nothing to do about — a training date somebody booked for you
   * is news, not a task, and an "Open" button that did nothing would be worse
   * than none.
   */
  open?: PortalTaskTarget;
  /**
   * Where a row can also be signed off from the list itself. Present only for
   * work whose whole content is the thing the row already names — see
   * `QuickSign` below for why that qualification matters.
   */
  quickSign?: { label: string; confirm: string; run: () => Promise<void> };
};

export function useOwedWork(): { assigned: Owed[]; coming: Owed[] } {
  const { tasks, declarations, queue } = usePortal();

  return useMemo(() => {
    const assigned: Owed[] = [];
    const coming: Owed[] = [];

    for (const d of declarations.pending) {
      assigned.push({
        key: `decl-${d.id}`,
        title: d.title,
        detail: `${titleCase(d.form_type)} · awaiting your signature`,
        badge: 'Declaration',
        cta: 'Read & sign',
        open: { kind: 'declaration', declaration: d },
      });
    }

    for (const a of tasks?.pendingAttestations ?? []) {
      const documentId = Number(a.document_id ?? 0);
      assigned.push({
        key: `att-${a.id}`,
        title: a.title || a.document_code || 'Controlled document',
        detail: `${a.document_code ? `${a.document_code} · ` : ''}read and attest to the issued version`,
        badge: 'Attestation',
        due: a.due_date,
        cta: 'Read & attest',
        open: {
          kind: 'attestation',
          attestationId: a.id,
          documentId,
          versionId: Number(a.document_version_id ?? 0),
          title: a.title || a.document_code || 'Controlled document',
        },
        quickSign: {
          label: 'Sign',
          confirm: 'Confirm you have read it',
          run: () => api(`/documents/${documentId}/attest`, { method: 'POST', body: JSON.stringify({ attestationId: a.id }) }).then(() => undefined),
        },
      });
    }

    for (const a of tasks?.assignedActions ?? []) {
      assigned.push({
        key: `act-${a.id}`,
        title: a.title,
        detail: [titleCase(a.module_key), a.priority ? `${titleCase(a.priority)} priority` : null, a.status].filter(Boolean).join(' · '),
        badge: 'Action',
        due: a.due_date,
        cta: 'Update progress',
        open: { kind: 'action', id: a.id, title: a.title, description: a.description, status: a.status, dueDate: a.due_date },
      });
    }

    for (const t of queue) {
      if (t.status === 'completed' || t.status === 'cancelled') continue;
      assigned.push({
        key: `task-${t.id}`,
        title: t.title,
        detail: [t.task_number, titleCase(t.module_key), titleCase(t.priority)].filter(Boolean).join(' · '),
        badge: 'Task',
        due: t.due_date,
        cta: 'Open task',
        open: { kind: 'queueTask', id: t.id, title: t.title, description: t.description, status: t.status },
      });
    }

    // Training and competency are booked FOR this person by somebody else.
    // There is nothing for them to complete here, so these rows carry no
    // action — showing an "Open" button that does nothing would be worse than
    // showing none.
    for (const c of tasks?.upcomingCompetency ?? []) {
      coming.push({
        key: `comp-${c.id}`,
        title: c.activity || 'Competency assessment',
        detail: [c.competency_number, c.assessor_name ? `assessor ${c.assessor_name}` : null, titleCase(c.status)].filter(Boolean).join(' · '),
        badge: 'Competency',
        due: c.assessment_date,
        cta: '',
      });
    }

    for (const t of tasks?.upcomingTraining ?? []) {
      coming.push({
        key: `trn-${t.id}`,
        title: t.title,
        detail: [t.training_number, t.location, t.attendance_status ? titleCase(t.attendance_status) : null].filter(Boolean).join(' · '),
        badge: 'Training',
        due: t.training_date,
        cta: '',
      });
    }

    const byDue = (a: Owed, b: Owed) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999'));
    return { assigned: assigned.sort(byDue), coming: coming.sort(byDue) };
  }, [tasks, declarations, queue]);
}

/**
 * Signing off a row from the list, without opening it.
 *
 * Somebody who has already read the SOP at the bench — or read it here
 * yesterday and is clearing their list this morning — should not have to open
 * the whole document again to put their name to it. That is the case this
 * exists for, and it is a real one.
 *
 * It is two clicks rather than one, and deliberately so. An attestation is a
 * signed statement that a named person read and understood a controlled
 * document; a single unguarded click, sitting next to "Done" buttons that mean
 * far less, would collect signatures from people who never intended to give
 * one. So the first click replaces the button with the sentence being signed
 * and a confirm, in place on the row. Still quick — no dialog, no navigation —
 * but nobody signs by accident, and the record stays true.
 *
 * "Read & attest" remains the primary route and is still what a row opens on.
 */
function QuickSign({ sign, onSigned }: { sign: NonNullable<Owed['quickSign']>; onSigned: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function go() {
    setBusy(true); setProblem(null);
    try { await sign.run(); onSigned(); }
    catch (e) { setProblem((e as Error).message); setConfirming(false); }
    finally { setBusy(false); }
  }

  if (problem) {
    return <span className="pt-quick-error" title={problem}><AlertTriangle size={12} /> {problem}</span>;
  }
  if (!confirming) {
    return (
      <button type="button" className="pt-quick" onClick={() => setConfirming(true)}
        title="Sign from here — you will be asked to confirm you have read it">
        <PenLine size={12} /> {sign.label}
      </button>
    );
  }
  return (
    <span className="pt-quick-confirm">
      <span>{sign.confirm}</span>
      <button type="button" className="pt-quick yes" disabled={busy} onClick={() => void go()}>
        {busy ? <Loader2 size={12} className="pd-spin" /> : 'I have'}
      </button>
      <button type="button" className="pt-quick no" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

/**
 * One row of owed work. Clicking anywhere on it opens the thing itself.
 *
 * Shared with the portal landing, which shows the first few of the same rows —
 * two renderings of "what you owe" would eventually disagree about what a row
 * looks like or what clicking it does.
 */
export function OwedRow({ row, onOpen, onSigned }: {
  row: Owed;
  onOpen: (target: PortalTaskTarget) => void;
  onSigned?: () => void;
}) {
  const due = dueTone(row.due);
  const tone = due?.tone === 'crit' ? 'crit' : due?.tone === 'warn' ? 'warn' : 'info';
  const body = (
    <>
      <span className="pt-row-title">{row.title}</span>
      {row.detail && <span className="pt-row-msg">{row.detail}</span>}
      <span className="pt-row-meta">
        <span className="badge">{row.badge}</span>
        {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
      </span>
    </>
  );
  return (
    <li className={`pt-row${tone === 'crit' ? ' sev-crit' : ''}`}>
      <span className={`pt-rail ${tone}`} />
      {row.open
        ? <button type="button" className="pt-row-main" onClick={() => onOpen(row.open!)} title={row.cta}>{body}</button>
        : <div className="pt-row-main static">{body}</div>}
      {(row.open || row.quickSign) && (
        <div className="pt-row-side">
          {row.quickSign && onSigned && <QuickSign sign={row.quickSign} onSigned={onSigned} />}
          {row.open && (
            <button type="button" className="pt-open" onClick={() => onOpen(row.open!)}>
              {row.cta} <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function OwedList({ rows, icon, title, blurb, empty, onOpen, onSigned }: {
  rows: Owed[]; icon: React.ReactNode; title: string; blurb: string; empty: string;
  onOpen: (target: PortalTaskTarget) => void;
  onSigned?: () => void;
}) {
  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3>{icon} {title}</h3>
          <p>{blurb}</p>
        </div>
        {rows.length > 0 && <span className="pp-count">{rows.length}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="pp-clear"><Sparkles size={18} /><span>{empty}</span></div>
      ) : (
        <ul className="pt-list">
          {rows.map(r => <OwedRow key={r.key} row={r} onOpen={onOpen} onSigned={onSigned} />)}
        </ul>
      )}
    </section>
  );
}

export default function PortalTasks() {
  const { assigned, coming } = useOwedWork();
  const { reload, setNotice } = usePortal();
  const [open, setOpen] = useState<PortalTaskTarget | null>(null);

  const afterSign = () => { setNotice('Signed. It is recorded against the document.'); void reload(); };

  return (
    <div className="portal-stack">
      <DutyTodoCard limit={20} />
      <OwedList
        rows={assigned}
        icon={<ClipboardList size={16} />}
        title="Waiting on me"
        blurb="Declarations, attestations, actions and tasks with your name on them. Click one and you do it here — nothing sends you elsewhere."
        empty="Nothing is assigned to you right now."
        onOpen={setOpen}
        onSigned={afterSign}
      />
      <OwedList
        rows={coming}
        icon={<GraduationCap size={16} />}
        title="Coming up"
        blurb="Training and competency assessments already booked for you by your unit."
        empty="Nothing scheduled for you yet."
        onOpen={setOpen}
      />
      {open && <PortalTaskDrawer target={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
