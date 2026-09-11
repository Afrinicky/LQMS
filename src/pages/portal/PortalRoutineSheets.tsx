import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, ClipboardList,
  Droplets, Lock, MoreHorizontal, Plus, Thermometer, Trash2, Wrench,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../../components/ui/TextField';
import LogSheetGrid, { SheetPicker } from '../../components/routine/LogSheetGrid';
import {
  monthLabel, LOGGING_MODE_LABELS, ENVIRONMENTAL_CHART_PRESETS, CHART_FREQUENCIES,
  type SheetKind, type ChartParameterPreset,
} from '../../../shared/constants/routineWork';
import type { LogSheetIndex } from '../../../shared/types/api';

/**
 * Environmental charting, decontamination and maintenance in the portal — three
 * registers that are the same object with different rows.
 *
 * Every asset is listed whether or not anything has been recorded against it. A
 * list of only the charts that have entries would show a healthy month on a
 * bench that stopped charting on the 9th, which is the failure the register
 * exists to make visible.
 *
 * The grid is worked here rather than in another module: somebody standing at a
 * fridge should type the number where they are told the reading is due.
 */

const KIND_META: Record<SheetKind, { icon: ReactNode; title: string; lead: string; empty: string }> = {
  environmental: {
    icon: <Thermometer size={16} />,
    title: 'Environmental monitoring',
    lead: 'This month\'s chart for each fridge, freezer, room and incubator in this unit.',
    empty: 'No environmental assets are assigned to this unit. They are registered under Facilities & Safety.',
  },
  decontamination: {
    icon: <Droplets size={16} />,
    title: 'Decontamination',
    lead: 'This month\'s log for everything this unit decontaminates.',
    empty: 'No decontamination is set up for this unit yet. It is adopted under Facilities & Safety.',
  },
  equipment_maintenance: {
    icon: <Wrench size={16} />,
    title: 'Maintenance charts',
    lead: 'One chart per instrument — daily tasks across the days, scheduled servicing across the weeks.',
    empty: 'No maintenance tasks are defined yet. Add them from the Equipment list above.',
  },
};

const ENDPOINT: Record<SheetKind, string> = {
  environmental: '/environmental/charts',
  decontamination: '/decontamination/logs',
  equipment_maintenance: '/equipment/maintenance-charts',
};

