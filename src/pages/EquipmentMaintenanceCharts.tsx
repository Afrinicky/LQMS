import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList,
  Loader2, Plus, Sparkles, Trash2, Wrench, X,
} from 'lucide-react';
import { api, errorText } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import TextField from '../components/ui/TextField';
import LogSheetGrid, { SheetPicker } from '../components/routine/LogSheetGrid';
import {
  MAINTENANCE_FREQUENCIES, MAINTENANCE_FREQUENCY_LABELS, MAINTENANCE_KINDS,
  MAINTENANCE_KIND_HINTS, MAINTENANCE_KIND_LABELS, monthLabel,
  type MaintenanceFrequency, type MaintenanceKind,
} from '../../shared/constants/routineWork';
import { ACTIVITY_TIERS, TIER_LABELS, type ActivityTier } from '../../shared/constants/activities';
import type { LogSheetIndex, MaintenanceTask } from '../../shared/types/api';

/**
 * Equipment maintenance — what is actually done, and the chart that proves it.
 *
 * The register already held maintenance RECORDS: dated entries saying a service
 * happened. What it never held was the programme behind them — the individual
 * acts, each with its own cadence, that make up looking after an instrument. So
 * "maintained" meant "somebody wrote something down", and a microscope whose
 * objectives had not been cleaned in three weeks looked identical to one that
 * had been cleaned every morning.
 *
 * Tasks fix that, and they carry their own frequency, which is what lets one
 * chart hold a microscope's daily lens clean, its weekly condenser check and
 * its annual engineer's service — daily rows across the days of the month,
 * everything else across the weeks, exactly as the laboratory's own freezer
 * schedule is laid out.
 *
 * The starting lists exist because nobody should have to invent "clean the
 * objectives daily" to start recording that they did it. They are offered from
 * the instrument's own name and type, and every one is editable on the way in.
 * Nothing here overrides a manufacturer's manual and the screen says so.
 */

type Tab = 'charts' | 'tasks';

