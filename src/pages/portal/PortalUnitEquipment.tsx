import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Circle,
  Loader2, Plus, Ruler, ShieldCheck, Wrench, X,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../../components/ui/TextField';
import type { UnitEquipmentOverview, UnitEquipmentItem, EquipmentDutyState } from '../../../shared/types/api';

/**
 * The unit's instruments and what each is owed.
 *
 * The maintenance tab used to say only that no tasks existed anywhere in the
 * unit — naming no instrument and offering no way to fix it. The inventory comes
 * first now, and each gap is closed from the row it appears on.
 *
 * What an instrument is owed is derived from its category rather than assumed:
 * an analyser owes calibration, verification, uncertainty and QC; a pipette owes
 * calibration alone; a fridge owes monitoring, maintenance and certification.
 *
 * Two states are kept apart throughout, because they need different actions:
 * NOT SET UP is a gap in the programme, OVERDUE is a lapse in performing it.
 */

const DUTY_ICON: Record<string, typeof Wrench> = {
  maintenance: Wrench,
  calibration: Ruler,
  verification: ShieldCheck,
  iqc: CheckCircle2,
};

const FREQUENCIES = [
  ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'],
  ['quarterly', 'Every three months'], ['biannual', 'Twice a year'], ['annual', 'Every year'],
] as const;

