import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ClipboardList,
  Loader2, Plus, ShieldAlert, SlidersHorizontal, X, XCircle,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../ui/TextField';
import { Notice } from '../ui/Feedback';
import {
  EXEMPTION_GROUNDS, EXEMPTION_GROUND_LABELS, IQC_SHIFTS, OCCURRENCE_STATE_LABELS,
  PROGRAMME_FREQUENCIES, PROGRAMME_FREQUENCY_HINTS, PROGRAMME_FREQUENCY_LABELS,
  WEEKDAYS, WEEKDAY_SHORT,
  type ExemptionGround, type IqcShift, type OccurrenceState, type ProgrammeFrequency, type Weekday,
} from '../../../shared/constants/iqcProgramme';

/**
 * The internal quality control programme, on one screen.
 *
 * It answers the question a register of runs cannot: WAS THE PLAN FOLLOWED?
 * Three things in the order a supervisor needs them —
 *
 *   which examinations are in the programme, and which have nothing covering
 *   them; what each control was expected to do and what it actually did, day
 *   by day; and what is still open — the runs nobody recorded, and the
 *   failures nobody has signed off.
 *
 * Every gap it shows carries the action that closes it, because a screen that
 * reports a missed control and leaves somebody to find the form is a screen
 * that gets read once. A missed day is closed by recording the run on the day
 * it was actually performed, or by stating why it was not run. Nothing here
 * accepts a run or decides anything: it shows the gaps and opens the form.
 */

type Schedule = {
  frequency: ProgrammeFrequency;
  weekdays: Weekday[];
  shifts: IqcShift[];
  startsOn: string | null;
  endsOn: string | null;
  isActive: boolean;
  isDefault: boolean;
  notes: string | null;
  summary: string;
};

type Day = {
  date: string;
  shift: IqcShift | null;
  state: OccurrenceState;
  runId: number | null;
  runNumber: string | null;
  runStatus: string | null;
  reason: string | null;
  missedId: number | null;
};

type ProgrammeControl = {
  id: number; materialName: string; testName: string; levelLabel: string | null; lotNumber: string;
  controlType: string; equipmentId: number | null; equipmentName: string | null;
  expired: boolean; recordingBasis: string; analyteCount: number;
  schedule: Schedule; days: Day[];
  expected: number; performed: number; missed: number; excused: number; rejected: number; due: number;
  compliance: number | null; lastRunDate: string | null; oldestMissed: string | null;
};

type CoverageTest = {
  id: number; testCode: string | null; testName: string; equipmentName: string | null;
  controls: Array<{ id: number; materialName: string; levelLabel: string | null; lotNumber: string }>;
  covered: boolean;
  exemption: {
    id: number; ground: string; reason: string; reviewOn: string | null;
    approvedBy: string | null; recordedAt: string; overdue: boolean;
  } | null;
};

type Programme = {
  from: string; to: string; sectionId: number | null; sectionName: string | null;
  controls: ProgrammeControl[];
  coverage: CoverageTest[];
  counts: {
    controls: number; scheduled: number; expected: number; performed: number; missed: number;
    excused: number; rejected: number; due: number; compliance: number | null;
    examinations: number; covered: number; exempt: number; uncovered: number; exemptionsDue: number;
    awaitingReview: number; resultsWithheld: number;
  };
  units: Array<{ id: number; name: string }>;
  canChooseUnit: boolean;
  canPlan: boolean;
  canExempt: boolean;
  canRecord: boolean;
};

/** The run a missed day is waiting for. */
export type RunTarget = { materialId: number; materialName: string; date: string; shift: IqcShift | null };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

/** The worst thing that happened on one day, for the cell that stands for it. */
const WORST: OccurrenceState[] = ['rejected', 'missed', 'warning', 'excused', 'due', 'in_control', 'not_scheduled'];
function worstOf(days: Day[]): OccurrenceState {
  for (const state of WORST) if (days.some(d => d.state === state)) return state;
  return 'not_scheduled';
}

