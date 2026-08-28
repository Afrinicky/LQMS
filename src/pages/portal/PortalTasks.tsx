import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ClipboardList, GraduationCap, ListChecks, Sparkles } from 'lucide-react';
import { api } from '../../services/api';
import DutyTodoCard from '../../components/DutyTodoCard';
import { MODULES } from '../../../shared/constants/modules';
import { dueTone, titleCase, usePortal } from './portalData';

/**
 * My tasks — one list of everything this person owes, whatever raised it.
 *
 * A member of staff does not think in modules. They think "what do I have to
 * do?", and the answer used to be spread over six workspaces: an action here,
 * a document to attest there, a declaration to sign in a third. Everything
 * routed to one person is gathered here, each row opening the exact screen
 * where the work is done — not the module's front page.
 *
 * Today's recurring unit work keeps its own panel above, because it is the one
 * kind of task that is finished with a single tap rather than a visit.
 */
const MODULE_PATHS = new Map(MODULES.map(m => [m.key, m.path]));

type Owed = {
  key: string;
  title: string;
  detail?: string;
  badge: string;
  due?: string | null;
  to: string;
  cta: string;
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
        to: `/organisation?tab=Code%20of%20Conduct&form=${d.id}`,
        cta: 'Read & sign',
      });
    }

    for (const a of tasks?.pendingAttestations ?? []) {
      assigned.push({
        key: `att-${a.id}`,
        title: a.title || a.document_code || 'Controlled document',
        detail: `${a.document_code ? `${a.document_code} · ` : ''}read and attest to the issued version`,
        badge: 'Attestation',
        due: a.due_date,
        to: '/documents?subtab=My%20Inbox',
        cta: 'Read & attest',
      });
    }

    for (const a of tasks?.assignedActions ?? []) {
      assigned.push({
        key: `act-${a.id}`,
        title: a.title,
        detail: [titleCase(a.module_key), a.priority ? `${titleCase(a.priority)} priority` : null, a.status].filter(Boolean).join(' · '),
        badge: 'Action',
        due: a.due_date,
        to: '/actions',
        cta: 'Open action',
      });
    }

    for (const t of queue) {
      if (t.status === 'completed' || t.status === 'cancelled') continue;
      const route = t.module_key ? MODULE_PATHS.get(t.module_key) : undefined;
      assigned.push({
        key: `task-${t.id}`,
        title: t.title,
        detail: [t.task_number, titleCase(t.module_key), titleCase(t.priority)].filter(Boolean).join(' · '),
        badge: 'Task',
        due: t.due_date,
        to: route ?? '/my-portal?tab=My%20Tasks',
        cta: route ? 'Open workspace' : 'Open',
      });
    }

    for (const c of tasks?.upcomingCompetency ?? []) {
      coming.push({
        key: `comp-${c.id}`,
        title: c.activity || 'Competency assessment',
        detail: [c.competency_number, c.assessor_name ? `assessor ${c.assessor_name}` : null, titleCase(c.status)].filter(Boolean).join(' · '),
        badge: 'Competency',
        due: c.assessment_date,
        to: '/my-portal?tab=My%20Training',
        cta: 'View',
      });
    }

    for (const t of tasks?.upcomingTraining ?? []) {
      coming.push({
        key: `trn-${t.id}`,
        title: t.title,
        detail: [t.training_number, t.location, t.attendance_status ? titleCase(t.attendance_status) : null].filter(Boolean).join(' · '),
        badge: 'Training',
        due: t.training_date,
        to: '/my-portal?tab=My%20Training',
        cta: 'View',
      });
    }

    const byDue = (a: Owed, b: Owed) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999'));
    return { assigned: assigned.sort(byDue), coming: coming.sort(byDue) };
  }, [tasks, declarations, queue]);
}

function OwedList({ rows, icon, title, blurb, empty }: {
  rows: Owed[]; icon: React.ReactNode; title: string; blurb: string; empty: string;
}) {
  const navigate = useNavigate();
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
          {rows.map(r => {
            const due = dueTone(r.due);
            return (
              <li key={r.key} className={`pt-row${due?.tone === 'crit' ? ' sev-crit' : ''}`}>
                <span className={`pt-rail ${due?.tone === 'crit' ? 'crit' : due?.tone === 'warn' ? 'warn' : 'info'}`} />
                <button type="button" className="pt-row-main" onClick={() => navigate(r.to)} title={r.cta}>
                  <span className="pt-row-title">{r.title}</span>
                  {r.detail && <span className="pt-row-msg">{r.detail}</span>}
                  <span className="pt-row-meta">
                    <span className="badge">{r.badge}</span>
                    {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
                  </span>
                </button>
                <div className="pt-row-side">
                  <button type="button" className="pt-open" onClick={() => navigate(r.to)}>
                    {r.cta} <ArrowRight size={13} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The queue tasks a person can advance without leaving the portal. */
function QuickQueue() {
  const { queue, reload, setError } = usePortal();
  const live = queue.filter(t => t.status !== 'completed' && t.status !== 'cancelled');
  if (live.length === 0) return null;

  async function act(id: number, action: 'start' | 'complete') {
    try { await api(`/notifications/tasks/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) }); await reload(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><ListChecks size={16} /> Task queue</h3>
          <p>Tasks assigned to you by name. Start one to show your colleagues it is in hand; complete it when it is done.</p>
        </div>
        <span className="pp-count">{live.length}</span>
      </div>
      <ul className="pt-list">
        {live.map(t => {
          const due = dueTone(t.due_date);
          return (
            <li key={t.id} className="pt-row">
              <span className={`pt-rail ${due?.tone === 'crit' ? 'crit' : 'info'}`} />
              <div className="pt-row-main static">
                <span className="pt-row-title">{t.title}</span>
                {t.description && <span className="pt-row-msg">{t.description}</span>}
                <span className="pt-row-meta">
                  <span className="badge">{titleCase(t.status)}</span>
                  {t.module_key && <span>{titleCase(t.module_key)}</span>}
                  {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
                </span>
              </div>
              <div className="pt-row-side">
                {t.status === 'open' && <button type="button" className="pt-mini" onClick={() => void act(t.id, 'start')}>Start</button>}
                <button type="button" className="pt-mini ok" title="Mark complete" onClick={() => void act(t.id, 'complete')}>
                  <CheckCircle2 size={13} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function PortalTasks() {
  const { assigned, coming } = useOwedWork();
  return (
    <div className="portal-stack">
      <DutyTodoCard limit={20} />
      <OwedList
        rows={assigned}
        icon={<ClipboardList size={16} />}
        title="Assigned to me"
        blurb="Declarations, attestations, actions and tasks with your name on them. Each row opens the screen where you do it."
        empty="Nothing is assigned to you right now."
      />
      <QuickQueue />
      <OwedList
        rows={coming}
        icon={<GraduationCap size={16} />}
        title="Coming up"
        blurb="Training and competency assessments already scheduled for you."
        empty="Nothing scheduled for you yet."
      />
    </div>
  );
}
