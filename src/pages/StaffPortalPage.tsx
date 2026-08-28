import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, BadgeCheck, BellRing, CalendarClock, CheckCircle2,
  ClipboardList, FileBadge, FileSignature, GraduationCap, IdCard, Inbox, KeyRound,
  PenLine, Plus, ShieldAlert, Sliders, Sparkles, UserRound,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { useDutyReminders } from '../hooks/useDutyReminders';
import { useTabParam } from '../hooks/useTabParam';
import DisabledModule from '../components/DisabledModule';
import DutyTodoCard from '../components/DutyTodoCard';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { WaveBackground, MedicalLabBackgroundMarks } from '../components/ui';
import { PortalProvider, initialsOf, isOpenAlert, usePortal } from './portal/portalData';
import PortalInbox, { InboxRow, filterInbox } from './portal/PortalInbox';
import PortalTasks, { useOwedWork } from './portal/PortalTasks';
import PortalRecord, { LinkStaffPrompt } from './portal/PortalRecord';
import PortalDocuments from './portal/PortalDocuments';
import PortalDeclarations from './portal/PortalDeclarations';
import PortalSchedule from './portal/PortalSchedule';
import PortalTraining from './portal/PortalTraining';
import PortalPreferences from './portal/PortalPreferences';
import { api } from '../services/api';
import type { NotificationRecord } from '../../shared/types/api';

/* ============================================================================
   MY PORTAL — the member of staff's own workspace.

   Every other module in SECH_LIMS is organised around a thing the laboratory
   manages: documents, equipment, suppliers. This one is organised around a
   person, and it is the only place in the system that is.

   It is deliberately built the other way round from every other workspace. A
   normal module lands you on a dashboard and makes you leave it for a tab. Here
   the landing IS the portal: who you are, what is waiting on you, what you are
   on duty to do today and what has just arrived — all on one screen, with the
   deeper faces of the same file arranged across it as tiles you can step into
   and step back out of. A member of staff should be able to answer "what do I
   have to do?" without navigating anywhere at all.

   Nothing here needs a module permission, because nothing here belongs to a
   module. Every endpoint behind it is self-scoped: the server matches the
   caller against their own staff record, so the portal can be given to the
   whole laboratory without giving anybody sight of a colleague's file.
   ========================================================================= */

type PortalTab =
  | 'Portal' | 'My Tasks' | 'My Inbox' | 'My Schedule' | 'My Record'
  | 'My Documents' | 'My Training' | 'My Declarations' | 'Preferences';

const TABS: PortalTab[] = [
  'Portal', 'My Tasks', 'My Inbox', 'My Schedule', 'My Record',
  'My Documents', 'My Training', 'My Declarations', 'Preferences',
];

/** The rectangular features on the landing. Each steps into one face of the file. */
type Tile = {
  tab: PortalTab;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  /** null when the tile has nothing worth counting (preferences, say). */
  count: number | null;
  countLabel: string;
  tone?: 'crit' | 'warn' | 'ok';
};

export function StaffPortalPage() {
  const { isEnabled } = useModules();
  if (!isEnabled('staff_portal')) return <DisabledModule />;
  return <PortalProvider><PortalShell /></PortalProvider>;
}

