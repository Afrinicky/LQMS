import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Droplets,
  Lock, Plus, Sparkles, Trash2, X,
} from 'lucide-react';
import { api, errorText } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import PageHeader from '../components/ui/PageHeader';
import TextField from '../components/ui/TextField';
import LogSheetGrid, { SheetPicker } from '../components/routine/LogSheetGrid';
import {
  DECON_FREQUENCIES, DECON_FREQUENCY_LABELS, DECON_SCOPE_HINTS, DECON_SCOPE_LABELS,
  monthLabel, type DeconFrequency,
} from '../../shared/constants/routineWork';
import { ACTIVITY_TIERS, TIER_LABELS, type ActivityTier } from '../../shared/constants/activities';
import type { DecontaminationDefinition, LogSheetIndex } from '../../shared/types/api';

/**
 * Decontamination — the programme, and the month.
 *
 * The laboratory sets the general programme; a unit adds what its own room
 * needs; everybody in the unit performs it. That division is what this screen
 * is built around, and it is why the frameworks are offered rather than an
 * empty form: a laboratory setting this up on a Monday morning should be
 * recording decontamination by Monday afternoon, not writing "wipe the bench
 * tops twice a day" from scratch.
 *
 * A laboratory-wide decontamination cannot be deleted by a unit, because then
 * the programme means nothing. It can be run at the unit's own frequency, and
 * a unit can be excused from one — with a reason, recorded, because an
 * unexplained gap and a considered exemption look identical in a register and
 * only one of them is acceptable.
 */

type Tab = 'programme' | 'logs' | 'frameworks';

export default function DecontaminationPage({ embedded }: { embedded?: boolean }) {
  const { can } = usePermissions();
  const [tab, setTab] = useState<Tab>('logs');
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      {!embedded && (
        <PageHeader eyebrow="Facilities and Safety" title="Decontamination"
          subtitle="The bench and environment decontamination programme, and the monthly logs it produces." />
      )}
      {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}

      <div className="tabbar" role="tablist">
        {([
          ['logs', 'Monthly logs'],
          ['programme', 'The programme'],
          ['frameworks', 'Add from the standard set'],
        ] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'logs' && <DeconLogs onError={setError} />}
      {tab === 'programme' && <DeconProgramme onError={setError} canEdit={can('facilities_safety.decontamination', 'edit')} />}
      {tab === 'frameworks' && <DeconFrameworks onError={setError} canAdopt={can('facilities_safety.decontamination', 'create')} />}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The month
   ------------------------------------------------------------------------- */
function DeconLogs({ onError }: { onError: (m: string | null) => void }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [index, setIndex] = useState<LogSheetIndex | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api<LogSheetIndex>(`/decontamination/logs?month=${month}`);
      setIndex(next);
      onError(null);
      setActiveId(previous => next.sheets.some(s => s.sheet?.id === previous)
        ? previous
        : next.sheets.find(s => s.sheet)?.sheet?.id ?? null);
    } catch (e) { onError(errorText(e)); }
    finally { setLoading(false); }
  }, [month, onError]);

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
          <h3><Droplets size={16} /> Decontamination logs</h3>
          <p>
            One log per decontamination, per month. Anyone in the unit records on it; at the end of the month
            the unit supervisor reads it, signs it and it is filed. A day left blank stays blank — that is
            what the log is for.
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
            Nothing is set up for this unit yet. Open &ldquo;Add from the standard set&rdquo; and adopt the
            laboratory-wide programme — benches, floors, sinks, fans, cobwebs — then adjust it to how this
            laboratory actually works.
          </p>
        ) : (
          <div className="rs-split">
            <div className="rs-list"><SheetPicker sheets={index.sheets} activeId={activeId} onPick={setActiveId} /></div>
            <div className="rs-grid">
              {activeId ? <LogSheetGrid sheetId={activeId} onChanged={load} />
                : <p className="muted">Choose a log on the left.</p>}
            </div>
          </div>
        )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The programme
   ------------------------------------------------------------------------- */
const EMPTY_FORM = {
  name: '', scope: 'unit' as 'general' | 'unit', sectionId: '' as string,
  surfaceType: '', frequency: 'daily' as DeconFrequency, decontaminant: '',
  method: '', instructions: '', contactTimeMinutes: '', performerTier: 'general' as ActivityTier,
};