export default function EquipmentMaintenanceCharts({ equipment, setError }: {
  equipment: Array<{ id: number; name: string; equipment_number?: string; section_id?: number | null; equipment_archetype?: string | null; category?: string | null }>;
  setError: (message: string | null) => void;
}) {
  const [tab, setTab] = useState<Tab>('charts');
  return (
    <div>
      <div className="tabbar" role="tablist">
        {([['charts', 'Monthly charts'], ['tasks', 'What each instrument needs']] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'charts' ? <Charts setError={setError} /> : <Tasks equipment={equipment} setError={setError} />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The month
   ------------------------------------------------------------------------- */
function Charts({ setError }: { setError: (m: string | null) => void }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [index, setIndex] = useState<LogSheetIndex | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<LogSheetIndex>(`/equipment/maintenance-charts?month=${month}`);
      setIndex(next); setError(null);
      setActiveId(previous => next.sheets.some(s => s.sheet?.id === previous)
        ? previous : next.sheets.find(s => s.sheet)?.sheet?.id ?? null);
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, [month, setError]);

  useEffect(() => { void load(); }, [load]);

  function shiftMonth(step: number) {
    const [year, m] = month.split('-').map(Number);
    const next = new Date(year, m - 1 + step, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div className="card">
      <div className="pp-head">
        <div>
          <h3><Wrench size={16} /> Maintenance charts</h3>
          <p>
            One chart per instrument, per month: daily tasks across the days, weekly and scheduled servicing
            across the weeks. The unit supervisor signs it at the end of the month, exactly as the paper
            schedule is signed.
          </p>
        </div>
        <div className="rs-month">
          <button type="button" className="pq-link" onClick={() => shiftMonth(-1)}><ChevronLeft size={14} /></button>
          <span><CalendarDays size={12} /> {monthLabel(month)}</span>
          <button type="button" className="pq-link" onClick={() => shiftMonth(1)}
            disabled={month >= new Date().toISOString().slice(0, 7)}><ChevronRight size={14} /></button>
        </div>
      </div>

      {loading ? <p className="muted">Loading…</p>
        : !index?.sheets.length ? (
          <p className="muted">
            No instrument in this unit has maintenance tasks yet, so there is nothing to chart. Open
            &ldquo;What each instrument needs&rdquo; and add them — a starting list is offered for microscopes,
            fridges, centrifuges, analysers, autoclaves, incubators and cabinets.
          </p>
        ) : (
          <div className="rs-split">
            <div className="rs-list"><SheetPicker sheets={index.sheets} activeId={activeId} onPick={setActiveId} /></div>
            <div className="rs-grid">
              {activeId ? <LogSheetGrid sheetId={activeId} onChanged={load} />
                : <p className="muted">Choose an instrument on the left.</p>}
            </div>
          </div>
        )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What each instrument needs
   ------------------------------------------------------------------------- */
function Tasks({ equipment, setError }: {
  equipment: Array<{ id: number; name: string; equipment_number?: string }>;
  setError: (m: string | null) => void;
}) {
  const { can } = usePermissions();
  const [equipmentId, setEquipmentId] = useState<number | null>(equipment[0]?.id ?? null);
  const [tasks, setTasks] = useState<MaintenanceTask[] | null>(null);
  const [framework, setFramework] = useState<any | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [busy, setBusy] = useState(false);

  const canEdit = can('equipment.maintenance', 'edit');
  const canCreate = can('equipment.maintenance', 'create');

  const load = useCallback(async () => {
    if (!equipmentId) { setTasks([]); setFramework(null); return; }
    try {
      const [list, suggestion] = await Promise.all([
        api<MaintenanceTask[]>(`/equipment/maintenance-tasks?equipmentId=${equipmentId}`),
        api<any>(`/equipment/${equipmentId}/maintenance-framework`),
      ]);
      setTasks(list); setFramework(suggestion); setError(null);
    } catch (e) { setError(errorText(e)); }
  }, [equipmentId, setError]);

  useEffect(() => { void load(); }, [load]);

  async function adopt() {
    if (!framework || !equipmentId) return;
    setBusy(true);
    try {
      const picked = framework.tasks.filter((t: any) => chosen.has(t.task));
      await api(`/equipment/${equipmentId}/maintenance-tasks`, {
        method: 'POST', body: JSON.stringify({ tasks: picked }),
      });
      setChosen(new Set());
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const routine = (tasks ?? []).filter(t => t.maintenance_kind === 'routine');
  const scheduled = (tasks ?? []).filter(t => t.maintenance_kind === 'scheduled');

  return (
    <div className="card">
      <div className="pp-head">
        <div>
          <h3><ClipboardList size={16} /> What each instrument needs</h3>
          <p>
            Routine care is done in-house at its own cadence; scheduled servicing is planned ahead and usually
            done by an external engineer. Both appear on the instrument&rsquo;s monthly chart, and the routine
            ones appear on the bench&rsquo;s duty list.
          </p>
        </div>
        <div className="pp-head-actions">
          <label className="inline">
            <span>Instrument</span>
            <select value={equipmentId ?? ''} onChange={e => setEquipmentId(Number(e.target.value) || null)}>
              <option value="">Choose…</option>
              {equipment.map(item => (
                <option key={item.id} value={item.id}>{item.name}{item.equipment_number ? ` (${item.equipment_number})` : ''}</option>
              ))}
            </select>
          </label>
          {canCreate && equipmentId && (
            <button type="button" onClick={() => setShowAdd(true)}><Plus size={13} /> Add a task</button>
          )}
        </div>
      </div>

      {!equipmentId ? <p className="muted">Choose an instrument.</p> : !tasks ? <p className="muted">Loading…</p> : (
        <div className="dc-split">
          <div>
            {framework && framework.tasks.some((t: any) => !t.alreadyAdded) && canCreate && (
              <>
                <h4 className="rw-subhead">
                  <Sparkles size={13} /> Usually maintained like this — {framework.label}
                </h4>
                <p className="iqc-panel-lead" style={{ marginBottom: 8 }}>
                  A starting point drawn from what this kind of instrument normally needs. Tick what applies,
                  edit anything afterwards. It does not replace the manufacturer&rsquo;s manual — where the two
                  differ, the manual wins.
                </p>
                <ul className="dc-frameworks">
                  {framework.tasks.filter((t: any) => !t.alreadyAdded).map((task: any) => (
                    <li key={task.task} className="dc-framework">
                      <input type="checkbox" checked={chosen.has(task.task)}
                        onChange={e => setChosen(previous => {
                          const next = new Set(previous);
                          if (e.target.checked) next.add(task.task); else next.delete(task.task);
                          return next;
                        })} />
                      <div>
                        <span className="dc-framework-name">{task.task}</span>
                        <span className="dc-framework-meta">
                          {MAINTENANCE_FREQUENCY_LABELS[task.frequency as MaintenanceFrequency]}
                          {' · '}{MAINTENANCE_KIND_LABELS[task.kind as MaintenanceKind]}
                          {task.consumable ? ` · ${task.consumable}` : ''}
                        </span>
                        {task.guidance && <p className="dc-framework-method">{task.guidance}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
                {chosen.size > 0 && (
                  <button type="button" style={{ marginTop: 10 }} disabled={busy} onClick={() => void adopt()}>
                    {busy ? <Loader2 size={13} className="pd-spin" /> : <Check size={13} />} Add {chosen.size}
                  </button>
                )}
              </>
            )}
          </div>

          <div>
            <h4 className="rw-subhead">Routine — {MAINTENANCE_KIND_HINTS.routine}</h4>
            <TaskList tasks={routine} canEdit={canEdit} onChanged={load} onError={setError} />
            <h4 className="rw-subhead">Scheduled servicing — {MAINTENANCE_KIND_HINTS.scheduled}</h4>
            <TaskList tasks={scheduled} canEdit={canEdit} onChanged={load} onError={setError} />
          </div>
        </div>
      )}

      {showAdd && equipmentId && (
        <AddTaskDialog equipmentId={equipmentId} onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); void load(); }} onError={setError} />
      )}
    </div>
  );
}

function TaskList({ tasks, canEdit, onChanged, onError }: {
  tasks: MaintenanceTask[]; canEdit: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  if (!tasks.length) return <p className="muted">Nothing here yet.</p>;
  return (
    <ul className="dc-defs">
      {tasks.map(task => (
        <li key={task.id} className="dc-def">
          <div className="dc-def-head">
            <span className="dc-def-name">{task.task_text}</span>
            <span className="badge">{MAINTENANCE_FREQUENCY_LABELS[task.frequency as MaintenanceFrequency] ?? task.frequency}</span>
            {task.performer_tier !== 'general' && <span className="badge">{TIER_LABELS[task.performer_tier as ActivityTier]}</span>}
            {task.provider_type === 'external' && <span className="badge">external engineer</span>}
            {canEdit && (
              <button type="button" className="pq-link" style={{ marginLeft: 'auto' }}
                title="Retire this task. The months already charted against it keep their rows."
                onClick={async () => {
                  try { await api(`/equipment/maintenance-tasks/${task.id}`, { method: 'DELETE' }); onChanged(); }
                  catch (e) { onError(errorText(e)); }
                }}>
                <Trash2 size={12} /> Retire
              </button>
            )}
          </div>
          {task.guidance && <p className="dc-def-body">{task.guidance}</p>}
          {task.consumable && <p className="dc-def-body"><strong>Needs:</strong> {task.consumable}</p>}
          {task.next_due_date && <p className="dc-def-body"><strong>Next due:</strong> {task.next_due_date}{task.provider_name ? ` — ${task.provider_name}` : ''}</p>}
        </li>
      ))}
    </ul>
  );
}

function AddTaskDialog({ equipmentId, onClose, onSaved, onError }: {
  equipmentId: number; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [task, setTask] = useState('');
  const [guidance, setGuidance] = useState('');
  const [consumable, setConsumable] = useState('');
  const [frequency, setFrequency] = useState<MaintenanceFrequency>('daily');
  const [kind, setKind] = useState<MaintenanceKind>('routine');
  const [tier, setTier] = useState<ActivityTier>('general');
  const [busy, setBusy] = useState(false);

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>Add a maintenance task</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        <label><span>What is done</span>
          <TextField value={task} onValue={setTask} autoFocus
            placeholder="Clean the eyepieces and objective lenses" /></label>

        <div className="iqc-run-meta">
          <label><span>Kind</span>
            <select value={kind} onChange={e => {
              const next = e.target.value as MaintenanceKind;
              setKind(next);
              // Servicing is normally the supervisor's and normally annual;
              // routine care is normally the bench's and normally daily.
              setTier(next === 'scheduled' ? 'supervisory' : 'general');
              setFrequency(next === 'scheduled' ? 'annual' : 'daily');
            }}>
              {MAINTENANCE_KINDS.map(k => <option key={k} value={k}>{MAINTENANCE_KIND_LABELS[k]}</option>)}
            </select>
          </label>
          <label><span>How often</span>
            <select value={frequency} onChange={e => setFrequency(e.target.value as MaintenanceFrequency)}>
              {MAINTENANCE_FREQUENCIES.map(f => <option key={f} value={f}>{MAINTENANCE_FREQUENCY_LABELS[f]}</option>)}
            </select>
          </label>
          <label><span>Who may perform it</span>
            <select value={tier} onChange={e => setTier(e.target.value as ActivityTier)}>
              {ACTIVITY_TIERS.map(t => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
            </select>
          </label>
        </div>

        <label><span>Guidance</span>
          <TextField as="textarea" rows={2} value={guidance} onValue={setGuidance}
            placeholder="Lens tissue only, in a spiral from the centre outwards." /></label>
        <label><span>What it needs</span>
          <TextField value={consumable} onValue={setConsumable} placeholder="Lens tissue and lens cleaner" /></label>

        <p className="ls-modal-lead">
          A daily or twice-daily task runs across the days of the monthly chart; anything weekly or longer runs
          across the weeks. Routine tasks also appear on the duty list of whoever is rostered to this unit.
        </p>

        <div className="pr-btns">
          <button type="button" disabled={busy || !task.trim()} onClick={async () => {
            setBusy(true);
            try {
              await api(`/equipment/${equipmentId}/maintenance-tasks`, {
                method: 'POST',
                body: JSON.stringify({ task, guidance, consumable, frequency, kind, tier }),
              });
              onSaved();
            } catch (e) { onError(errorText(e)); }
            finally { setBusy(false); }
          }}>
            {busy ? <Loader2 size={14} className="pd-spin" /> : <Check size={14} />} Add it
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export { AlertTriangle as MaintenanceWarnIcon };
