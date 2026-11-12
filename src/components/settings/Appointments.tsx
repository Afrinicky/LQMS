import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRightLeft, CalendarClock, Loader2, Printer, ShieldCheck, UserMinus, Users, X,
} from 'lucide-react';
import { api, errorText, API_BASE, getToken } from '../../services/api';
import { Notice } from '../ui/Feedback';
import TextField from '../ui/TextField';

/**
 * The appointment register — the one place a post changes hands.
 *
 * Who held a post used to be recorded in two places and written from six: the
 * organogram, the unit profile, the personnel register, staff registration, a
 * quick-assignment form, and a Unit Supervisors board in another module. None
 * of them consulted the others, so a laboratory appointed a new supervisor and
 * the old one stayed — on the staff register, and in the permission resolver,
 * which reads a person's access off exactly those appointment rows.
 *
 * Everything to do with who holds what is therefore here, and nowhere else:
 *
 *   SUBSTANTIVE — who holds the post. An office has one holder; appointing a
 *   successor ends the predecessor's appointment, and the unit changes hands
 *   with it.
 *
 *   ACTING — who is in charge while the holder is away. A stand-in for a fixed
 *   period that reverts on its own, which is a different question from who
 *   holds the post, so the register answers both side by side.
 *
 *   A GRADE IS NOT AN OFFICE. Everybody graded into "Laboratory Technician"
 *   holds it, and appointing one more displaces nobody.
 */

type Holder = { staffId: number; name: string; since: string | null } | null;

type Post = {
  id: number; title: string; isActive: boolean; isOffice: boolean;
  reportsToPositionId: number | null;
  supervisesSectionId: number | null; supervisesSectionName: string | null;
  holder: Holder; deputy: Holder;
  graded: Array<{ staffId: number; name: string }>;
  accessProfile: string | null;
};

type Unit = {
  id: number; name: string; departmentName: string | null;
  postId: number | null; postTitle: string | null;
  supervisorStaffId: number | null; supervisorName: string | null;
  actingId: number | null; actingStaffId: number | null; actingName: string | null;
  actingFrom: string | null; actingUntil: string | null; actingReason: string | null;
  inChargeStaffId: number | null; inChargeName: string | null;
};

type Acting = {
  id: number; sectionId: number; sectionName: string;
  actingStaffId: number; actingName: string; substantiveName: string | null;
  startDate: string; endDate: string; reason: string | null; status: string; inForce: boolean;
};

type Person = { staffId: number; name: string; sectionName: string | null; posts: string[] };

type Register = {
  posts: Post[]; units: Unit[]; acting: Acting[]; people: Person[]; conflicts: string[];
  may: { appoint: boolean; acting: boolean; endActing: boolean; deleteActing: boolean; print: boolean };
};

const VIEWS = ['Unit supervisors', 'Appointed posts', 'Acting appointments'] as const;
type View = (typeof VIEWS)[number];

const today = () => new Date().toISOString().slice(0, 10);
const inAMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

