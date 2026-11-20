/**
 * Analyser models — the ones this laboratory keeps for itself.
 *
 * Two jobs on one screen, because they are the same job seen from two sides.
 *
 * THE STARTING SET. When an analyser is not one of the listed models, a link
 * has to start from something. It used to start from nothing: an empty
 * Parameter Mappings table, no units, and no indication of where to begin.
 * It now starts from the set below — every parameter this system knows for
 * that discipline, in SI — and because a laboratory measures what it measures,
 * that set is edited here once rather than on every link in turn.
 *
 * A MODEL OF ITS OWN. An analyser nobody has written a model for used to need
 * a code change. Described here, it joins the Model list beside the built-in
 * ones and behaves exactly like them everywhere else.
 *
 * Nothing on this screen touches a connection. A model says what a code is
 * READ AS; changing one affects messages arriving from then on, and no link is
 * restarted, so no analyser notices.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../ui/TextField';
import { Notice } from '../ui/Feedback';
import { DISCIPLINE_LABELS, LINK_PROTOCOL_LABELS, type LinkProtocol } from '../../../shared/constants/instruments';

type Model = {
  key: string; label: string; vendor: string; discipline: string; protocol: string;
  notes: string | null; origin: 'builtin' | 'default' | 'custom';
  analytes: Record<string, string>; units: Record<string, string>;
  analyteCount: number; usedBy: string[];
};
type DefaultSet = {
  discipline: string; label: string; key: string;
  analytes: Record<string, string>; units: Record<string, string>;
  edited: boolean; shippedCount: number;
};
type KnownUnit = { canonical: string; dimension: string };

/** One editable line: what the analyser sends, what it means, what scale it is kept in. */
interface Row { code: string; parameter: string; unit: string }

/**
 * The two maps a model carries, as one table a person can read.
 *
 * A model stores codes against parameters and parameters against units, which
 * is the right shape for a machine and the wrong one for somebody checking
 * their analyser's menu against the screen. Here it is one row per code, with
 * the unit of the parameter it resolves to shown beside it.
 */
function toRows(analytes: Record<string, string>, units: Record<string, string>): Row[] {
  return Object.entries(analytes)
    .map(([code, parameter]) => ({ code, parameter, unit: units[parameter] ?? '' }))
    .sort((a, b) => a.parameter.localeCompare(b.parameter) || a.code.localeCompare(b.code));
}

function fromRows(rows: Row[]): { analytes: Record<string, string>; units: Record<string, string> } {
  const analytes: Record<string, string> = {};
  const units: Record<string, string> = {};
  for (const row of rows) {
    const code = row.code.trim();
    const parameter = row.parameter.trim();
    if (!code || !parameter) continue;
    analytes[code] = parameter;
    // Two codes for one parameter share its scale, which is correct: HGB and
    // HB are one measurement written twice, not two measurements.
    if (row.unit.trim()) units[parameter] = row.unit.trim();
  }
  return { analytes, units };
}