export default function PortalRoutineSheets({ kind, sectionId }: { kind: SheetKind; sectionId?: number | null }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [index, setIndex] = useState<LogSheetIndex | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<RemovalTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<LogSheetIndex>(`${ENDPOINT[kind]}?month=${month}${sectionId ? `&sectionId=${sectionId}` : ''}`);
      setIndex(next);
      setProblem(null);
      // Land on whichever chart most needs attention, rather than the first one
      // alphabetically: the point of opening this screen is usually the one
      // that is behind.
      setActiveId(previous => {
        const still = next.sheets.find(s => s.sheet?.id === previous);
        if (still) return previous;
        const ranked = [...next.sheets].filter(s => s.sheet)
          .sort((a, b) => (a.completeness?.percent ?? 100) - (b.completeness?.percent ?? 100));
        return ranked[0]?.sheet?.id ?? null;
      });
    } catch (e) { setProblem(errorText(e)); setIndex(null); }
    finally { setLoading(false); }
  }, [kind, month, sectionId]);

  useEffect(() => { void load(); }, [load]);

  const meta = KIND_META[kind];
  const totals = useMemo(() => {
    const sheets = index?.sheets ?? [];
    return {
      count: sheets.length,
      behind: sheets.filter(s => (s.completeness?.percent ?? 0) < 90).length,
      breaches: sheets.reduce((sum, s) => sum + (s.completeness?.breaches ?? 0), 0),
      awaiting: sheets.filter(s => s.sheet?.status === 'submitted').length,
    };
  }, [index]);

  const loggingMode = (index?.settings as any)?.logging_mode as string | undefined;
  const active = useMemo(
    () => (index?.sheets ?? []).find(s => s.sheet?.id === activeId) ?? null,
    [index, activeId],
  );

  function shiftMonth(step: number) {
    const [year, m] = month.split('-').map(Number);
    const next = new Date(year, m - 1 + step, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3>{meta.icon} {meta.title}</h3>
            <p>{meta.lead}</p>
          </div>
          <div className="rs-month">
            <button type="button" className="pq-link" onClick={() => shiftMonth(-1)} title="The previous month">
              <ChevronLeft size={14} />
            </button>
            <span><CalendarDays size={12} /> {monthLabel(month)}</span>
            <button type="button" className="pq-link" onClick={() => shiftMonth(1)}
              disabled={month >= new Date().toISOString().slice(0, 7)} title="The next month">
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

        {kind === 'environmental' && loggingMode && (
          <p className="rs-mode">
            {LOGGING_MODE_LABELS[loggingMode as keyof typeof LOGGING_MODE_LABELS] ?? loggingMode}.
            {loggingMode === 'automated'
              ? ' Readings arrive from the data loggers; you can still correct one or enter a reading by hand where a logger has failed.'
              : ' Every reading here is taken and entered by staff.'}
          </p>
        )}

        {kind === 'environmental' && (
          <div className="rs-add">
            {adding
              ? <NewEnvironmentalLog month={month} onClose={() => setAdding(false)}
                  onCreated={async id => { setAdding(false); await load(); setActiveId(id); }} />
              : (
                <button type="button" className="pq-link" onClick={() => setAdding(true)}>
                  <Plus size={13} /> Register something new to chart
                </button>
              )}
          </div>
        )}

        {loading ? <p className="muted">Loading this month&rsquo;s sheets…</p>
          : !index || index.sheets.length === 0 ? <p className="muted">{meta.empty}</p> : (
            <>
              <div className="rs-totals">
                <span><strong>{totals.count}</strong> {totals.count === 1 ? 'sheet' : 'sheets'}</span>
                {totals.behind > 0 && <span className="warn"><strong>{totals.behind}</strong> behind</span>}
                {totals.breaches > 0 && <span className="crit"><strong>{totals.breaches}</strong> out of range or not done</span>}
                {totals.awaiting > 0 && <span><strong>{totals.awaiting}</strong> waiting to be verified</span>}
              </div>

              {/*
                The picker sits above the grid, not beside it. A month is 31
                columns wide; a fixed sidebar took a quarter of the screen to
                list, very often, one fridge, and squeezed every entry cell to
                pay for it.
              */}
              <div className="rs-stack">
                <SheetPicker sheets={index.sheets} activeId={activeId} onPick={setActiveId} horizontal />
                <div className="rs-grid">
                  {activeId
                    ? <LogSheetGrid sheetId={activeId} onChanged={load} />
                    : <p className="muted">Choose a sheet above to record on it.</p>}
                </div>
                {index.canDelete && active && (
                  <ScheduleAdmin kind={kind} entry={active} month={month}
                    onRemove={target => setRemoving(target)} />
                )}
              </div>
            </>
          )}

        {removing && (
          <RemoveScheduleDialog target={removing} sectionId={sectionId ?? null}
            onClose={() => setRemoving(null)}
            onDone={async () => { setRemoving(null); setActiveId(null); await load(); }} />
        )}
      </section>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Removing a schedule, and the months charted against it

   Deliberately out of the way. Everything else on this screen is the work of
   the bench, done many times a day by whoever is on duty; this is the opposite
   — rare, senior, and irreversible — so it lives behind a single quiet control
   rather than as a button beside "Register something new to chart", and the
   server refuses it outright to anybody but the administrator, the Quality
   Manager and the Laboratory Manager.

   It exists because the register previously had no way back out. A fridge
   entered twice, a chart opened against the wrong instrument, a decontamination
   somebody set up while learning the screen: each of them charted for a
   fortnight before anybody noticed, and "it has already been charted" made the
   mistake permanent. A register that cannot be corrected is a register that
   stops being trusted.
   ------------------------------------------------------------------------- */
type RemovalTarget = {
  scope: 'sheet' | 'schedule';
  kind: SheetKind;
  subjectId: number;
  sheetId: number | null;
  name: string;
  monthLabel: string;
};

const REMOVAL_CONSEQUENCE: Record<SheetKind, string> = {
  environmental: 'The asset is taken off the monitoring programme and stops appearing on any unit’s board. '
    + 'Readings already taken stay in the environmental record, and so does any excursion or nonconformity raised off them.',
  decontamination: 'The unit stops carrying this decontamination. A laboratory-wide one is not removed from the other units — '
    + 'this unit is excused from it, with the reason you give here.',
  equipment_maintenance: 'The instrument’s maintenance tasks are retired, so it stops producing a chart. '
    + 'The instrument itself stays on the equipment register exactly as it is.',
};

function ScheduleAdmin({ kind, entry, month, onRemove }: {
  kind: SheetKind; entry: { subject: { id: number; subject_name?: string }; sheet: { id: number } | null };
  month: string; onRemove: (target: RemovalTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = entry.subject.subject_name || 'this schedule';

  const target = (scope: 'sheet' | 'schedule'): RemovalTarget => ({
    scope, kind, subjectId: entry.subject.id, sheetId: entry.sheet?.id ?? null,
    name, monthLabel: monthLabel(month),
  });

  return (
    <div className="rs-admin">
      <button type="button" className="rs-admin-toggle" aria-expanded={open}
        title="Corrections a senior post can make to this register"
        onClick={() => setOpen(o => !o)}>
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="rs-admin-menu" role="menu">
          <span className="rs-admin-head">{name}</span>
          {entry.sheet && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onRemove(target('sheet')); }}>
              <Trash2 size={12} /> Delete {monthLabel(month)}&rsquo;s chart
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onRemove(target('schedule')); }}>
            <Trash2 size={12} /> Remove this schedule entirely
          </button>
          <span className="rs-admin-foot">
            Reserved to the administrator, the Quality Manager and the Laboratory Manager. Every removal is
            recorded with your name and your reason.
          </span>
        </div>
      )}
    </div>
  );
}

