import { useMemo, useState } from 'react';
import { ArrowRight, ClipboardList, GraduationCap, Sparkles } from 'lucide-react';
import DutyTodoCard from '../../components/DutyTodoCard';
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
          documentId: Number(a.document_id ?? 0),
          versionId: Number(a.document_version_id ?? 0),
          title: a.title || a.document_code || 'Controlled document',
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
 * One row of owed work. Clicking anywhere on it opens the thing itself.
 *
 * Shared with the portal landing, which shows the first few of the same rows —
 * two renderings of "what you owe" would eventually disagree about what a row
 * looks like or what clicking it does.
 */
export function OwedRow({ row, onOpen }: { row: Owed; onOpen: (target: PortalTaskTarget) => void }) {
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
      {row.open && (
        <div className="pt-row-side">
          <button type="button" className="pt-open" onClick={() => onOpen(row.open!)}>
            {row.cta} <ArrowRight size={13} />
          </button>
        </div>
      )}
    </li>
  );
}

function OwedList({ rows, icon, title, blurb, empty, onOpen }: {
  rows: Owed[]; icon: React.ReactNode; title: string; blurb: string; empty: string;
  onOpen: (target: PortalTaskTarget) => void;
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
          {rows.map(r => <OwedRow key={r.key} row={r} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  );
}

export default function PortalTasks() {
  const { assigned, coming } = useOwedWork();
  const [open, setOpen] = useState<PortalTaskTarget | null>(null);

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