export default function AnalyserModels({ canEdit }: { canEdit: boolean }) {
  const [models, setModels] = useState<Model[] | null>(null);
  const [defaults, setDefaults] = useState<DefaultSet[]>([]);
  const [units, setUnits] = useState<KnownUnit[]>([]);
  const [protocols, setProtocols] = useState<string[]>([]);
  const [disciplines, setDisciplines] = useState<Array<{ key: string; label: string }>>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ model: Model | null; isDefault: DefaultSet | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const data = await api<{
        models: Model[]; defaults: DefaultSet[]; units: KnownUnit[];
        protocols: string[]; disciplines: Array<{ key: string; label: string }>;
      }>('/instrument-links/models');
      setModels(data.models);
      setDefaults(data.defaults);
      setUnits(data.units);
      setProtocols(data.protocols);
      setDisciplines(data.disciplines);
    } catch (e) { setError(errorText(e)); }
  }

  useEffect(() => { if (open && models === null) void load(); }, [open]);

  const custom = useMemo(() => (models ?? []).filter(m => m.origin === 'custom'), [models]);

  async function remove(model: Model) {
    if (!window.confirm(`Remove "${model.label}"? Links can no longer be set to it.`)) return;
    setBusy(true); setError(null);
    try {
      await api(`/instrument-links/models/${encodeURIComponent(model.key)}`, { method: 'DELETE' });
      setNotice(`${model.label} was removed.`);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function reset(set: DefaultSet) {
    if (!window.confirm(`Put the ${set.label.toLowerCase()} starting set back to the ${set.shippedCount} parameters this system ships with?`)) return;
    setBusy(true); setError(null);
    try {
      await api(`/instrument-links/defaults/${set.discipline}/reset`, { method: 'POST' });
      setNotice(`The ${set.label.toLowerCase()} starting set is back to what the system ships with.`);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="card am-card">
      <div className="pp-head am-head" onClick={() => setOpen(v => !v)} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(v => !v); }}>
        <div>
          <h3>
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Analyser models
          </h3>
          <p className="muted am-sub">
            What a link starts from when the analyser is not on the list, and any analyser this laboratory has
            described itself.
          </p>
        </div>
        {models && <span className="am-count">{custom.length} added · {defaults.filter(d => d.edited).length} edited</span>}
      </div>

      {open && (
        <div className="am-body">
          {error && <Notice kind="error">{error}</Notice>}
          {notice && <Notice kind="success">{notice}</Notice>}

          {models === null ? (
            <p className="muted"><Loader2 size={13} className="pd-spin" /> Reading the models…</p>
          ) : (
            <>
              <h4 className="am-section">What a not-listed analyser starts with</h4>
              <p className="am-blurb">
                Choosing “not listed” in the Model box loads the set for that discipline. Every parameter here is
                editable on the link afterwards; changing it here changes what the <em>next</em> link starts from.
              </p>
              <table className="data-table am-table">
                <thead><tr><th>Discipline</th><th>Parameters</th><th>Scales set</th><th /></tr></thead>
                <tbody>
                  {defaults.map(set => (
                    <tr key={set.discipline}>
                      <td><strong>{set.label}</strong></td>
                      <td>
                        {Object.keys(set.analytes).length} codes
                        {set.edited
                          ? <span className="am-chip am-chip-edit">edited here</span>
                          : <span className="am-chip">as the system ships it</span>}
                      </td>
                      <td className="muted">{Object.keys(set.units).length}</td>
                      <td className="am-actions">
                        {canEdit && (
                          <>
                            <button type="button" className="pq-link" disabled={busy}
                              onClick={() => setEditing({ model: null, isDefault: set })}>
                              <Pencil size={12} /> Edit
                            </button>
                            {set.edited && (
                              <button type="button" className="pq-link" disabled={busy} onClick={() => void reset(set)}>
                                <RotateCcw size={12} /> Reset
                              </button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4 className="am-section">Models this laboratory added</h4>
              {!custom.length ? (
                <p className="am-blurb">
                  None yet. An analyser that is not on the list can be described once here, and it then appears in
                  the Model box for every link.
                </p>
              ) : (
                <table className="data-table am-table">
                  <thead><tr><th>Model</th><th>Discipline</th><th>Speaks</th><th>Parameters</th><th /></tr></thead>
                  <tbody>
                    {custom.map(model => (
                      <tr key={model.key}>
                        <td>
                          <strong>{model.label}</strong>
                          {model.vendor && <small className="muted"> {model.vendor}</small>}
                          {model.usedBy.length > 0 && (
                            <small className="am-used">in use by {model.usedBy.join(', ')}</small>
                          )}
                        </td>
                        <td className="muted">{DISCIPLINE_LABELS[model.discipline as keyof typeof DISCIPLINE_LABELS] ?? model.discipline}</td>
                        <td className="muted">{String(model.protocol).toUpperCase()}</td>
                        <td className="muted">{model.analyteCount}</td>
                        <td className="am-actions">
                          {canEdit && (
                            <>
                              <button type="button" className="pq-link" disabled={busy}
                                onClick={() => setEditing({ model, isDefault: null })}>
                                <Pencil size={12} /> Edit
                              </button>
                              <button type="button" className="pq-link am-danger" disabled={busy}
                                onClick={() => void remove(model)}>
                                <Trash2 size={12} /> Remove
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {canEdit && (
                <div className="am-foot">
                  <button type="button" className="secondary" disabled={busy}
                    onClick={() => setEditing({ model: null, isDefault: null })}>
                    <Plus size={13} /> Describe an analyser
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {editing && (
        <ModelEditor
          model={editing.model}
          error={error}
          startingSet={editing.isDefault}
          models={models ?? []}
          units={units}
          protocols={protocols}
          disciplines={disciplines}
          onClose={() => setEditing(null)}
          onSaved={async note => { setEditing(null); setNotice(note); await load(); }}
          onError={setError}
        />
      )}
    </div>
  );
}

/* ============================================================================
   The editor
   ----------------------------------------------------------------------------
   One form for both jobs. A discipline's starting set has no name, vendor or
   protocol to choose — it is a set of parameters and nothing else — so those
   fields are simply not shown for it, rather than shown and ignored.
   ========================================================================= */
function ModelEditor({ model, startingSet, models, units, protocols, disciplines, error, onClose, onSaved, onError }: {
  model: Model | null;
  startingSet: DefaultSet | null;
  /** Why the last save was refused. Shown here, not on the card behind. */
  error: string | null;
  models: Model[];
  units: KnownUnit[];
  protocols: string[];
  disciplines: Array<{ key: string; label: string }>;
  onClose: () => void;
  onSaved: (note: string) => Promise<void> | void;
  onError: (message: string | null) => void;
}) {
  const isDefault = Boolean(startingSet);
  const [label, setLabel] = useState(model?.label ?? '');
  const [key, setKey] = useState(model?.key ?? '');
  const [vendor, setVendor] = useState(model?.vendor ?? '');
  const [discipline, setDiscipline] = useState(startingSet?.discipline ?? model?.discipline ?? 'chemistry');
  const [protocol, setProtocol] = useState<string>(model?.protocol ?? 'astm');
  const [notes, setNotes] = useState(model?.notes ?? '');
  const [rows, setRows] = useState<Row[]>(() =>
    toRows(startingSet?.analytes ?? model?.analytes ?? {}, startingSet?.units ?? model?.units ?? {}));
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  /*
   * A key is what a link stores to remember its model, so it is derived from
   * the name once and then left alone. Changing it under a link that is using
   * it is refused by the server; letting it drift as somebody edits the name
   * would simply make that refusal arrive as a surprise.
   */
  useEffect(() => {
    if (model || isDefault) return;
    setKey(label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40));
  }, [label, model, isDefault]);

  const shown = useMemo(() => {
    const needle = search.trim().toUpperCase();
    if (!needle) return rows;
    return rows.filter(row => `${row.code} ${row.parameter}`.toUpperCase().includes(needle));
  }, [rows, search]);

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows(list => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  /** Copy an existing model's parameters in, for an analyser much like another. */
  function copyFrom(sourceKey: string) {
    const source = models.find(m => m.key === sourceKey);
    if (!source) return;
    setRows(toRows(source.analytes, source.units));
  }

  async function save() {
    const { analytes, units: unitMap } = fromRows(rows);
    if (!Object.keys(analytes).length) {
      onError('A model with no parameters would leave a link understanding nothing. Add at least one.');
      return;
    }
    setSaving(true); onError(null);
    try {
      if (isDefault) {
        await api(`/instrument-links/defaults/${discipline}`, {
          method: 'PUT', body: JSON.stringify({ analytes, units: unitMap }),
        });
        await onSaved(`The ${startingSet!.label.toLowerCase()} starting set now has ${Object.keys(analytes).length} codes. Links already made are unchanged.`);
      } else {
        await api('/instrument-links/models', {
          method: 'POST',
          body: JSON.stringify({
            key, label, vendor, discipline, protocol, notes,
            analytes, units: unitMap,
            existingKey: model?.key,
          }),
        });
        await onSaved(`${label} is now in the Model list, with ${Object.keys(analytes).length} codes.`);
      }
    } catch (e) { onError(errorText(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide am-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4>
            {isDefault
              ? `${startingSet!.label} — what a not-listed analyser starts with`
              : model ? `Change ${model.label}` : 'Describe an analyser'}
          </h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        {!isDefault && (
          <div className="lf-grid am-grid">
            <label className="lf-wide"><span>What to call it</span>
              <TextField value={label} onValue={setLabel} autoFocus placeholder="Mindray BA-88A" />
            </label>
            <label><span>Made by</span>
              <TextField value={vendor} onValue={setVendor} placeholder="Mindray" />
            </label>
            <label><span>Discipline</span>
              <select value={discipline} onChange={e => setDiscipline(e.target.value)}>
                {disciplines.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </label>
            <label><span>What it speaks</span>
              <select value={protocol} onChange={e => setProtocol(e.target.value)}>
                {protocols.map(p => (
                  <option key={p} value={p}>{LINK_PROTOCOL_LABELS[p as LinkProtocol] ?? p}</option>
                ))}
              </select>
            </label>
            <label className="lf-wide"><span>Anything somebody setting this up should know</span>
              <TextField value={notes} onValue={setNotes}
                placeholder="Where the host setting lives on the analyser, how it marks a control…" />
            </label>
            {!model && (
              <label className="lf-wide"><span>Start from an existing model</span>
                <select defaultValue="" onChange={e => { copyFrom(e.target.value); e.target.value = ''; }}>
                  <option value="">Start from nothing</option>
                  {models.filter(m => !m.key.startsWith('default_')).map(m => (
                    <option key={m.key} value={m.key}>{m.label} — {m.analyteCount} codes</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="am-rows-head">
          <strong>{rows.length} parameter{rows.length === 1 ? '' : 's'}</strong>
          <TextField value={search} onValue={setSearch} placeholder="Find a code or a parameter" />
          <button type="button" className="btn ghost"
            onClick={() => { setSearch(''); setRows(list => [{ code: '', parameter: '', unit: '' }, ...list]); }}>
            <Plus size={13} /> Add a parameter
          </button>
        </div>

        <div className="am-rows">
          <table className="data-table am-table">
            <thead>
              <tr>
                <th style={{ width: '22%' }}>The analyser sends</th>
                <th>Read as</th>
                <th style={{ width: '22%' }}>Kept in</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {!shown.length ? (
                <tr><td colSpan={4} className="muted">
                  {search ? 'Nothing matches.' : 'No parameters yet. Add one, or start from an existing model.'}
                </td></tr>
              ) : shown.map(row => {
                const index = rows.indexOf(row);
                return (
                  <tr key={index}>
                    <td><TextField value={row.code} onValue={v => setRow(index, { code: v })} placeholder="HGB" /></td>
                    <td><TextField value={row.parameter} onValue={v => setRow(index, { parameter: v })} placeholder="Haemoglobin" /></td>
                    <td>
                      <select value={row.unit} onChange={e => setRow(index, { unit: e.target.value })}>
                        <option value="">not rescaled</option>
                        {units.map(u => <option key={u.canonical} value={u.canonical}>{u.canonical}</option>)}
                      </select>
                    </td>
                    <td>
                      <button type="button" className="pq-link am-danger"
                        onClick={() => setRows(list => list.filter((_, i) => i !== index))}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/*
          * A refusal belongs in the dialog that caused it.
          *
          * This was reported on the card behind, which stays covered while
          * the editor is open — so a model rejected for a duplicate key, or
          * for having no parameters, looked like a Save button that did
          * nothing.
          */}
        {error && <Notice kind="error">{error}</Notice>}

        <p className="am-note">
          Only a change of scale is done automatically. A conversion that needs to know the analyte, such as
          <code> mg/dL</code> to <code> mmol/L</code>, is refused and the reading kept exactly as it came.
        </p>

        <footer className="am-foot">
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
          <button type="button" disabled={saving || (!isDefault && !label.trim())} onClick={() => void save()}>
            {saving ? <Loader2 size={13} className="pd-spin" /> : <Check size={13} />} Save
          </button>
        </footer>
      </div>
    </div>
  );
}