export default function Appointments() {
  const [register, setRegister] = useState<Register | null>(null);
  const [view, setView] = useState<View>('Unit supervisors');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [appointing, setAppointing] = useState<{ post: Post; kind: 'holder' | 'deputy' } | null>(null);
  const [standingIn, setStandingIn] = useState<Unit | null>(null);

  const load = useCallback(async () => {
    try { setRegister(await api<Register>('/appointments')); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const offices = useMemo(() => (register?.posts ?? []).filter(p => p.isOffice && p.isActive), [register]);
  const grades = useMemo(() => (register?.posts ?? []).filter(p => !p.isOffice && p.isActive), [register]);

  const hit = (...text: Array<string | null | undefined>) => !search.trim()
    || text.some(t => String(t ?? '').toLowerCase().includes(search.trim().toLowerCase()));

  async function act(what: () => Promise<{ summary?: string } | void>, fallback: string) {
    setBusy(true); setProblem(null);
    try {
      const outcome = await what();
      setNotice((outcome as { summary?: string })?.summary ?? fallback);
      await load();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  const vacate = (post: Post, staffId: number) => {
    if (!window.confirm(`End this appointment? ${post.title} will be vacant until somebody is appointed to it.`)) return;
    void act(() => api('/appointments/vacate', {
      method: 'POST', body: JSON.stringify({ positionId: post.id, staffId }),
    }), 'The appointment has ended.');
  };

  const supervise = (post: Post, sectionId: string) => void act(
    () => api(`/appointments/posts/${post.id}/supervises`, {
      method: 'PUT', body: JSON.stringify({ sectionId: sectionId ? Number(sectionId) : null }),
    }),
    sectionId ? `${post.title} now supervises that unit.` : `${post.title} no longer supervises a unit.`);

  const endActing = (row: { id: number }) => void act(
    () => api(`/scheduling/acting-unit-heads/${row.id}/end`, { method: 'POST', body: JSON.stringify({}) }),
    'The acting period has ended; the substantive supervisor resumes.');

  const deleteActing = (row: Acting) => {
    if (!window.confirm('Delete this acting appointment from the record?')) return;
    void act(() => api(`/scheduling/acting-unit-heads/${row.id}`, { method: 'DELETE' }), 'Acting appointment deleted.');
  };

  async function print() {
    try {
      const response = await fetch(`${API_BASE}/scheduling/unit-supervisors/print`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!response.ok) throw new Error('The unit supervisor list could not be printed.');
      const page = window.open('', '_blank');
      if (!page) return setProblem('Allow pop-ups to print this list.');
      page.document.write(await response.text());
      page.document.close();
    } catch (e) { setProblem(errorText(e)); }
  }

  if (!register) return <p className="muted">Reading the appointment register…</p>;

  const counts = {
    units: register.units.length,
    vacant: register.units.filter(u => u.postId && !u.supervisorStaffId).length,
    unposted: register.units.filter(u => !u.postId).length,
    acting: register.units.filter(u => u.actingId).length,
    offices: offices.length,
    officesVacant: offices.filter(p => !p.holder).length,
  };
  const may = register.may;

  return (
    <div className="appt">
      {problem && <Notice kind="error">{problem}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <header className="appt-head">
        <div>
          <h3><ShieldCheck size={16} /> Appointments</h3>
          <p className="muted">
            The one place a post changes hands. An office has one holder, a unit has one supervisor, and a person
            may hold several posts. Every other screen shows what is recorded here.
          </p>
        </div>
        <div className="appt-head-acts">
          {may.print && (
            <button type="button" className="btn ghost" onClick={() => void print()}>
              <Printer size={13} /> Print
            </button>
          )}
          <TextField value={search} onValue={setSearch} placeholder="Find a unit, a post or a person" />
        </div>
      </header>

      <div className="appt-stats">
        <Tile label="Units" value={counts.units} />
        <Tile label="Supervisor vacant" value={counts.vacant} tone={counts.vacant ? 'warn' : 'ok'} />
        <Tile label="No supervising post" value={counts.unposted} tone={counts.unposted ? 'warn' : 'ok'} />
        <Tile label="Acting today" value={counts.acting} />
        <Tile label="Appointed posts" value={counts.offices} />
        <Tile label="Posts vacant" value={counts.officesVacant} tone={counts.officesVacant ? 'warn' : 'ok'} />
      </div>

      {register.conflicts.length > 0 && (
        <div className="appt-conflicts">
          <strong><AlertTriangle size={13} /> {register.conflicts.length} thing(s) the register cannot reconcile</strong>
          <ul>{register.conflicts.map(c => <li key={c}>{c}</li>)}</ul>
        </div>
      )}

      <nav className="appt-views" aria-label="Appointment register">
        {VIEWS.map(v => (
          <button key={v} type="button" className={view === v ? 'is-on' : ''} onClick={() => setView(v)}>
            {v === 'Unit supervisors' ? <Users size={13} /> : v === 'Acting appointments' ? <CalendarClock size={13} /> : <ShieldCheck size={13} />}
            {v}
            {v === 'Acting appointments' && register.acting.length > 0 && (
              <span className="appt-pill">{register.acting.filter(a => a.inForce).length}</span>
            )}
          </button>
        ))}
      </nav>

      {/* ---------------------------------------------------- unit supervisors */}
      {view === 'Unit supervisors' && (
        <section className="appt-panel">
          <div className="appt-panel-head">
            <h4>Who runs each unit</h4>
            <span className="muted">
              The holder of the unit's supervising post runs it. A stand-in covers a fixed period and reverts on its own.
            </span>
          </div>
          <div className="appt-table-wrap">
            <table className="data-table appt-table">
              <thead>
                <tr>
                  <th>Unit</th><th>Supervising post</th><th>Substantive supervisor</th>
                  <th>In charge today</th><th />
                </tr>
              </thead>
              <tbody>
                {register.units
                  .filter(u => hit(u.name, u.departmentName, u.supervisorName, u.inChargeName, u.postTitle))
                  .map(unit => {
                    const post = offices.find(p => p.id === unit.postId) ?? null;
                    return (
                      <tr key={unit.id}>
                        <td>
                          <strong>{unit.name}</strong>
                          {unit.departmentName && <span className="appt-sub">{unit.departmentName}</span>}
                        </td>
                        <td>
                          {unit.postTitle ?? (
                            may.appoint ? (
                              <select defaultValue="" disabled={busy} className="appt-inline"
                                onChange={e => { const id = e.target.value; e.target.value = ''; if (id) supervise(offices.find(p => p.id === Number(id))!, String(unit.id)); }}>
                                <option value="">Name the supervising post…</option>
                                {offices.filter(p => !p.supervisesSectionId).map(p => (
                                  <option key={p.id} value={p.id}>{p.title}</option>
                                ))}
                              </select>
                            ) : <span className="muted">None named</span>
                          )}
                        </td>
                        <td>
                          {unit.supervisorName
                            ? unit.supervisorName
                            : unit.postTitle ? <span className="badge overdue">Vacant</span> : <span className="muted">—</span>}
                        </td>
                        <td>
                          {unit.inChargeName ?? <span className="muted">—</span>}
                          {unit.actingId && (
                            <>
                              <span className="badge acting">Acting</span>
                              <span className="appt-sub">
                                until {unit.actingUntil}{unit.actingReason ? ` · ${unit.actingReason}` : ''}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="appt-actions">
                          {post && may.appoint && (
                            <button type="button" className="btn ghost" onClick={() => setAppointing({ post, kind: 'holder' })}>
                              <ArrowRightLeft size={12} /> {unit.supervisorName ? 'Change supervisor' : 'Appoint'}
                            </button>
                          )}
                          {unit.actingId
                            ? may.endActing && (
                              <button type="button" className="btn ghost" disabled={busy}
                                onClick={() => endActing({ id: unit.actingId! })}>End acting</button>
                            )
                            : may.acting && (
                              <button type="button" className="btn ghost" onClick={() => setStandingIn(unit)}>
                                <CalendarClock size={12} /> Appoint acting
                              </button>
                            )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {counts.unposted > 0 && (
            <p className="appt-note muted">
              {counts.unposted} unit(s) have no supervising post named. Until one is, nothing keeps the unit's
              supervisor in step with an appointment.
            </p>
          )}
        </section>
      )}

      {/* ------------------------------------------------------ appointed posts */}
      {view === 'Appointed posts' && (
        <>
          <section className="appt-panel">
            <div className="appt-panel-head">
              <h4>Appointed posts</h4>
              <span className="muted">Held by one person at a time. A deputy stands in without holding the post.</span>
            </div>
            <div className="appt-table-wrap">
              <table className="data-table appt-table">
                <thead>
                  <tr><th>Post</th><th>Supervises</th><th>Holder</th><th>Deputy</th><th /></tr>
                </thead>
                <tbody>
                  {offices.filter(p => hit(p.title, p.holder?.name, p.deputy?.name, p.supervisesSectionName)).map(post => (
                    <tr key={post.id}>
                      <td>
                        <strong>{post.title}</strong>
                        {/* What the post is worth, beside the post rather than
                            in a column of its own — it is read, never acted on
                            here, and the actions need the width. */}
                        {post.accessProfile && <span className="appt-sub">Access: {post.accessProfile}</span>}
                      </td>
                      <td>
                        {may.appoint ? (
                          <select value={post.supervisesSectionId ?? ''} disabled={busy} className="appt-inline"
                            onChange={e => supervise(post, e.target.value)}>
                            <option value="">— not a unit post —</option>
                            {register.units
                              .filter(u => !u.postId || u.postId === post.id)
                              .map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                          </select>
                        ) : (post.supervisesSectionName ?? <span className="muted">—</span>)}
                      </td>
                      <td>
                        {post.holder
                          ? <>{post.holder.name}{post.holder.since && <span className="appt-sub">since {String(post.holder.since).slice(0, 10)}</span>}</>
                          : <span className="badge overdue">Vacant</span>}
                      </td>
                      <td>{post.deputy ? post.deputy.name : <span className="muted">—</span>}</td>
                      <td className="appt-actions">
                        {may.appoint && (
                          <>
                            <button type="button" className="btn ghost" onClick={() => setAppointing({ post, kind: 'holder' })}>
                              {post.holder ? 'Change holder' : 'Appoint'}
                            </button>
                            <button type="button" className="btn ghost" onClick={() => setAppointing({ post, kind: 'deputy' })}>
                              {post.deputy ? 'Change deputy' : 'Add deputy'}
                            </button>
                            {post.holder && (
                              <button type="button" className="btn ghost" disabled={busy}
                                onClick={() => vacate(post, post.holder!.staffId)}>
                                <UserMinus size={12} /> Vacate
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {grades.length > 0 && (
            <details className="appt-grades">
              <summary>{grades.length} graded post(s) — held by everybody graded into them</summary>
              <div className="appt-table-wrap">
                <table className="data-table appt-table">
                  <thead><tr><th>Grade</th><th className="num">Held by</th><th>Who</th></tr></thead>
                  <tbody>
                    {grades.filter(g => hit(g.title, ...g.graded.map(x => x.name))).map(grade => (
                      <tr key={grade.id}>
                        <td>{grade.title}</td>
                        <td className="num">{grade.graded.length}</td>
                        <td className="muted">{grade.graded.map(g => g.name).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}

      {/* --------------------------------------------------- acting appointments */}
      {view === 'Acting appointments' && (
        <section className="appt-panel">
          <div className="appt-panel-head">
            <h4>Acting appointments</h4>
            <span className="muted">
              A stand-in runs the unit for a fixed period. It reverts on its own when the period ends.
            </span>
            {may.acting && (
              <button type="button" className="btn" onClick={() => setStandingIn(register.units[0] ?? null)}>
                <CalendarClock size={13} /> Appoint acting supervisor
              </button>
            )}
          </div>
          <div className="appt-table-wrap">
            <table className="data-table appt-table">
              <thead>
                <tr><th>Unit</th><th>Acting supervisor</th><th>Standing in for</th><th>Period</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {register.acting.filter(a => hit(a.sectionName, a.actingName, a.substantiveName, a.reason)).map(row => (
                  <tr key={row.id} className={row.inForce ? 'is-live' : ''}>
                    <td><strong>{row.sectionName}</strong></td>
                    <td>
                      {row.actingName}
                      {row.reason && <span className="appt-sub">{row.reason}</span>}
                    </td>
                    <td>{row.substantiveName ?? <span className="muted">—</span>}</td>
                    <td className="muted">{row.startDate} → {row.endDate}</td>
                    <td>
                      {row.inForce
                        ? <span className="badge acting">In force</span>
                        : <span className="badge">{row.status === 'active' ? 'Scheduled' : row.status}</span>}
                    </td>
                    <td className="appt-actions">
                      {row.status === 'active' && row.inForce && may.endActing && (
                        <button type="button" className="btn ghost" disabled={busy} onClick={() => endActing(row)}>End now</button>
                      )}
                      {may.deleteActing && (
                        <button type="button" className="btn ghost" disabled={busy} onClick={() => deleteActing(row)}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
                {register.acting.length === 0 && (
                  <tr><td colSpan={6} className="muted">No acting appointment has been recorded.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {appointing && (
        <AppointDialog
          post={appointing.post} kind={appointing.kind} people={register.people} units={register.units}
          onClose={() => setAppointing(null)}
          onDone={async (message) => { setAppointing(null); setNotice(message); await load(); }}
          onProblem={setProblem} />
      )}

      {standingIn && (
        <ActingDialog
          unit={standingIn} units={register.units} people={register.people}
          onClose={() => setStandingIn(null)}
          onDone={async (message) => { setStandingIn(null); setNotice(message); await load(); }}
          onProblem={setProblem} />
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className={`appt-tile${tone ? ` t-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Appointing somebody — and saying what it will do first
   ------------------------------------------------------------------------- */
function AppointDialog({ post, kind, people, units, onClose, onDone, onProblem }: {
  post: Post; kind: 'holder' | 'deputy';
  people: Person[]; units: Unit[];
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onProblem: (message: string) => void;
}) {
  const [staffId, setStaffId] = useState('');
  const [note, setNote] = useState('');
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);

  const current = kind === 'holder' ? post.holder : post.deputy;
  const chosen = people.find(p => p.staffId === Number(staffId)) ?? null;
  const unit = units.find(u => u.id === post.supervisesSectionId) ?? null;
  const shown = people.filter(p => !find.trim() || p.name.toLowerCase().includes(find.trim().toLowerCase()));

  async function save() {
    if (!staffId) return onProblem('Choose who is being appointed.');
    setBusy(true);
    try {
      const outcome = await api<{ summary: string }>('/appointments', {
        method: 'POST',
        body: JSON.stringify({ positionId: post.id, staffId: Number(staffId), kind, note: note || undefined }),
      });
      await onDone(outcome.summary);
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{kind === 'deputy' ? 'Deputy for' : 'Appoint to'} {post.title}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        <p className="iqc-modal-lead">
          {current ? `${current.name} holds it now.` : kind === 'deputy' ? 'There is no deputy.' : 'The post is vacant.'}
          {unit ? ` It supervises ${unit.name}.` : ''}
        </p>

        <label className="stack">
          <span>Who</span>
          <TextField value={find} onValue={setFind} placeholder="Find a member of staff" />
          <select value={staffId} size={8} className="appt-people" onChange={e => setStaffId(e.target.value)}>
            {shown.map(person => (
              <option key={person.staffId} value={person.staffId}>
                {person.name}
                {person.sectionName ? ` · ${person.sectionName}` : ''}
                {person.posts.length ? ` · holds ${person.posts.join(', ')}` : ''}
              </option>
            ))}
          </select>
        </label>

        {/* Somebody is being removed from a post. That is never a surprise. */}
        {chosen && (
          <div className="appt-consequence">
            <strong>What this does</strong>
            <ul>
              <li>{chosen.name} holds {post.title}{kind === 'deputy' ? ' as deputy' : ''}.</li>
              {current && <li>{current.name}’s appointment to it ends.</li>}
              {kind === 'holder' && unit && <li>{unit.name} is run by {chosen.name}, and their staff record moves to it.</li>}
              {chosen.posts.length > 0 && (
                <li className="muted">They keep {chosen.posts.join(', ')} — a person may hold several posts.</li>
              )}
            </ul>
          </div>
        )}

        <label className="stack">
          <span>Note</span>
          <TextField value={note} onValue={setNote} placeholder="Why the appointment was made — kept on the record" />
        </label>

        <div className="pr-btns">
          <button type="button" disabled={busy || !staffId} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="pd-spin" /> : null} Record the appointment
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Standing somebody in, for a fixed period
   ------------------------------------------------------------------------- */
function ActingDialog({ unit, units, people, onClose, onDone, onProblem }: {
  unit: Unit; units: Unit[]; people: Person[];
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onProblem: (message: string) => void;
}) {
  const [sectionId, setSectionId] = useState(String(unit.id));
  const [staffId, setStaffId] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(inAMonth());
  const [reason, setReason] = useState('');
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);

  const target = units.find(u => String(u.id) === sectionId) ?? unit;
  const shown = people
    .filter(p => p.staffId !== target.supervisorStaffId)
    .filter(p => !find.trim() || p.name.toLowerCase().includes(find.trim().toLowerCase()));
  const chosen = people.find(p => p.staffId === Number(staffId)) ?? null;

  async function save() {
    if (!staffId) return onProblem('Choose who will stand in.');
    if (endDate < startDate) return onProblem('The acting period ends before it begins.');
    setBusy(true);
    try {
      await api('/scheduling/acting-unit-heads', {
        method: 'POST',
        body: JSON.stringify({
          sectionId: Number(sectionId), actingStaffId: Number(staffId),
          startDate, endDate, reason: reason || undefined,
        }),
      });
      await onDone(`${chosen?.name ?? 'The stand-in'} is acting supervisor of ${target.name} until ${endDate}.`);
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>Appoint an acting unit supervisor</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          A stand-in runs the unit for a fixed period and reverts on its own when it ends. The post itself does not
          change hands.
        </p>

        <div className="appt-form">
          <label className="stack">
            <span>Unit</span>
            <select value={sectionId} onChange={e => setSectionId(e.target.value)}>
              {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
          <label className="stack">
            <span>Substantive supervisor</span>
            <span className="appt-readonly">{target.supervisorName ?? 'Vacant'}</span>
          </label>
          <label className="stack">
            <span>From</span>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          </label>
          <label className="stack">
            <span>Until</span>
            <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
          </label>
        </div>

        <label className="stack">
          <span>Who stands in</span>
          <TextField value={find} onValue={setFind} placeholder="Find a member of staff" />
          <select value={staffId} size={6} className="appt-people" onChange={e => setStaffId(e.target.value)}>
            {shown.map(person => (
              <option key={person.staffId} value={person.staffId}>
                {person.name}{person.sectionName ? ` · ${person.sectionName}` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="stack">
          <span>Reason</span>
          <TextField value={reason} onValue={setReason} placeholder="e.g. Substantive supervisor on annual leave" />
        </label>

        <div className="pr-btns">
          <button type="button" disabled={busy || !staffId} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="pd-spin" /> : null} Appoint
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where a post is changed, said once and linked from everywhere that used to
 * change one. Exported so the screens that no longer appoint can point here in
 * the same words.
 */
export function AppointmentPointer({ what }: { what: string }) {
  return (
    <p className="appt-pointer">
      <ShieldCheck size={12} />
      {what} is held in the appointment register: <strong>Settings → People &amp; Access → Positions &amp; Organogram
      → Appointments</strong>. Changing it there changes it everywhere.
    </p>
  );
}