export default function PortalUnitEquipment({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<UnitEquipmentOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [taskSetup, setTaskSetup] = useState<UnitEquipmentItem | null>(null);
  const [scheduleSetup, setScheduleSetup] = useState<{ item: UnitEquipmentItem; duty: string } | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<UnitEquipmentOverview>('/equipment/portal/unit-overview')); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The instruments with something missing come first — that is what this
  // screen is for. Alphabetical order buries them among the ones already fine.
  const ordered = useMemo(() => {
    const rows = data?.equipment ?? [];
    const weight = (r: UnitEquipmentItem) => (r.overdue.length ? 0 : r.gaps.length ? 1 : 2);
    return [...rows].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name));
  }, [data]);

  if (loading) return <p className="muted">Reading your unit&rsquo;s equipment inventory…</p>;
  if (!data) return <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>;
  if (data.message) return <p className="muted">{data.message}</p>;

  const { counts } = data;

  return (
    <section className="portal-panel ueq">
      <div className="pp-head">
        <div>
          <h3>Equipment</h3>
          <p>Instruments assigned to {data.sectionName ?? 'this unit'}, and what each needs.</p>
        </div>
        {counts.withGaps > 0 && <span className="pp-count crit">{counts.withGaps}</span>}
      </div>

      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      {notice && (
        <p className="ueq-notice">
          <CheckCircle2 size={13} /> {notice}
          <button type="button" className="pq-link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      {counts.items === 0 ? (
        <p className="muted">
          No equipment is assigned to {data.sectionName ?? 'this unit'} yet.
          Instruments are registered under Equipment Management.
        </p>
      ) : (
        <>
          <div className="ueq-counts">
            <Stat value={counts.items} label="Instruments" />
            <Stat value={counts.needMaintenanceTasks} label="No maintenance set up"
              tone={counts.needMaintenanceTasks ? 'crit' : 'ok'} />
            <Stat value={counts.needCalibration} label="No calibration set up"
              tone={counts.needCalibration ? 'crit' : 'ok'} />
            <Stat value={counts.overdue} label="Overdue" tone={counts.overdue ? 'crit' : 'ok'} />
            {counts.dueSoon > 0 && <Stat value={counts.dueSoon} label="Due within 30 days" tone="warn" />}
            {counts.outOfService > 0 && <Stat value={counts.outOfService} label="Out of service" tone="warn" />}
          </div>

          <ul className="ueq-list">
            {ordered.map(item => (
              <li key={item.id} className={item.overdue.length ? 'is-late' : item.gaps.length ? 'is-gap' : ''}>
                <button type="button" className="ueq-row" onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
                  {expanded === item.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="ueq-name">
                    {item.name}
                    {item.equipmentNumber && <span className="badge">{item.equipmentNumber}</span>}
                    {item.status !== 'operational' && item.status !== 'active' && (
                      <span className="badge warning">{item.status.replace(/_/g, ' ')}</span>
                    )}
                  </span>
                  <span className="ueq-summary">
                    {item.overdue.length > 0 && <span className="crit">{item.overdue.length} overdue</span>}
                    {item.gaps.length > 0 && <span className="warn">{item.gaps.length} not set up</span>}
                    {item.overdue.length === 0 && item.gaps.length === 0 && <span className="ok">Complete</span>}
                  </span>
                </button>

                {expanded === item.id && (
                  <div className="ueq-detail">
                    <p className="ueq-ident">
                      {[item.manufacturer, item.model].filter(Boolean).join(' ') || 'No model recorded'}
                      {item.serialNumber ? ` · serial ${item.serialNumber}` : ''}
                      {item.locationName ? ` · ${item.locationName}` : ''}
                      {item.custodianName ? ` · ${item.custodianName}` : ''}
                    </p>
                    <ul className="ueq-duties">
                      {item.duties.map(duty => (
                        <DutyRow
                          key={duty.duty} duty={duty} isUnitHead={data.isUnitHead}
                          onSetUp={() => {
                            if (duty.duty === 'maintenance') setTaskSetup(item);
                            else setScheduleSetup({ item, duty: duty.duty });
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {taskSetup && (
        <MaintenanceSetupDialog
          item={taskSetup}
          onClose={() => setTaskSetup(null)}
          onSaved={async message => { setTaskSetup(null); setNotice(message); await load(); onChanged?.(); }}
        />
      )}
      {scheduleSetup && (
        <ScheduleSetupDialog
          item={scheduleSetup.item} duty={scheduleSetup.duty}
          onClose={() => setScheduleSetup(null)}
          onSaved={async message => { setScheduleSetup(null); setNotice(message); await load(); onChanged?.(); }}
        />
      )}
    </section>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={`ueq-stat${tone ? ` tone-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DutyRow({ duty, isUnitHead, onSetUp }: {
  duty: EquipmentDutyState; isUnitHead: boolean; onSetUp: () => void;
}) {
  const Icon = DUTY_ICON[duty.duty] ?? Circle;
  const tone = !duty.tracked ? 'untracked'
    : duty.dueState === 'overdue' ? 'late'
    : duty.setUp === false ? 'gap'
    : duty.dueState === 'due_soon' ? 'soon' : 'ok';

  // Only the interval is set from here. Performing a calibration or a
  // verification stays in Equipment Management, where the certificate,
  // reference standard and evidence belong.
  const settable = isUnitHead && duty.tracked && duty.setUp === false
    && ['maintenance', 'calibration', 'verification'].includes(duty.duty);

  return (
    <li className={`ueq-duty t-${tone}`}>
      <Icon size={13} />
      <div className="ueq-duty-main">
        <span className="ueq-duty-head" title={duty.hint}>{duty.label}</span>
        <span className="ueq-duty-state">
          {duty.tracked ? duty.detail : 'Not tracked in this system'}
          {duty.dueDate && (
            <span className={`ueq-due ${duty.dueState}`}>
              <CalendarClock size={10} />
              {duty.dueState === 'overdue' ? 'Overdue ' : 'Due '}{duty.dueDate}
            </span>
          )}
        </span>
      </div>
      {settable && (
        <button type="button" className="ueq-set" onClick={onSetUp}>
          <Plus size={11} /> Set up
        </button>
      )}
    </li>
  );
}

/* ----------------------------------------------------------------------------
   Maintenance: the framework, edited on the way in
   ----------------------------------------------------------------------------
   Nobody should have to invent "clean the objectives daily" for a microscope.
   The system already knows what an instrument of this kind is normally
   maintained with; what it cannot know is this laboratory's manual, so every
   line is editable and removable before it is accepted, and the dialog says so.
   ------------------------------------------------------------------------- */
type FrameworkTask = {
  task: string; frequency: string; kind?: string; tier?: string;
  guidance?: string | null; consumable?: string | null; alreadyAdded?: boolean;
};

function MaintenanceSetupDialog({ item, onClose, onSaved }: {
  item: UnitEquipmentItem; onClose: () => void; onSaved: (m: string) => void | Promise<void>;
}) {
  const [framework, setFramework] = useState<{ label: string; tasks: FrameworkTask[] } | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const f = await api<{ label: string; tasks: FrameworkTask[] }>(`/equipment/${item.id}/maintenance-framework`);
        setFramework(f);
        // Everything not already on the instrument is offered ticked: the
        // common case is accepting the framework, and unticking what does not
        // apply is less work than ticking twelve lines that do.
        setChosen(new Set(f.tasks.map((t, i) => (t.alreadyAdded ? -1 : i)).filter(i => i >= 0)));
      } catch (e) { setProblem(errorText(e)); }
    })();
  }, [item.id]);

  async function submit() {
    const tasks = (framework?.tasks ?? []).filter((_, i) => chosen.has(i));
    if (!tasks.length) return setProblem('Choose at least one task, or cancel.');
    setBusy(true); setProblem(null);
    try {
      const result = await api<{ created: number; problems: string[] }>(`/equipment/${item.id}/maintenance-tasks`, {
        method: 'POST', body: JSON.stringify({ tasks }),
      });
      await onSaved(`${result.created} task${result.created === 1 ? '' : 's'} added to ${item.name}. Its monthly chart is now available.`);
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel ueq-dialog" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <h3>Maintenance — {item.name}</h3>
            <p className="modal-sub">
              A starting list for this type of instrument. Untick what does not apply and edit the rest
              to match your manual.
            </p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="modal-body">
          {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
          {!framework ? <p className="muted">Reading what this kind of instrument needs…</p> : (
            <>
              <p className="ueq-framework-label">{framework.label}</p>
              <ul className="ueq-tasks">
                {framework.tasks.map((task, i) => (
                  <li key={i} className={task.alreadyAdded ? 'is-added' : ''}>
                    <label>
                      <input type="checkbox" disabled={task.alreadyAdded} checked={chosen.has(i)}
                        onChange={e => setChosen(prev => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(i); else next.delete(i);
                          return next;
                        })} />
                      <span className="ueq-task-text">
                        <TextField value={task.task} onValue={v => setFramework(f => f && ({
                          ...f, tasks: f.tasks.map((t, index) => (index === i ? { ...t, task: v } : t)),
                        }))} disabled={task.alreadyAdded} />
                        {task.guidance && <em>{task.guidance}</em>}
                      </span>
                      <select value={task.frequency} disabled={task.alreadyAdded}
                        onChange={e => setFramework(f => f && ({
                          ...f, tasks: f.tasks.map((t, index) => (index === i ? { ...t, frequency: e.target.value } : t)),
                        }))}>
                        {FREQUENCIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                      {task.alreadyAdded && <span className="badge">already on it</span>}
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button type="button" disabled={busy || !framework} onClick={() => void submit()}>
            {busy ? <><Loader2 size={14} className="pd-spin" /> Adding…</> : `Add ${chosen.size} task${chosen.size === 1 ? '' : 's'}`}
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Calibration and verification: the interval, not the act
   ----------------------------------------------------------------------------
   Recording a calibration means a certificate, a reference standard and a
   traceability statement, and that stays in Equipment Management. What was out
   of a unit head's reach is the interval it should recur on and the date it is
   next due — which is what makes an absence visible in the first place.
   ------------------------------------------------------------------------- */
function ScheduleSetupDialog({ item, duty, onClose, onSaved }: {
  item: UnitEquipmentItem; duty: string; onClose: () => void; onSaved: (m: string) => void | Promise<void>;
}) {
  const noun = duty === 'calibration' ? 'Calibration' : 'Verification';
  const [form, setForm] = useState({
    frequency: duty === 'calibration' ? 'annual' : 'annual',
    providerType: duty === 'calibration' ? 'external' : 'internal',
    providerName: '', nextDueDate: '', taskDescription: '',
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      const result = await api<{ nextDueDate: string }>(`/equipment/${item.id}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          scheduleType: duty === 'calibration' ? 'calibration' : 'verification',
          frequency: form.frequency,
          providerType: form.providerType,
          providerName: form.providerName || null,
          nextDueDate: form.nextDueDate || null,
          taskDescription: form.taskDescription || `${noun} of ${item.name}`,
        }),
      });
      await onSaved(`${noun} scheduled for ${item.name} — next due ${result.nextDueDate}.`);
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel narrow" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <h3>{noun} — {item.name}</h3>
            <p className="modal-sub">
              How often it is done and when the next one falls due. The record itself is entered
              under Equipment Management.
            </p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="modal-body">
          {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
          <div className="form-grid">
            <label>Frequency
              <select value={form.frequency} onChange={e => set('frequency', e.target.value)}>
                {FREQUENCIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label>Done by
              <select value={form.providerType} onChange={e => set('providerType', e.target.value)}>
                <option value="internal">This laboratory</option>
                <option value="external">An outside provider</option>
              </select>
            </label>
            {form.providerType === 'external' && (
              <label>Provider
                <TextField value={form.providerName} onValue={v => set('providerName', v)}
                  placeholder="Who performs it" />
              </label>
            )}
            <label>Next due
              <input type="date" value={form.nextDueDate} onChange={e => set('nextDueDate', e.target.value)} />
            </label>
            <label className="wide">Description
              <TextField value={form.taskDescription} onValue={v => set('taskDescription', v)}
                placeholder={`${noun} of ${item.name}`} />
            </label>
          </div>
          <p className="ueq-note">Leave the date blank to set it one interval from today.</p>
        </div>

        <footer className="modal-foot">
          <button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : 'Save schedule'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