function DeconProgramme({ onError, canEdit }: { onError: (m: string | null) => void; canEdit: boolean }) {
  const [rows, setRows] = useState<DecontaminationDefinition[] | null>(null);
  const [sections, setSections] = useState<Array<{ id: number; name: string }>>([]);
  const [sectionFilter, setSectionFilter] = useState<string>('');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DecontaminationDefinition | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = sectionFilter ? `?sectionId=${sectionFilter}` : '';
      setRows(await api<DecontaminationDefinition[]>(`/decontamination/definitions${query}`));
      onError(null);
    } catch (e) { onError(errorText(e)); }
  }, [sectionFilter, onError]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try { setSections(await api<Array<{ id: number; name: string }>>('/sections')); }
      catch { /* the filter is a convenience; the page works without it */ }
    })();
  }, []);

  async function save() {
    setBusy(true);
    try {
      const body = JSON.stringify({
        ...form,
        sectionId: form.scope === 'unit' ? Number(form.sectionId) || null : null,
        contactTimeMinutes: form.contactTimeMinutes ? Number(form.contactTimeMinutes) : null,
      });
      if (editing) await api(`/decontamination/definitions/${editing.id}`, { method: 'PUT', body });
      else await api('/decontamination/definitions', { method: 'POST', body });
      setShowForm(false); setEditing(null); setForm({ ...EMPTY_FORM });
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  const grouped = useMemo(() => ({
    general: (rows ?? []).filter(r => r.scope === 'general'),
    unit: (rows ?? []).filter(r => r.scope === 'unit'),
  }), [rows]);

  return (
    <div className="card">
      <div className="pp-head">
        <div>
          <h3>The decontamination programme</h3>
          <p>
            Laboratory-wide decontaminations are carried by every unit; a unit head sets their own frequency for
            their room and adds whatever else it needs. Changing a laboratory-wide one changes it everywhere.
          </p>
        </div>
        <div className="pp-head-actions">
          <label className="inline">
            <span>Unit</span>
            <select value={sectionFilter} onChange={e => setSectionFilter(e.target.value)}>
              <option value="">The whole catalogue</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {canEdit && (
            <button type="button" onClick={() => { setEditing(null); setForm({ ...EMPTY_FORM, sectionId: sectionFilter }); setShowForm(true); }}>
              <Plus size={13} /> Add one
            </button>
          )}
        </div>
      </div>

      {!rows ? <p className="muted">Loading…</p> : (
        <>
          {grouped.general.length > 0 && (
            <>
              <h4 className="rw-subhead">Laboratory-wide — {DECON_SCOPE_HINTS.general}</h4>
              <ul className="dc-defs">
                {grouped.general.map(row => (
                  <DefinitionRow key={row.id} row={row} sectionId={sectionFilter ? Number(sectionFilter) : null}
                    canEdit={canEdit} onChanged={load} onError={onError}
                    onEdit={() => { setEditing(row); setForm(formFrom(row)); setShowForm(true); }} />
                ))}
              </ul>
            </>
          )}
          {grouped.unit.length > 0 && (
            <>
              <h4 className="rw-subhead">Added by units — {DECON_SCOPE_HINTS.unit}</h4>
              <ul className="dc-defs">
                {grouped.unit.map(row => (
                  <DefinitionRow key={row.id} row={row} sectionId={sectionFilter ? Number(sectionFilter) : null}
                    canEdit={canEdit} onChanged={load} onError={onError}
                    onEdit={() => { setEditing(row); setForm(formFrom(row)); setShowForm(true); }} />
                ))}
              </ul>
            </>
          )}
          {rows.length === 0 && <p className="muted">Nothing in the programme yet.</p>}
        </>
      )}

      {showForm && (
        <div className="ls-modal-back" onClick={() => setShowForm(false)}>
          <div className="ls-modal" onClick={e => e.stopPropagation()}>
            <header>
              <h4>{editing ? 'Change this decontamination' : 'Add a decontamination'}</h4>
              <button type="button" className="pq-link" onClick={() => setShowForm(false)}><X size={14} /></button>
            </header>

            <label><span>What is decontaminated</span>
              <TextField value={form.name} onValue={v => setForm(f => ({ ...f, name: v }))}
                placeholder="Bench tops, floors, ceiling fans…" autoFocus /></label>

            <div className="iqc-run-meta">
              <label><span>Who carries it</span>
                <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value as any }))}>
                  <option value="general">{DECON_SCOPE_LABELS.general}</option>
                  <option value="unit">{DECON_SCOPE_LABELS.unit}</option>
                </select>
              </label>
              {form.scope === 'unit' && (
                <label><span>Unit</span>
                  <select value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))}>
                    <option value="">Choose…</option>
                    {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
              )}
              <label><span>How often</span>
                <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value as DeconFrequency }))}>
                  {DECON_FREQUENCIES.map(f => <option key={f} value={f}>{DECON_FREQUENCY_LABELS[f]}</option>)}
                </select>
              </label>
              <label><span>Who may perform it</span>
                <select value={form.performerTier} onChange={e => setForm(f => ({ ...f, performerTier: e.target.value as ActivityTier }))}>
                  {ACTIVITY_TIERS.map(t => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                </select>
              </label>
            </div>

            <label><span>Decontaminant used</span>
              <TextField value={form.decontaminant} onValue={v => setForm(f => ({ ...f, decontaminant: v }))}
                placeholder="0.5% sodium hypochlorite, followed by 70% alcohol" /></label>
            <label><span>How it is done</span>
              <TextField as="textarea" rows={2} value={form.method} onValue={v => setForm(f => ({ ...f, method: v }))}
                placeholder="Wipe the whole surface, allow the contact time, then wipe with alcohol." /></label>
            <label><span>Anything the person doing it needs to know</span>
              <TextField as="textarea" rows={2} value={form.instructions} onValue={v => setForm(f => ({ ...f, instructions: v }))} /></label>

            <p className="ls-modal-lead">
              A reminder is created for every unit that carries this, at this frequency, on the duty list of
              whoever is rostered. Twice-daily work gets an AM and a PM entry on the log, exactly as the paper
              form has it.
            </p>

            <div className="pr-btns">
              <button type="button" disabled={busy || !form.name.trim()} onClick={() => void save()}>
                <Check size={14} /> {editing ? 'Save the change' : 'Add it'}
              </button>
              <button type="button" className="secondary" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formFrom(row: DecontaminationDefinition) {
  return {
    name: row.name, scope: row.scope, sectionId: row.section_id ? String(row.section_id) : '',
    surfaceType: row.surface_type ?? '', frequency: row.frequency as DeconFrequency,
    decontaminant: row.decontaminant ?? '', method: row.method ?? '',
    instructions: row.instructions ?? '',
    contactTimeMinutes: row.contact_time_minutes ? String(row.contact_time_minutes) : '',
    performerTier: (row.performer_tier || 'general') as ActivityTier,
  };
}

function DefinitionRow({ row, sectionId, canEdit, onEdit, onChanged, onError }: {
  row: DecontaminationDefinition; sectionId: number | null; canEdit: boolean;
  onEdit: () => void; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [showUnit, setShowUnit] = useState(false);
  const [frequency, setFrequency] = useState<string>(row.effective_frequency ?? row.frequency);
  const [excluded, setExcluded] = useState(Boolean(row.is_excluded));
  const [reason, setReason] = useState(row.exclusion_reason ?? '');
  const [busy, setBusy] = useState(false);

  async function saveUnitSetting() {
    if (!sectionId) return;
    setBusy(true);
    try {
      await api(`/decontamination/definitions/${row.id}/units/${sectionId}`, {
        method: 'PUT',
        body: JSON.stringify({ frequency, isExcluded: excluded, exclusionReason: reason }),
      });
      setShowUnit(false); onChanged();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <li className={`dc-def scope-${row.scope}${row.is_excluded ? ' is-excluded' : ''}`}>
      <div className="dc-def-head">
        {row.scope === 'general' && <Lock size={11} />}
        <span className="dc-def-name">{row.name}</span>
        <span className="badge">{DECON_FREQUENCY_LABELS[(row.effective_frequency ?? row.frequency) as DeconFrequency] ?? row.frequency}</span>
        {row.section_name && <span className="badge">{row.section_name}</span>}
        {row.is_excluded ? <span className="badge warning">not carried here</span> : null}
        {row.performer_tier !== 'general' && <span className="badge">{TIER_LABELS[row.performer_tier as ActivityTier]}</span>}
      </div>
      {(row.effective_decontaminant ?? row.decontaminant) && (
        <p className="dc-def-body"><strong>Decontaminant:</strong> {row.effective_decontaminant ?? row.decontaminant}</p>
      )}
      {row.method && <p className="dc-def-body">{row.method}</p>}
      {row.is_excluded && row.exclusion_reason && (
        <p className="dc-def-body"><strong>Why this unit does not carry it:</strong> {row.exclusion_reason}</p>
      )}

      <div className="dc-def-actions">
        {canEdit && <button type="button" className="pq-link" onClick={onEdit}>Change it</button>}
        {sectionId && (
          <button type="button" className="pq-link" onClick={() => setShowUnit(v => !v)}>
            {showUnit ? 'Close' : 'How this unit runs it'}
          </button>
        )}
      </div>

      {showUnit && sectionId && (
        <div className="rw-expand">
          <label className="inline">
            <span>Frequency in this unit</span>
            <select value={frequency} onChange={e => setFrequency(e.target.value)}>
              {DECON_FREQUENCIES.map(f => <option key={f} value={f}>{DECON_FREQUENCY_LABELS[f]}</option>)}
            </select>
          </label>
          <label className="ls-check">
            <input type="checkbox" checked={excluded} onChange={e => setExcluded(e.target.checked)} />
            <span>This unit does not carry this one</span>
          </label>
          {excluded && (
            <label>
              <span>Why not</span>
              <TextField value={reason} onValue={setReason}
                placeholder="No ceiling fans in this room; the ceiling is sealed." />
            </label>
          )}
          <div className="pr-btns">
            <button type="button" disabled={busy || (excluded && !reason.trim())} onClick={() => void saveUnitSetting()}>Save</button>
            <button type="button" className="secondary" onClick={() => setShowUnit(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

/* ----------------------------------------------------------------------------
   The shipped frameworks
   ------------------------------------------------------------------------- */
function DeconFrameworks({ onError, canAdopt }: { onError: (m: string | null) => void; canAdopt: boolean }) {
  const [frameworks, setFrameworks] = useState<any[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setFrameworks(await api<any[]>('/decontamination/frameworks')); }
    catch (e) { onError(errorText(e)); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  async function adopt() {
    setBusy(true);
    try {
      const result = await api<{ created: number; skipped: string[] }>('/decontamination/adopt', {
        method: 'POST',
        body: JSON.stringify({ frameworks: [...chosen].map(key => ({ key })) }),
      });
      setDone(`${result.created} added${result.skipped.length ? `; ${result.skipped.length} were already in the programme` : ''}.`);
      setChosen(new Set());
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card">
      <div className="pp-head">
        <div>
          <h3><Sparkles size={16} /> The standard set</h3>
          <p>
            The decontaminations most laboratories run, with sensible frequencies and the method written out.
            Tick what applies here and adopt them; every one can be edited afterwards, and a unit can run any of
            them at its own frequency. Nothing here overrides your own SOP — it is a starting point, not a rule.
          </p>
        </div>
        {canAdopt && chosen.size > 0 && (
          <button type="button" disabled={busy} onClick={() => void adopt()}>
            <Check size={13} /> Adopt {chosen.size}
          </button>
        )}
      </div>

      {done && <p className="ls-locked"><Check size={12} /> {done}</p>}

      {!frameworks ? <p className="muted">Loading…</p> : (
        <ul className="dc-frameworks">
          {frameworks.map(framework => (
            <li key={framework.key} className={`dc-framework${framework.inUse ? ' is-used' : ''}`}>
              <input type="checkbox" disabled={framework.inUse || !canAdopt}
                checked={chosen.has(framework.key)}
                onChange={e => setChosen(previous => {
                  const next = new Set(previous);
                  if (e.target.checked) next.add(framework.key); else next.delete(framework.key);
                  return next;
                })} />
              <div>
                <span className="dc-framework-name">{framework.name}</span>
                <span className="dc-framework-meta">
                  {DECON_FREQUENCY_LABELS[framework.frequency as DeconFrequency]} · {framework.decontaminant}
                  {framework.inUse ? ' · already in the programme' : ''}
                </span>
                <p className="dc-framework-method">{framework.method}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { Trash2 as DeleteIcon, AlertTriangle as WarnIcon };