export default function ControlProgramme({ sectionId, onRecordRun, onDefineControl, onOpenReview }: {
  /**
   * The unit to answer for, where the screen around this one already chooses.
   *
   * The bench's board carries a unit picker of its own, and two pickers
   * answering the same question on one page is one too many. Given, this one
   * follows it and draws none.
   */
  sectionId?: number | null;
  /** Open the run form on the day a control was missed. */
  onRecordRun?: (target: RunTarget) => void;
  /** Open the form that defines a control for an uncontrolled examination. */
  onDefineControl?: (test: { id: number; testName: string }) => void;
  /** Where failures and sign-offs are dealt with. */
  onOpenReview?: () => void;
}) {
  const [month, setMonth] = useState(() => new Date());
  const [unitId, setUnitId] = useState<string>(sectionId != null ? String(sectionId) : '');
  const [programme, setProgramme] = useState<Programme | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** The day whose account is being read or written. */
  const [openDay, setOpenDay] = useState<{ control: ProgrammeControl; date: string; days: Day[] } | null>(null);
  /** The control whose plan is being written. */
  const [planning, setPlanning] = useState<ProgrammeControl | null>(null);
  /** The examination being taken out of the programme. */
  const [exempting, setExempting] = useState<CoverageTest | null>(null);

  const from = monthStart(month);
  const to = monthEnd(month);

  const load = useCallback(async () => {
    setLoading(true);
    const query = new URLSearchParams({ from, to });
    const unit = sectionId != null ? String(sectionId) : unitId;
    if (unit) query.set('sectionId', unit);
    try {
      const answer = await api<Programme>(`/iqc/programme?${query}`);
      setProgramme(answer);
      // The picker says which unit this is, so it must say the one the host
      // actually answered for rather than whichever option happens to be first.
      if (!unit && answer.sectionId != null) setUnitId(String(answer.sectionId));
      setProblem(null);
    } catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, [from, to, unitId, sectionId]);

  useEffect(() => { void load(); }, [load]);
  // The board above may move to another unit while this is open.
  useEffect(() => { if (sectionId != null) setUnitId(String(sectionId)); }, [sectionId]);

  const days = useMemo(() => {
    const out: string[] = [];
    const end = new Date(`${to}T00:00:00Z`).getTime();
    for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end; t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }, [from, to]);

  const counts = programme?.counts;
  const uncovered = (programme?.coverage ?? []).filter(t => !t.covered && !t.exemption);
  const exempt = (programme?.coverage ?? []).filter(t => t.exemption);
  const outstanding = (programme?.controls ?? [])
    .flatMap(control => control.days.filter(d => d.state === 'missed').map(day => ({ control, day })))
    .sort((a, b) => a.day.date.localeCompare(b.day.date));

  /** Controls grouped by the instrument they run on, as the bench thinks of them. */
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; controls: ProgrammeControl[] }>();
    for (const control of programme?.controls ?? []) {
      const key = control.equipmentId ? `eq:${control.equipmentId}` : 'manual';
      const group = map.get(key) ?? { name: control.equipmentName || 'Manual and near-patient methods', controls: [] };
      group.controls.push(control);
      map.set(key, group);
    }
    return [...map.values()];
  }, [programme]);

  const stepMonth = (by: number) => setMonth(current => {
    const next = new Date(current);
    next.setUTCMonth(next.getUTCMonth() + by, 1);
    return next;
  });

  return (
    <div className="iqcp">
      <div className="iqcp-head">
        <div>
          <h3><ClipboardList size={16} /> Internal quality control programme</h3>
          <p className="muted">
            What each control is expected to do, what was done, and what is still outstanding.
          </p>
        </div>
        <div className="iqcp-period">
          {sectionId == null && programme?.canChooseUnit && programme.units.length > 1 && (
            <select value={unitId} onChange={e => setUnitId(e.target.value)} aria-label="Unit">
              {programme.units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <button type="button" className="secondary" onClick={() => stepMonth(-1)} aria-label="Previous month">
            <ChevronLeft size={14} />
          </button>
          <strong><CalendarDays size={13} /> {MONTHS[month.getUTCMonth()]} {month.getUTCFullYear()}</strong>
          <button type="button" className="secondary" onClick={() => stepMonth(1)} aria-label="Next month">
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {problem && <Notice kind="error">{problem}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {loading && !programme ? <p className="muted">Reading the programme…</p> : !programme ? null
        : programme.sectionId == null ? (
          <p className="muted">
            Your account is not linked to a unit, so there is no test menu to answer for. Ask an administrator to
            set it, or choose a unit above.
          </p>
        ) : (
        <>
          {/* What the programme comes to, in the two numbers that matter:
              is every examination covered, and was every scheduled run done. */}
          <div className="iqcp-stats">
            <Tile label="Examinations" value={counts!.examinations} />
            <Tile label="Controlled" value={counts!.covered} tone="ok" />
            <Tile label="Not controlled" value={counts!.uncovered} tone={counts!.uncovered ? 'crit' : 'ok'} />
            <Tile label="Out of the programme" value={counts!.exempt} />
            <Tile label="Runs scheduled" value={counts!.expected} />
            <Tile label="Performed" value={counts!.performed} tone="ok" />
            <Tile label="Not run" value={counts!.missed} tone={counts!.missed ? 'crit' : 'ok'} />
            <Tile label="Compliance"
              value={counts!.compliance == null ? '—' : `${counts!.compliance}%`}
              tone={counts!.compliance == null ? undefined : counts!.compliance >= 95 ? 'ok' : counts!.compliance >= 80 ? 'warn' : 'crit'} />
          </div>

          {(counts!.awaitingReview > 0 || counts!.resultsWithheld > 0) && (
            <p className="iqcp-banner">
              <ShieldAlert size={13} />
              {counts!.awaitingReview} run{counts!.awaitingReview === 1 ? '' : 's'} awaiting review
              {counts!.resultsWithheld > 0 && `, and patient results withheld on ${counts!.resultsWithheld}`}.
              {onOpenReview && (
                <button type="button" className="pq-link" onClick={onOpenReview}>Open the review register</button>
              )}
            </p>
          )}

          {/* ---------------------------------------------------- coverage */}
          <section className="iqcp-panel">
            <div className="iqcp-panel-head">
              <h4>Examinations awaiting a control</h4>
              <span className="muted">
                {uncovered.length === 0
                  ? 'Every examination on this unit’s menu is either controlled or formally out of the programme.'
                  : `${uncovered.length} examination${uncovered.length === 1 ? '' : 's'} on the menu with no control against ${uncovered.length === 1 ? 'it' : 'them'}.`}
              </span>
            </div>
            {uncovered.length > 0 && (
              <ul className="iqcp-gaps">
                {uncovered.map(test => (
                  <li key={test.id}>
                    <div>
                      <strong>{test.testName}</strong>
                      <span className="muted">
                        {test.testCode ? `${test.testCode}` : 'No code'}
                        {test.equipmentName ? ` · ${test.equipmentName}` : ''}
                      </span>
                    </div>
                    {onDefineControl && programme.canRecord && (
                      <button type="button" className="tiny"
                        onClick={() => onDefineControl({ id: test.id, testName: test.testName })}>
                        <Plus size={11} /> Define a control
                      </button>
                    )}
                    {programme.canExempt && (
                      <button type="button" className="tiny secondary" onClick={() => setExempting(test)}>
                        Leave out of the programme
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {exempt.length > 0 && (
              <details className="iqcp-exempt">
                <summary>{exempt.length} examination{exempt.length === 1 ? '' : 's'} out of the programme
                  {counts!.exemptionsDue > 0 && <span className="badge overdue">{counts!.exemptionsDue} due for review</span>}
                </summary>
                <ul className="iqcp-gaps">
                  {exempt.map(test => (
                    <li key={test.id}>
                      <div>
                        <strong>{test.testName}</strong>
                        <span className="muted">
                          {EXEMPTION_GROUND_LABELS[test.exemption!.ground as ExemptionGround] ?? test.exemption!.ground}
                          {' — '}{test.exemption!.reason}
                        </span>
                        <span className={`muted${test.exemption!.overdue ? ' crit' : ''}`}>
                          {test.exemption!.approvedBy ? `Decided by ${test.exemption!.approvedBy}` : 'Decided'}
                          {test.exemption!.reviewOn ? ` · review ${test.exemption!.reviewOn}` : ''}
                          {test.exemption!.overdue ? ' · overdue' : ''}
                        </span>
                      </div>
                      {programme.canExempt && (
                        <button type="button" className="tiny secondary"
                          onClick={() => void withdrawExemption(test)}>Bring back in</button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          {/* ---------------------------------------------------- schedule */}
          <section className="iqcp-panel">
            <div className="iqcp-panel-head">
              <h4>Control schedule</h4>
              <div className="iqcp-legend">
                {(['in_control', 'warning', 'rejected', 'missed', 'excused', 'due'] as OccurrenceState[]).map(state => (
                  <span key={state}><i className={`iqcp-key s-${state}`} /> {OCCURRENCE_STATE_LABELS[state]}</span>
                ))}
              </div>
            </div>

            {programme.controls.length === 0 ? (
              <p className="muted">No control is registered for this unit yet.</p>
            ) : groups.map(group => (
              <div key={group.name} className="iqcp-group">
                <h5>{group.name}</h5>
                <div className="iqcp-grid-wrap">
                  <table className="iqcp-grid">
                    <thead>
                      <tr>
                        <th className="iqcp-name">Control</th>
                        {days.map(date => (
                          <th key={date} className="iqcp-day" title={date}>{Number(date.slice(8, 10))}</th>
                        ))}
                        <th className="iqcp-num">Done</th>
                        <th className="iqcp-num">Not run</th>
                        <th className="iqcp-num">%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.controls.map(control => (
                        <tr key={control.id}>
                          <th className="iqcp-name">
                            <button type="button" className="iqcp-plan" onClick={() => setPlanning(control)}
                              title="Set what this control is expected to do">
                              <strong>{control.materialName}{control.levelLabel ? ` — ${control.levelLabel}` : ''}</strong>
                              <span className="muted">
                                {control.testName} · lot {control.lotNumber}
                              </span>
                              <span className="iqcp-sched">
                                <SlidersHorizontal size={10} /> {control.schedule.summary}
                                {control.schedule.isDefault ? ' (from its frequency)' : ''}
                              </span>
                            </button>
                          </th>
                          {days.map(date => {
                            const onDay = control.days.filter(d => d.date === date);
                            const state = onDay.length ? worstOf(onDay) : 'not_scheduled';
                            const label = onDay.length
                              ? `${date} · ${OCCURRENCE_STATE_LABELS[state]}`
                              : `${date} · not scheduled`;
                            return (
                              <td key={date}>
                                {/* The day in words for a reader who cannot
                                    see the colour, on the control itself —
                                    colour alone is not a message. */}
                                <button type="button" className={`iqcp-cell s-${state}`} title={label}
                                  aria-label={label} disabled={!onDay.length}
                                  onClick={() => setOpenDay({ control, date, days: onDay })} />
                              </td>
                            );
                          })}
                          <td className="iqcp-num">{control.performed}</td>
                          <td className={`iqcp-num${control.missed ? ' crit' : ''}`}>{control.missed}</td>
                          <td className="iqcp-num">{control.compliance == null ? '—' : `${control.compliance}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          {/* ------------------------------------------------- outstanding */}
          <section className="iqcp-panel">
            <div className="iqcp-panel-head">
              <h4>Runs not accounted for</h4>
              <span className="muted">
                {outstanding.length === 0
                  ? 'Every scheduled run in this period was performed or accounted for.'
                  : 'Record the run on the day it was performed, or state why it was not run. Oldest first.'}
              </span>
            </div>
            {outstanding.length > 0 && (
              <ul className="iqcp-missed">
                {outstanding.slice(0, 60).map(({ control, day }) => (
                  <li key={`${control.id}-${day.date}-${day.shift ?? ''}`}>
                    <div>
                      <strong>{day.date}{day.shift ? ` · ${day.shift}` : ''}</strong>
                      <span className="muted">
                        {control.materialName}{control.levelLabel ? ` — ${control.levelLabel}` : ''} · {control.testName}
                      </span>
                    </div>
                    {programme.canRecord && onRecordRun && (
                      <button type="button" className="tiny" onClick={() => onRecordRun({
                        materialId: control.id, materialName: control.materialName, date: day.date, shift: day.shift,
                      })}>Record this run</button>
                    )}
                    {programme.canRecord && (
                      <button type="button" className="tiny secondary"
                        onClick={() => setOpenDay({ control, date: day.date, days: [day] })}>Account for it</button>
                    )}
                  </li>
                ))}
                {outstanding.length > 60 && (
                  <li className="muted">
                    and {outstanding.length - 60} more in this period. Narrow the period to work through them.
                  </li>
                )}
              </ul>
            )}
          </section>
        </>
      )}

      {openDay && programme && (
        <DayDialog
          control={openDay.control} date={openDay.date} days={openDay.days}
          canRecord={programme.canRecord}
          onRecordRun={onRecordRun}
          onClose={() => setOpenDay(null)}
          onDone={async (message) => { setOpenDay(null); setNotice(message); await load(); }}
          onProblem={setProblem} />
      )}

      {planning && (
        <PlanDialog control={planning} onClose={() => setPlanning(null)}
          canPlan={programme?.canPlan ?? false}
          onSaved={async () => { setPlanning(null); setNotice('The schedule is saved.'); await load(); }}
          onProblem={setProblem} />
      )}

      {exempting && (
        <ExemptDialog test={exempting} onClose={() => setExempting(null)}
          onSaved={async () => { setExempting(null); setNotice('The examination is out of the programme, with the ground on the record.'); await load(); }}
          onProblem={setProblem} />
      )}
    </div>
  );

  async function withdrawExemption(test: CoverageTest) {
    if (!test.exemption) return;
    try {
      await api(`/iqc/programme/exemptions/${test.exemption.id}/withdraw`, {
        method: 'POST', body: JSON.stringify({ reason: 'Brought back into the programme.' }),
      });
      setNotice(`${test.testName} is back in the programme and needs a control.`);
      await load();
    } catch (e) { setProblem(errorText(e)); }
  }
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: 'ok' | 'warn' | 'crit' }) {
  return (
    <div className={`iqcp-tile${tone ? ` t-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   One day, and the two honest ways to close it
   ------------------------------------------------------------------------- */
function DayDialog({ control, date, days, canRecord, onRecordRun, onClose, onDone, onProblem }: {
  control: ProgrammeControl; date: string; days: Day[];
  canRecord: boolean;
  onRecordRun?: (target: RunTarget) => void;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onProblem: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [shift, setShift] = useState<IqcShift | ''>(days[0]?.shift ?? '');
  const [busy, setBusy] = useState(false);
  const open = days.find(d => d.state === 'missed' || d.state === 'due');
  const excused = days.find(d => d.state === 'excused');

  async function account() {
    if (!reason.trim()) return onProblem('Record why the control was not run.');
    setBusy(true);
    try {
      await api('/iqc/programme/missed', {
        method: 'POST',
        body: JSON.stringify({ iqcMaterialId: control.id, dueDate: date, shift: shift || undefined, reason: reason.trim() }),
      });
      await onDone('The day is accounted for.');
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  async function withdraw(missedId: number) {
    setBusy(true);
    try {
      await api(`/iqc/programme/missed/${missedId}`, { method: 'DELETE' });
      await onDone('The account of that day is withdrawn; it is an open gap again.');
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{date}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          {control.materialName}{control.levelLabel ? ` — ${control.levelLabel}` : ''} · {control.testName} · lot {control.lotNumber}
        </p>

        <ul className="iqcp-dayrows">
          {days.map(day => (
            <li key={`${day.date}-${day.shift ?? ''}`} className={day.state}>
              <span className={`iqcp-key s-${day.state}`} />
              <div>
                <strong>{day.shift ?? 'Scheduled run'}</strong>
                <span className="muted">
                  {OCCURRENCE_STATE_LABELS[day.state]}
                  {day.runNumber ? ` · ${day.runNumber}` : ''}
                  {day.reason ? ` · ${day.reason}` : ''}
                </span>
              </div>
              {day.state === 'excused' && day.missedId && canRecord && (
                <button type="button" className="tiny secondary" disabled={busy}
                  onClick={() => void withdraw(day.missedId!)}>Withdraw</button>
              )}
            </li>
          ))}
        </ul>

        {open && canRecord && (
          <>
            {onRecordRun && (
              <div className="iqcp-dayact">
                <button type="button" onClick={() => onRecordRun({
                  materialId: control.id, materialName: control.materialName, date, shift: open.shift,
                })}>
                  <CheckCircle2 size={13} /> Record this run
                </button>
                <span className="muted">
                  The run is entered on {date}, the day it was performed, and evaluated like any other.
                </span>
              </div>
            )}

            {/* The alternative to this is a laboratory that invents the run. */}
            <div className="iqcp-account">
              <strong>Or state why it was not run</strong>
              {days.length > 1 && (
                <label>
                  <span>Shift</span>
                  <select value={shift} onChange={e => setShift(e.target.value as IqcShift | '')}>
                    <option value="">The whole day</option>
                    {IQC_SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              <TextField value={reason} onValue={setReason}
                placeholder="Analyser under repair, no reagent, unit closed…" />
              <button type="button" disabled={busy || !reason.trim()} onClick={() => void account()}>
                {busy ? <Loader2 size={13} className="pd-spin" /> : null} Record the reason
              </button>
            </div>
          </>
        )}

        <div className="pr-btns"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What a control is expected to do
   ------------------------------------------------------------------------- */
function PlanDialog({ control, canPlan, onClose, onSaved, onProblem }: {
  control: ProgrammeControl; canPlan: boolean;
  onClose: () => void; onSaved: () => void | Promise<void>; onProblem: (m: string) => void;
}) {
  const [frequency, setFrequency] = useState<ProgrammeFrequency>(control.schedule.frequency);
  const [weekdays, setWeekdays] = useState<Weekday[]>(
    control.schedule.weekdays.length ? control.schedule.weekdays : [...WEEKDAYS]);
  const [shifts, setShifts] = useState<IqcShift[]>(control.schedule.shifts);
  const [startsOn, setStartsOn] = useState(control.schedule.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(control.schedule.endsOn ?? '');
  const [isActive, setIsActive] = useState(control.schedule.isActive);
  const [notes, setNotes] = useState(control.schedule.notes ?? '');
  const [busy, setBusy] = useState(false);

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter(v => v !== value) : [...list, value];

  async function save() {
    setBusy(true);
    try {
      await api(`/iqc/programme/controls/${control.id}/schedule`, {
        method: 'PUT',
        body: JSON.stringify({
          frequency, weekdays, shifts, isActive,
          startsOn: startsOn || null, endsOn: endsOn || null, notes: notes || null,
        }),
      });
      await onSaved();
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>Schedule — {control.materialName}{control.levelLabel ? ` — ${control.levelLabel}` : ''}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          {control.testName} · lot {control.lotNumber}
          {control.schedule.isDefault && ' · currently read from the frequency this control was registered with'}
        </p>

        <div className="iqcp-plan-form">
          <label className="stack">
            <span>How often</span>
            <select value={frequency} disabled={!canPlan}
              onChange={e => setFrequency(e.target.value as ProgrammeFrequency)}>
              {PROGRAMME_FREQUENCIES.map(f => (
                <option key={f} value={f}>{PROGRAMME_FREQUENCY_LABELS[f]}</option>
              ))}
            </select>
            <em className="muted">{PROGRAMME_FREQUENCY_HINTS[frequency]}</em>
          </label>

          {frequency !== 'event' && (
            <div className="stack">
              <span>Days it is run</span>
              <div className="iqcp-days">
                {WEEKDAYS.map(d => (
                  <button key={d} type="button" disabled={!canPlan}
                    className={weekdays.includes(d) ? 'is-on' : ''}
                    onClick={() => setWeekdays(current => toggle(current, d))}>{WEEKDAY_SHORT[d]}</button>
                ))}
              </div>
              <em className="muted">
                Every day unless the laboratory does not run this control at the weekend.
              </em>
            </div>
          )}

          {frequency === 'per_shift' && (
            <div className="stack">
              <span>Shifts</span>
              <div className="iqcp-days">
                {IQC_SHIFTS.map(s => (
                  <button key={s} type="button" disabled={!canPlan}
                    className={shifts.includes(s) ? 'is-on' : ''}
                    onClick={() => setShifts(current => toggle(current, s))}>{s}</button>
                ))}
              </div>
            </div>
          )}

          <label className="stack">
            <span>In the programme from</span>
            <input type="date" value={startsOn} disabled={!canPlan} onChange={e => setStartsOn(e.target.value)} />
            <em className="muted">Nothing is expected before this day, so a lot registered today arrives with no history behind it.</em>
          </label>
          <label className="stack">
            <span>Until (optional)</span>
            <input type="date" value={endsOn} disabled={!canPlan} onChange={e => setEndsOn(e.target.value)} />
          </label>
          <label className="iqcp-switch">
            <input type="checkbox" checked={isActive} disabled={!canPlan}
              onChange={e => setIsActive(e.target.checked)} />
            <span>In the programme. Turn this off for a control kept in the register but not scheduled.</span>
          </label>
          <label className="stack">
            <span>Note</span>
            <TextField value={notes} onValue={setNotes} placeholder="Anything worth recording about this plan" />
          </label>
        </div>

        <div className="pr-btns">
          {canPlan
            ? <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? <Loader2 size={13} className="pd-spin" /> : null} Save the schedule
              </button>
            : <span className="muted">You may read this plan but not change it.</span>}
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   An examination deliberately left out
   ------------------------------------------------------------------------- */
function ExemptDialog({ test, onClose, onSaved, onProblem }: {
  test: CoverageTest; onClose: () => void; onSaved: () => void | Promise<void>; onProblem: (m: string) => void;
}) {
  const [ground, setGround] = useState<ExemptionGround>('no_control_available');
  const [reason, setReason] = useState('');
  const [reviewOn, setReviewOn] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!reason.trim()) return onProblem('Record why this examination is not controlled.');
    setBusy(true);
    try {
      await api('/iqc/programme/exemptions', {
        method: 'POST',
        body: JSON.stringify({ testId: test.id, ground, reason: reason.trim(), reviewOn: reviewOn || undefined }),
      });
      await onSaved();
    } catch (e) { onProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>Leave {test.testName} out of the programme</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          An examination out of the programme is a decision on the record, not an omission. It is reviewed on the
          date below and reported when that date passes.
        </p>
        <div className="iqcp-plan-form">
          <label className="stack">
            <span>Ground</span>
            <select value={ground} onChange={e => setGround(e.target.value as ExemptionGround)}>
              {EXEMPTION_GROUNDS.map(g => <option key={g} value={g}>{EXEMPTION_GROUND_LABELS[g]}</option>)}
            </select>
          </label>
          <label className="stack">
            <span>Reason</span>
            <TextField value={reason} onValue={setReason} placeholder="In this laboratory’s own words" />
          </label>
          <label className="stack">
            <span>Review on</span>
            <input type="date" value={reviewOn} onChange={e => setReviewOn(e.target.value)} />
            <em className="muted">Left blank, it is reviewed in twelve months.</em>
          </label>
        </div>
        <div className="pr-btns">
          <button type="button" disabled={busy || !reason.trim()} onClick={() => void save()}>
            {busy ? <Loader2 size={13} className="pd-spin" /> : <XCircle size={13} />} Record the exemption
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
