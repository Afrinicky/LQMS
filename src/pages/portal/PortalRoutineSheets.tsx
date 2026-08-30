import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, ClipboardList,
  Droplets, Lock, Plus, Thermometer, Wrench,
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

export default function PortalRoutineSheets({ kind }: { kind: SheetKind }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [index, setIndex] = useState<LogSheetIndex | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<LogSheetIndex>(`${ENDPOINT[kind]}?month=${month}`);
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
  }, [kind, month]);

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
              </div>
            </>
          )}
      </section>
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
export function PortalDeconProgramme() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try { setRows(await api<any[]>('/decontamination/definitions')); }
      catch (e) { setProblem(errorText(e)); }
    })();
  }, []);

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