function PortalShell() {
  const [tab, setTab] = useState<PortalTab>('Portal');
  const { error, notice, setNotice, setError, loading, staff } = usePortal();
  useTabParam(TABS, name => setTab(name as PortalTab));

  return (
    <div className="module-page portal">
      <PortalHero onOpen={setTab} />

      <nav className="portal-tabs" aria-label="My Portal sections">
        {TABS.map(name => (
          <button key={name} type="button" className={tab === name ? 'active' : ''}
            aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>
            {name === 'Portal' ? 'Portal home' : name}
          </button>
        ))}
      </nav>

      {error && <div className="error" role="alert">{error}<button type="button" className="link-button" onClick={() => setError(null)}>Dismiss</button></div>}
      {notice && <div className="portal-notice" role="status">{notice}<button type="button" className="link-button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {loading && <div className="portal-loading">Gathering your file…</div>}
      {!loading && !staff && tab !== 'My Record' && <LinkStaffPrompt />}

      {tab === 'Portal' && <PortalHome onOpen={setTab} />}
      {tab === 'My Tasks' && <PortalTasks />}
      {tab === 'My Inbox' && <PortalInbox />}
      {tab === 'My Schedule' && <PortalSchedule />}
      {tab === 'My Record' && <PortalRecord />}
      {tab === 'My Documents' && <PortalDocuments />}
      {tab === 'My Training' && <PortalTraining />}
      {tab === 'My Declarations' && <PortalDeclarations />}
      {tab === 'Preferences' && <PortalPreferences />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The banner: who this is, where they are working today, and the two things
   they maintain themselves.
   ------------------------------------------------------------------------- */
function PortalHero({ onOpen }: { onOpen: (tab: PortalTab) => void }) {
  const { user } = useAuth();
  const { profile, staff, hasSignature, signatureUrl, uploadSignature, setError } = usePortal();
  const { data } = useDutyReminders();
  const [showPassword, setShowPassword] = useState(false);
  const sigInput = useRef<HTMLInputElement>(null);

  const fullName = staff?.full_name || profile?.user.fullName || user?.fullName || 'My Portal';
  const role = (profile?.user as { roleName?: string } | undefined)?.roleName || user?.roleName || 'Member of staff';
  const position = profile?.positions.find(p => p.is_active)?.title || staff?.designation || staff?.job_title || null;
  const duty = data?.duty;

  const facts = [
    position ? { label: 'Position', value: position } : null,
    staff?.section_name ? { label: 'Section', value: staff.section_name } : null,
    staff?.employee_no ? { label: 'Staff ID', value: staff.employee_no } : null,
    { label: 'Access profile', value: role },
  ].filter(Boolean) as { label: string; value: string }[];

  return (
    <header className="portal-hero">
      <div className="bg-deco">
        <WaveBackground variant="header" />
        <MedicalLabBackgroundMarks />
      </div>

      <div className="ph-identity">
        <span className="ph-avatar">{initialsOf(fullName)}</span>
        <div className="ph-who">
          <span className="eyebrow">My Portal · Staff workspace</span>
          <h2>{fullName}</h2>
          {/* A profile named after the job repeats itself — "Biomedical Scientist ·
              Biomedical Scientist" — so the position is shown only when it says
              something the access profile does not. */}
          <p className="ph-role">{role}{position && position !== role ? ` · ${position}` : ''}</p>
          <div className="ph-duty">
            {duty?.onDuty ? (
              <>
                <span className="ph-duty-pill on"><span className="dot" /> On duty today</span>
                <span>{[duty.shiftLabel, duty.sectionName, duty.benchName ? `${duty.benchName} bench` : null].filter(Boolean).join(' · ')}</span>
                {(duty.rosterCarriedForward || duty.benchCarriedForward) && (
                  <span className="ph-carry" title="No schedule was prepared for this month, so last month's is still running.">
                    <ShieldAlert size={12} /> carried forward
                  </span>
                )}
              </>
            ) : (
              <span className="ph-duty-pill off">Not rostered today</span>
            )}
          </div>
        </div>
      </div>

      <dl className="ph-facts">
        {facts.map(f => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}
      </dl>

      <div className="ph-self">
        <div className="ph-sig">
          <span className="ph-sig-label">My signature</span>
          {signatureUrl
            ? <img src={signatureUrl} alt="Your signature as held on file" />
            : <span className="ph-sig-empty">Not set up</span>}
          {hasSignature && <span className="ph-sig-ok"><BadgeCheck size={12} /> in use</span>}
        </div>
        <input ref={sigInput} type="file" accept="image/*" hidden
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) uploadSignature(f).catch(err => setError((err as Error).message));
            if (sigInput.current) sigInput.current.value = '';
          }} />
        <div className="ph-self-btns">
          <button type="button" className="secondary" onClick={() => sigInput.current?.click()}>
            <PenLine size={14} /> {hasSignature ? 'Replace signature' : 'Add signature'}
          </button>
          <button type="button" className="secondary" onClick={() => setShowPassword(true)}>
            <KeyRound size={14} /> Change password
          </button>
          <button type="button" className="secondary" onClick={() => onOpen('My Record')}>
            <IdCard size={14} /> My record
          </button>
        </div>
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    </header>
  );
}

/* ----------------------------------------------------------------------------
   The landing itself.
   ------------------------------------------------------------------------- */
function PortalHome({ onOpen }: { onOpen: (tab: PortalTab) => void }) {
  const navigate = useNavigate();
  const { inbox, declarations, documents, tasks, queue, profile, reloadInbox } = usePortal();
  const { data } = useDutyReminders();
  const { assigned, coming } = useOwedWork();

  const openAlerts = useMemo(() => inbox.filter(isOpenAlert), [inbox]);
  const unread = openAlerts.filter(n => n.status === 'unread').length;
  const overdueAlerts = filterInbox(inbox, 'overdue').length;
  const urgentAlerts = filterInbox(inbox, 'urgent').length;
  const dueToday = filterInbox(inbox, 'today').length;
  const activitiesDue = (data?.mine ?? []).filter(o => o.status === 'pending' || o.status === 'in_progress').length;
  const activitiesDone = (data?.mine ?? []).filter(o => o.status === 'done' || o.status === 'not_applicable').length;
  const owedSchedules = (data?.scheduleTasks ?? []).filter(t => t.isMine).length;
  const expiredDocs = documents.filter(d => d.expiry_date && String(d.expiry_date).slice(0, 10) < new Date().toISOString().slice(0, 10)).length;

  // The figures the person actually steers by. Each one lands on the face of
  // the portal that holds the work behind it — a number nobody can act on is
  // decoration, and this page has no room for decoration.
  const pulse = [
    { label: 'To do today', value: activitiesDue, tone: activitiesDue ? 'warn' : 'ok', tab: 'My Tasks' as PortalTab },
    { label: 'Assigned to me', value: assigned.length, tone: assigned.length ? 'info' : 'ok', tab: 'My Tasks' as PortalTab },
    { label: 'Unread alerts', value: unread, tone: unread ? 'info' : 'ok', tab: 'My Inbox' as PortalTab },
    { label: 'Overdue', value: overdueAlerts, tone: overdueAlerts ? 'crit' : 'ok', tab: 'My Inbox' as PortalTab },
    { label: 'To sign', value: declarations.pending.length, tone: declarations.pending.length ? 'warn' : 'ok', tab: 'My Declarations' as PortalTab },
    { label: 'Done today', value: activitiesDone, tone: 'ok', tab: 'My Tasks' as PortalTab },
  ];

  const tiles: Tile[] = [
    {
      tab: 'My Tasks', title: 'My tasks & duties', icon: <ClipboardList size={20} />,
      blurb: 'Everything with your name on it — today’s unit activities, actions, attestations and assigned tasks.',
      count: activitiesDue + assigned.length + queue.filter(t => t.status !== 'completed' && t.status !== 'cancelled').length,
      countLabel: 'open', tone: activitiesDue + assigned.length > 0 ? 'warn' : undefined,
    },
    {
      tab: 'My Inbox', title: 'My inbox', icon: <Inbox size={20} />,
      blurb: 'Every alert the laboratory routed to you. Opening one takes you to the record it is about.',
      count: openAlerts.length, countLabel: unread ? `${unread} unread` : 'open',
      tone: urgentAlerts > 0 ? 'crit' : undefined,
    },
    {
      tab: 'My Schedule', title: 'My schedule', icon: <CalendarClock size={20} />,
      blurb: 'The shifts you are on, the bench you are on today, and the rosters you owe your unit.',
      count: (tasks?.upcomingDuties?.length ?? 0) + owedSchedules, countLabel: 'upcoming',
      tone: owedSchedules > 0 ? 'warn' : undefined,
    },
    {
      tab: 'My Record', title: 'My record', icon: <UserRound size={20} />,
      blurb: 'Your personnel record as the laboratory holds it: post, contact, positions and technical authorisations.',
      count: profile?.authorizations?.length ?? 0, countLabel: 'authorisations',
    },
    {
      tab: 'My Documents', title: 'My documents', icon: <FileBadge size={20} />,
      blurb: 'Certificates, licences and records on your staff file, with what has lapsed called out.',
      count: documents.length, countLabel: expiredDocs ? `${expiredDocs} expired` : 'on file',
      tone: expiredDocs > 0 ? 'crit' : undefined,
    },
    {
      tab: 'My Training', title: 'My training & competency', icon: <GraduationCap size={20} />,
      blurb: 'Training you are down to attend and the competency assessments planned for you.',
      count: coming.length, countLabel: 'scheduled',
    },
    {
      tab: 'My Declarations', title: 'My declarations', icon: <FileSignature size={20} />,
      blurb: 'Confidentiality, impartiality and conflict of interest — what you must sign, and what you have signed.',
      count: declarations.pending.length || declarations.signed.length,
      countLabel: declarations.pending.length ? 'to sign' : 'signed',
      tone: declarations.pending.length ? 'warn' : undefined,
    },
    {
      tab: 'Preferences', title: 'My preferences', icon: <Sliders size={20} />,
      blurb: 'Which areas may alert you, and what this device does when one arrives.',
      count: null, countLabel: 'Alerts and sounds',
    },
  ];

  async function openAlert(n: NotificationRecord) {
    try {
      if (n.status === 'unread') await api(`/notifications/${n.id}/read`, { method: 'POST', body: JSON.stringify({}) });
      void reloadInbox();
    } catch { /* the record matters more than the read receipt */ }
    if (n.action_url) navigate(n.action_url);
  }

  return (
    <div className="portal-home">
      <div className="portal-pulse">
        {pulse.map(p => (
          <button key={p.label} type="button" className={`pulse t-${p.tone}`} onClick={() => onOpen(p.tab)}
            title={`Open ${p.tab}`}>
            <strong>{p.value}</strong>
            <span>{p.label}</span>
          </button>
        ))}
      </div>

      <div className="portal-section-title">
        <h3>Everything that is mine</h3>
        <p>Each panel opens in place — you never leave your portal to reach it.</p>
      </div>

      <div className="portal-tiles">
        {tiles.map(t => (
          <button key={t.tab} type="button" className={`portal-tile${t.tone ? ` t-${t.tone}` : ''}`} onClick={() => onOpen(t.tab)}>
            <span className="pt-ico">{t.icon}</span>
            <span className="pt-body">
              <span className="pt-title">{t.title}</span>
              <span className="pt-blurb">{t.blurb}</span>
            </span>
            <span className="pt-foot">
              {t.count !== null && <span className="pt-count">{t.count}</span>}
              <span className="pt-count-label">{t.countLabel}</span>
              <ArrowRight size={15} className="pt-arrow" />
            </span>
          </button>
        ))}
      </div>

      <div className="portal-work">
        <div className="portal-work-main">
          <DutyTodoCard limit={6} />

          <section className="portal-panel">
            <div className="pp-head">
              <div>
                <h3><ClipboardList size={16} /> Waiting on me</h3>
                <p>Declarations, attestations, actions and tasks assigned to you by name.</p>
              </div>
              <button type="button" className="pq-link" onClick={() => onOpen('My Tasks')}>
                Open my tasks <ArrowRight size={13} />
              </button>
            </div>
            {assigned.length === 0 ? (
              <div className="pp-clear"><Sparkles size={18} /><span>Nothing is assigned to you right now.</span></div>
            ) : (
              <ul className="pt-list">
                {assigned.slice(0, 5).map(r => (
                  <li key={r.key} className="pt-row">
                    <span className="pt-rail info" />
                    <button type="button" className="pt-row-main" onClick={() => navigate(r.to)}>
                      <span className="pt-row-title">{r.title}</span>
                      {r.detail && <span className="pt-row-msg">{r.detail}</span>}
                      <span className="pt-row-meta"><span className="badge">{r.badge}</span>{r.due && <span>{r.due}</span>}</span>
                    </button>
                    <div className="pt-row-side">
                      <button type="button" className="pt-open" onClick={() => navigate(r.to)}>{r.cta} <ArrowRight size={13} /></button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {assigned.length > 5 && (
              <button type="button" className="pp-more" onClick={() => onOpen('My Tasks')}>
                {assigned.length - 5} more waiting on you <ArrowRight size={13} />
              </button>
            )}
          </section>
        </div>

        <div className="portal-work-side">
          <section className="portal-panel">
            <div className="pp-head">
              <div>
                <h3><Inbox size={16} /> Latest in my inbox</h3>
                <p>{unread > 0 ? `${unread} unread of ${openAlerts.length} open` : `${openAlerts.length} open`}{dueToday ? ` · ${dueToday} due today` : ''}</p>
              </div>
              <button type="button" className="pq-link" onClick={() => onOpen('My Inbox')}>
                Open inbox <ArrowRight size={13} />
              </button>
            </div>
            {openAlerts.length === 0 ? (
              <div className="pp-clear"><CheckCircle2 size={18} /><span>Your inbox is clear.</span></div>
            ) : (
              <ul className="pt-list">
                {filterInbox(inbox, 'active').slice(0, 5).map(n => (
                  <InboxRow key={n.id} notification={n} onOpen={openAlert} />
                ))}
              </ul>
            )}
            {urgentAlerts > 0 && (
              <button type="button" className="pp-more crit" onClick={() => onOpen('My Inbox')}>
                <AlertTriangle size={13} /> {urgentAlerts} urgent or high alert{urgentAlerts === 1 ? '' : 's'} <ArrowRight size={13} />
              </button>
            )}
          </section>

          <RaiseSomething />

          <section className="portal-panel">
            <div className="pp-head">
              <div>
                <h3><BellRing size={16} /> Coming up</h3>
                <p>Training and competency already booked for you.</p>
              </div>
            </div>
            {coming.length === 0 ? (
              <p className="muted">Nothing scheduled for you yet.</p>
            ) : (
              <ul className="pp-mini-list">
                {coming.slice(0, 4).map(c => (
                  <li key={c.key}>
                    <span className="badge">{c.badge}</span>
                    <span className="pp-mini-title">{c.title}</span>
                    <span className="pp-mini-due">{c.due ?? '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The one part of the portal that points outward.
 *
 * Everything staff are asked to REPORT — a nonconformity, a safety incident, a
 * complaint from a clinician — is raised in a module they may otherwise never
 * open. Making them find it is how an incident goes unreported, so the buttons
 * live where the person already is. Each is drawn only if they may actually
 * create the record, since offering a form the server will refuse is worse
 * than not offering it.
 */
function RaiseSomething() {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { isEnabled } = useModules();

  const options = [
    { module: 'nc_capa', label: 'Nonconformity', to: '/nonconformities?tab=Log%20Event', hint: 'Something did not meet requirement' },
    { module: 'facilities_safety', label: 'Safety incident', to: '/facilities-safety?tab=New%20Incident', hint: 'Injury, spill, exposure or near miss' },
    { module: 'complaints', label: 'Complaint', to: '/complaints?tab=Log%20a%20complaint', hint: 'Received from a clinician or patient' },
    { module: 'risks', label: 'Risk', to: '/risks?tab=New%20Risk', hint: 'Something that could go wrong' },
  ].filter(o => isEnabled(o.module) && can(o.module, 'create'));

  if (options.length === 0) return null;

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><Plus size={16} /> Raise something</h3>
          <p>Report it from here — you do not need to go looking for the register.</p>
        </div>
      </div>
      <div className="portal-raise">
        {options.map(o => (
          <button key={o.module} type="button" onClick={() => navigate(o.to)}>
            <strong>{o.label}</strong>
            <span>{o.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default StaffPortalPage;