function RemoveScheduleDialog({ target, sectionId, onClose, onDone }: {
  target: RemovalTarget; sectionId: number | null; onClose: () => void; onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const wholeSchedule = target.scope === 'schedule';

  async function remove() {
    setBusy(true); setProblem(null);
    try {
      const path = wholeSchedule
        ? `/routine-sheets/subjects/${target.kind}/${target.subjectId}`
        : `/routine-sheets/${target.sheetId}`;
      await api(path, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason.trim(), sectionId: sectionId ?? undefined }),
      });
      await onDone();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="rs-remove">
      <div className="rs-remove-head">
        <strong><Trash2 size={13} /> {wholeSchedule ? `Remove ${target.name}` : `Delete ${target.monthLabel}’s chart`}</strong>
        <button type="button" className="pq-link" onClick={onClose}>Cancel</button>
      </div>
      <p className="muted">
        {wholeSchedule
          ? `${REMOVAL_CONSEQUENCE[target.kind]} Every month already charted against it is deleted with it, signed and verified months included.`
          : `${target.monthLabel}’s entries, notes and amendment trail are deleted, including a supervisor’s signature if the month was already verified. `
            + 'The schedule stays, and the month reopens blank so it can be charted again.'}
      </p>

      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

      <label className="rs-remove-reason">
        <span>Why is it being removed?</span>
        <TextField value={reason} onValue={setReason}
          placeholder="e.g. Registered twice — this is the duplicate; the readings are on ENV-0007." />
      </label>

      <div className="pr-btns">
        <button type="button" className="danger" disabled={busy || reason.trim().length < 10} onClick={() => void remove()}>
          {busy ? 'Removing…' : wholeSchedule ? 'Remove it and its charts' : 'Delete this month’s chart'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>Keep it</button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Registering something new to chart

   The unit that reads the fridge is the unit that knows a new one has arrived.
   Sending them to Facilities & Safety to say so is why a new fridge goes
   unmonitored for a fortnight, so it is done here, and it becomes their unit's
   to read.

   The presets exist for one reason: the acceptable range is the field that gets
   left blank, and a chart with no range records numbers rather than control.
   Every value is still editable, because a range is the laboratory's decision.
   ------------------------------------------------------------------------- */
type ParameterDraft = { label: string; unit: string; minValue: string; maxValue: string; decimalPlaces: string };

const draftFrom = (p: ChartParameterPreset): ParameterDraft => ({
  label: p.label, unit: p.unit,
  minValue: p.minValue === null ? '' : String(p.minValue),
  maxValue: p.maxValue === null ? '' : String(p.maxValue),
  decimalPlaces: String(p.decimalPlaces),
});

function NewEnvironmentalLog({ month, onClose, onCreated }: {
  month: string; onClose: () => void; onCreated: (sheetId: number) => void | Promise<void>;
}) {
  const [preset, setPreset] = useState(ENVIRONMENTAL_CHART_PRESETS[0]);
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState(ENVIRONMENTAL_CHART_PRESETS[0].frequency);
  const [notes, setNotes] = useState('');
  const [parameters, setParameters] = useState<ParameterDraft[]>(ENVIRONMENTAL_CHART_PRESETS[0].parameters.map(draftFrom));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function choosePreset(key: string) {
    const next = ENVIRONMENTAL_CHART_PRESETS.find(p => p.key === key) ?? ENVIRONMENTAL_CHART_PRESETS[0];
    setPreset(next);
    setFrequency(next.frequency);
    setParameters(next.parameters.map(draftFrom));
  }

  const setParameter = (index: number, key: keyof ParameterDraft, value: string) =>
    setParameters(list => list.map((p, i) => (i === index ? { ...p, [key]: value } : p)));

  async function save() {
    setBusy(true); setProblem(null);
    try {
      const created = await api<{ id: number; sheetId: number | null }>('/environmental/charts/assets', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), assetType: preset.key, monitoringFrequency: frequency,
          notes: notes.trim() || null, month,
          parameters: parameters
            .filter(p => p.label.trim())
            .map(p => ({
              label: p.label.trim(), unit: p.unit.trim(),
              minValue: p.minValue === '' ? null : Number(p.minValue),
              maxValue: p.maxValue === '' ? null : Number(p.maxValue),
              decimalPlaces: Number(p.decimalPlaces) || 0,
            })),
        }),
      });
      if (created.sheetId) await onCreated(created.sheetId);
      else onClose();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="rs-newlog">
      <div className="rs-newlog-head">
        <strong>Register something new to chart</strong>
        <button type="button" className="pq-link" onClick={onClose}>Cancel</button>
      </div>
      <p className="muted">
        It becomes your unit&rsquo;s to read, and this month&rsquo;s chart opens as soon as it is saved.
        A reading outside the range you set here raises an excursion the moment it is entered.
      </p>

      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

      <div className="rs-newlog-grid">
        <label><span>What is it?</span>
          <select value={preset.key} onChange={e => choosePreset(e.target.value)}>
            {ENVIRONMENTAL_CHART_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label><span>What does the bench call it?</span>
          <TextField value={name} onValue={setName} placeholder="e.g. Reagent fridge 2, Haematology bench" />
        </label>
        <label><span>How often is it read?</span>
          <select value={frequency} onChange={e => setFrequency(e.target.value)}>
            {CHART_FREQUENCIES.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
      </div>

      <table className="rs-param-table">
        <thead><tr><th>Parameter</th><th>Unit</th><th>Lowest acceptable</th><th>Highest acceptable</th><th>Decimals</th><th /></tr></thead>
        <tbody>
          {parameters.map((p, i) => (
            <tr key={i}>
              <td><TextField value={p.label} onValue={next => setParameter(i, 'label', next)} placeholder="Temperature" /></td>
              <td><TextField value={p.unit} onValue={next => setParameter(i, 'unit', next)} placeholder="°C" style={{ width: 64 }} /></td>
              <td><input type="number" step="any" value={p.minValue} onChange={e => setParameter(i, 'minValue', e.target.value)} style={{ width: 92 }} /></td>
              <td><input type="number" step="any" value={p.maxValue} onChange={e => setParameter(i, 'maxValue', e.target.value)} style={{ width: 92 }} /></td>
              <td><input type="number" min={0} max={3} value={p.decimalPlaces} onChange={e => setParameter(i, 'decimalPlaces', e.target.value)} style={{ width: 56 }} /></td>
              <td>{parameters.length > 1 && (
                <button type="button" className="pq-link" onClick={() => setParameters(list => list.filter((_, x) => x !== i))}>Remove</button>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="pq-link"
        onClick={() => setParameters(list => [...list, { label: '', unit: '', minValue: '', maxValue: '', decimalPlaces: '1' }])}>
        <Plus size={12} /> Add another parameter
      </button>

      <label className="rs-newlog-notes"><span>Anything the person reading it should know</span>
        <TextField value={notes} onValue={setNotes} placeholder="Alarm is on the wall behind it; defrosts on the first Monday." />
      </label>

      <div className="pr-btns">
        <button type="button" disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Register it and open the chart'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The decontamination programme, from the portal.
 *
 * Reading the programme is separate from filling in its logs on purpose: a
 * member of staff needs to know what their unit is supposed to decontaminate
 * and how often, and that question has an answer even in a month where nothing
 * has been recorded yet.
 */
export function PortalDeconProgramme({ sectionId }: { sectionId?: number | null } = {}) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { setRows(await api<any[]>(`/decontamination/definitions${sectionId ? `?sectionId=${sectionId}` : ''}`)); }
      catch (e) { setProblem(errorText(e)); }
    })();
  }, [sectionId]);

  if (problem) return <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>;
  if (!rows) return <p className="muted">Loading the programme…</p>;
  if (!rows.length) return null;

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><ClipboardList size={16} /> What your unit decontaminates</h3>
          <p>
            The laboratory-wide programme every unit carries, plus anything your unit added.
            A padlock means the frequency was set for the whole laboratory and your unit head adjusts it, not you.
          </p>
        </div>
      </div>
      <ul className="rs-defs">
        {rows.map(row => (
          <li key={row.id}>
            <span className="rs-def-name">
              {row.scope === 'general' && <Lock size={10} />} {row.name}
            </span>
            <span className="rs-def-meta">
              <span className="badge">{String(row.effective_frequency ?? row.frequency).replace(/_/g, ' ')}</span>
              {row.effective_decontaminant && <span>{row.effective_decontaminant}</span>}
              {row.is_excluded ? <span className="badge warning">not carried here — {row.exclusion_reason}</span> : null}
            </span>
            {row.method && <p className="rs-def-method">{row.method}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export { Plus as AddIcon };
