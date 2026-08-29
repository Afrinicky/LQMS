import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, ClipboardList,
  Droplets, Lock, Plus, Thermometer, Wrench,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import LogSheetGrid, { SheetPicker } from '../../components/routine/LogSheetGrid';
import { monthLabel, LOGGING_MODE_LABELS, type SheetKind } from '../../../shared/constants/routineWork';
import type { LogSheetIndex } from '../../../shared/types/api';

/**
 * Environmental charting, decontamination and equipment maintenance, in the
 * portal — the three registers that are the same object with different rows.
 *
 * Each one shows the unit's whole programme for the month down the left and the
 * chosen sheet's grid beside it. Two things about that arrangement are
 * deliberate.
 *
 * The programme is shown even where nothing has been recorded. A list of the
 * charts that have entries would show a healthy month on a bench that stopped
 * charting on the 9th, which is precisely the failure the register exists to
 * make visible. So every asset the unit is responsible for is listed, with how
 * much of its month is actually recorded, whether it has ever been opened or not.
 *
 * The grid is worked here, not somewhere else. A member of staff standing at a
 * fridge with a thermometer should type the number where they are told the
 * reading is due. Sending them to another module to record it is how readings
 * end up written on a scrap of paper "for later".
 */

const KIND_META: Record<SheetKind, { icon: ReactNode; title: string; lead: string; empty: string }> = {
  environmental: {
    icon: <Thermometer size={16} />,
    title: 'Environmental monitoring',
    lead: 'The fridges, freezers, rooms and incubators your unit is responsible for, and this month\'s chart for each. A reading outside its range raises an excursion the moment you enter it.',
    empty: 'No environmental assets are assigned to your unit. Fridges, freezers and rooms are registered under Facilities & Safety → Environmental Monitoring, and each one names the unit responsible for reading it.',
  },
  decontamination: {
    icon: <Droplets size={16} />,
    title: 'Decontamination',
    lead: 'Everything your unit decontaminates, how often, and this month\'s log. Everyone in the unit does this work and everyone can record it.',
    empty: 'No decontamination is set up for your unit yet. The laboratory-wide programme — benches, floors, fans, windows — is adopted under Facilities & Safety → Decontamination, and your unit head can add whatever your own room needs.',
  },
  equipment_maintenance: {
    icon: <Wrench size={16} />,
    title: 'Equipment maintenance',
    lead: 'The routine care your unit\'s instruments need — daily across the days, weekly and scheduled servicing across the weeks — on one chart per instrument.',
    empty: 'None of your unit\'s equipment has maintenance tasks defined yet. Tasks are added on the instrument under Equipment → Maintenance; a starting list is offered for microscopes, fridges, centrifuges, analysers, autoclaves and cabinets.',
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

        {loading ? <p className="muted">Loading this month&rsquo;s sheets…</p>
          : !index || index.sheets.length === 0 ? <p className="muted">{meta.empty}</p> : (
            <>
              <div className="rs-totals">
                <span><strong>{totals.count}</strong> {totals.count === 1 ? 'sheet' : 'sheets'}</span>
                {totals.behind > 0 && <span className="warn"><strong>{totals.behind}</strong> behind</span>}
                {totals.breaches > 0 && <span className="crit"><strong>{totals.breaches}</strong> out of range or not done</span>}
                {totals.awaiting > 0 && <span><strong>{totals.awaiting}</strong> waiting to be verified</span>}
              </div>

              <div className="rs-split">
                <div className="rs-list">
                  <SheetPicker sheets={index.sheets} activeId={activeId} onPick={setActiveId} />
                </div>
                <div className="rs-grid">
                  {activeId
                    ? <LogSheetGrid sheetId={activeId} onChanged={load} />
                    : <p className="muted">Choose a sheet on the left to record on it.</p>}
                </div>
              </div>
            </>
          )}
      </section>
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
