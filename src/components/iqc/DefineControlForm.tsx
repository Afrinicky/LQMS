import { FormEvent, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import TextField from '../ui/TextField';
import {
  IQC_SOURCES, IQC_SOURCE_LABELS, IQC_SOURCE_HINTS,
  IQC_CONTROL_TYPES, IQC_CONTROL_TYPE_LABELS, IQC_CONTROL_TYPE_HINTS,
  IQC_FREQUENCIES, IQC_FREQUENCY_LABELS,
  IQC_RULE_PROFILE_LABELS, IQC_RULE_PROFILE_HINTS, PROFILES_FOR_TYPE,
  QUALITATIVE_SCALES, QUALITATIVE_LABELS, ANALYTE_TEMPLATES,
  AST_INTERPRETATIONS, AST_INTERPRETATION_LABELS, AST_METHODS, AST_METHOD_LABELS,
  CS_SCOPES, CS_SCOPE_LABELS, CS_SCOPE_HINTS, csNeedsOrganism, csNeedsPanel,
  type IqcSource, type IqcControlType, type IqcRuleProfile,
} from '../../../shared/constants/iqc';
import type { Section, Staff, EquipmentItem } from '../../../shared/types/api';

/**
 * Defining a control — the one wizard, wherever it is opened from.
 *
 * It lives here rather than on the Quality Control page because the portal
 * needs the SAME form, not one like it. Two forms for one act is how a control
 * ends up defined with a rule set in one place and no rule set in the other,
 * and how a laboratory ends up with two ideas of what a control record contains.
 *
 * The order of the questions is the order they genuinely answer each other in:
 * where the material came from decides what provenance must be recorded; what
 * kind of result it gives decides which rule sets can apply, whether the analyte
 * table asks for a mean and SD or an expected result, and what "acceptable"
 * even means for it.
 */

export type AnalyteDraft = {
  analyte: string; unit: string; targetMean: string; targetSd: string;
  acceptableLow: string; acceptableHigh: string; decimalPlaces: string; expectedResult: string;
  astMethod: string; expectedInterpretation: string;
};

export const emptyAnalyte = (): AnalyteDraft => ({
  analyte: '', unit: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '',
  decimalPlaces: '2', expectedResult: '', astMethod: '', expectedInterpretation: '',
});

export default function DefineControlForm({ sections, staff, equipment, onSaved, onError, heading, lead, defaultSectionId }: {
  sections: Section[]; staff: Staff[]; equipment: EquipmentItem[];
  onSaved: () => void | Promise<void>; onError: (m: string) => void;
  /** Overridden in the portal, where "Define a control" reads oddly on a personal page. */
  heading?: string;
  lead?: string;
  /** The unit to start on — the portal knows which one the person works in. */
  defaultSectionId?: number | null;
}) {
  const { can } = usePermissions();
  const [source, setSource] = useState<IqcSource>('commercial');
  const [controlType, setControlType] = useState<IqcControlType>('quantitative');
  const [form, setForm] = useState({
    materialName: '', testName: '', lotNumber: '', levelLabel: '', manufacturer: '',
    expiryDate: '', openVialExpiry: '', storageCondition: '',
    sectionId: defaultSectionId ? String(defaultSectionId) : '', equipmentId: '',
    qcFrequency: 'each_run', ruleProfile: 'westgard_standard' as IqcRuleProfile,
    preparedByStaffId: '', preparationDate: '', preparationMethod: '', baseMaterial: '',
    validationSummary: '', stabilityPeriod: '', instructions: '', expectedOrganism: '', csScope: 'both',
  });
  const [rows, setRows] = useState<AnalyteDraft[]>([emptyAnalyte()]);
  const [scale, setScale] = useState(QUALITATIVE_SCALES[0].key);
  const [busy, setBusy] = useState(false);
  const isCs = controlType === 'culture_sensitivity';
  const wantsOrganism = isCs && csNeedsOrganism(form.csScope);
  const wantsPanel = isCs && csNeedsPanel(form.csScope);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  // The portal knows which unit the person works in, but it may resolve a beat
  // after this form mounts. Fill it in when it arrives, and never overwrite a
  // choice already made.
  useEffect(() => {
    if (defaultSectionId) setForm(f => (f.sectionId ? f : { ...f, sectionId: String(defaultSectionId) }));
  }, [defaultSectionId]);
  const profiles = PROFILES_FOR_TYPE[controlType];
  useEffect(() => { if (!profiles.includes(form.ruleProfile)) set('ruleProfile', profiles[0]); }, [controlType]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = (key: string) => {
    const t = ANALYTE_TEMPLATES.find(x => x.key === key);
    if (!t) return;
    setControlType(t.controlType);
    if (t.csScope) set('csScope', t.csScope);
    if (t.expectedOrganism) set('expectedOrganism', t.expectedOrganism);
    setRows(t.analytes.length ? t.analytes.map(a => ({
      ...emptyAnalyte(), analyte: a.analyte, unit: a.unit ?? '',
      decimalPlaces: String(a.decimalPlaces ?? 2), astMethod: a.astMethod ?? '',
    })) : [emptyAnalyte()]);
  };

  const setRow = (i: number, k: keyof AnalyteDraft, v: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const analytes = rows.filter(r => r.analyte.trim());
    // An identification-only C&S control legitimately measures no agents.
    if (analytes.length === 0 && !(isCs && !wantsPanel)) {
      return onError(isCs ? 'Add at least one antimicrobial agent to the panel.' : 'Add at least one analyte — what does this control measure?');
    }
    if (controlType === 'qualitative' && analytes.some(a => !a.expectedResult)) {
      return onError('Every qualitative analyte needs the result the control is expected to give.');
    }
    if (isCs) {
      if (wantsOrganism && !form.expectedOrganism.trim()) return onError('Name the reference strain this control is expected to identify (e.g. E. coli ATCC 25922).');
      if (wantsPanel && analytes.some(a => !a.expectedInterpretation)) return onError('Every antimicrobial agent needs the category (S, SDD, I, R or NS) the reference strain is expected to give.');
    }
    // For susceptibility-only, the organism is taken as known and not stored.
    const payloadAnalytes = isCs && !wantsPanel ? [] : analytes;
    setBusy(true);
    try {
      await api('/iqc/materials', { method: 'POST', body: JSON.stringify({ ...form, source, controlType, analytes: payloadAnalytes }) });
      await onSaved();
      setForm(f => ({ ...f, materialName: '', lotNumber: '', levelLabel: '', expectedOrganism: '' }));
      setRows([emptyAnalyte()]);
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  const outcomes = QUALITATIVE_SCALES.find(s => s.key === scale)?.outcomes ?? [];

  return (
    can('iqc', 'create') && <form className="card iqc-define" onSubmit={submit}>
      <div className="section-head">
        <h3>{heading ?? 'Define a control'}</h3>
        {lead && <p className="iqc-panel-lead">{lead}</p>}
      </div>

      {/* 1 — where it came from */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">1</span> Where did this control come from?</legend>
        <div className="iqc-choice">
          {IQC_SOURCES.map(s => (
            <button key={s} type="button" className={source === s ? 'active' : ''} onClick={() => setSource(s)}>
              <strong>{IQC_SOURCE_LABELS[s]}</strong>
              <span>{IQC_SOURCE_HINTS[s]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* 2 — what kind of result it gives */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">2</span> What kind of result does it give?</legend>
        <div className="iqc-choice four">
          {IQC_CONTROL_TYPES.map(t => (
            <button key={t} type="button" className={controlType === t ? 'active' : ''} onClick={() => setControlType(t)}>
              <strong>{IQC_CONTROL_TYPE_LABELS[t]}</strong>
              <span>{IQC_CONTROL_TYPE_HINTS[t]}</span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* 3 — identity */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">3</span> Identify the material</legend>
        <div className="form-grid">
          <label>Control name<TextField value={form.materialName} onValue={nextValue => set('materialName', nextValue)} required placeholder="e.g. Haematology Control Normal" /></label>
          <label>Test<TextField value={form.testName} onValue={nextValue => set('testName', nextValue)} required placeholder="e.g. Full blood count" /></label>
          <label>Lot / batch number<TextField value={form.lotNumber} onValue={nextValue => set('lotNumber', nextValue)} required /></label>
          <label>Level or designation<TextField value={form.levelLabel} onValue={nextValue => set('levelLabel', nextValue)} placeholder="e.g. Level 1 (Normal), Positive control" /></label>
          {source === 'commercial' && <label>Manufacturer<TextField value={form.manufacturer} onValue={nextValue => set('manufacturer', nextValue)} /></label>}
          <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} /></label>
          <label>Open-vial expiry<input type="date" value={form.openVialExpiry} onChange={e => set('openVialExpiry', e.target.value)} /></label>
          <label>Storage condition<TextField value={form.storageCondition} onValue={nextValue => set('storageCondition', nextValue)} placeholder="e.g. 2–8 °C" /></label>
          <label>Section<select value={form.sectionId} onChange={e => set('sectionId', e.target.value)}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Instrument<select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        </div>
      </fieldset>

      {/* 3b — in-house provenance */}
      {source === 'in_house' && (
        <fieldset className="iqc-step accent">
          <legend><span className="step-n">3b</span> How was it prepared?</legend>
          <p className="iqc-note">
            Nobody outside this laboratory can vouch for an in-house control, so its preparation and validation
            are what make it traceable. ISO 15189:2022 §7.3.7.2 expects this to be documented.
          </p>
          <div className="form-grid">
            <label>Prepared by<select value={form.preparedByStaffId} onChange={e => set('preparedByStaffId', e.target.value)}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
            <label>Preparation date<input type="date" value={form.preparationDate} onChange={e => set('preparationDate', e.target.value)} /></label>
            <label>Base material<TextField value={form.baseMaterial} onValue={nextValue => set('baseMaterial', nextValue)} placeholder="e.g. Pooled patient serum" /></label>
            <label>Stability period<TextField value={form.stabilityPeriod} onValue={nextValue => set('stabilityPeriod', nextValue)} placeholder="e.g. 30 days at −20 °C" /></label>
          </div>
          <label className="stack">Preparation method <em>(required)</em>
            <TextField as="textarea" value={form.preparationMethod} onValue={nextValue => set('preparationMethod', nextValue)} rows={3}
              placeholder="How the material was pooled, aliquoted and stored." required />
          </label>
          <label className="stack">Validation summary
            <TextField as="textarea" value={form.validationSummary} onValue={nextValue => set('validationSummary', nextValue)} rows={2}
              placeholder="How the target values were established, and against what." />
          </label>
        </fieldset>
      )}

      {/* 4 — what it measures */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">4</span> {isCs ? 'Organism and susceptibility panel' : 'What does it measure?'}</legend>
        <div className="iqc-template">
          <span className="muted">Start from a template:</span>
          <select value="" onChange={e => e.target.value && applyTemplate(e.target.value)}>
            <option value="">Choose…</option>
            {ANALYTE_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <span className="hint">One vial, many parameters — an FBC control reads eight, a serology control reads one.</span>
        </div>

        {isCs && (
          <>
            <div className="form-grid">
              <label>This control confirms
                <select value={form.csScope} onChange={e => set('csScope', e.target.value)}>
                  {CS_SCOPES.map(s => <option key={s} value={s}>{CS_SCOPE_LABELS[s]}</option>)}
                </select>
              </label>
              {wantsOrganism && <label>Expected organism (reference strain)<TextField value={form.expectedOrganism} onValue={nextValue => set('expectedOrganism', nextValue)} placeholder="e.g. Escherichia coli ATCC 25922" required /></label>}
            </div>
            <p className="iqc-note">
              {CS_SCOPE_HINTS[form.csScope as never]} Report categories only — S, SDD, I, R or NS (CLSI M100) —
              not zone diameters or MIC values.
            </p>
          </>
        )}

        {controlType === 'qualitative' && (
          <label className="iqc-scale">Result scale
            <select value={scale} onChange={e => setScale(e.target.value)}>
              {QUALITATIVE_SCALES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        )}

        {(!isCs || wantsPanel) && <>
        <table className="data-table compact iqc-analyte-table">
          <thead><tr>
            <th>{isCs ? 'Antimicrobial agent' : 'Analyte'}</th>
            {isCs
              ? <><th>Method</th><th>Expected category</th></>
              : controlType === 'qualitative'
                ? <th>Expected result</th>
                : <><th>Unit</th><th>Target mean</th><th>Target SD</th><th>Low</th><th>High</th><th>Dec.</th></>}
            <th></th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><TextField value={r.analyte} onValue={nextValue => setRow(i, 'analyte', nextValue)} placeholder={isCs ? 'e.g. Ciprofloxacin' : 'e.g. Haemoglobin'} /></td>
                {isCs ? (
                  <>
                    <td>
                      <select value={r.astMethod} onChange={e => setRow(i, 'astMethod', e.target.value)}>
                        <option value="">—</option>
                        {AST_METHODS.map(m => <option key={m} value={m}>{AST_METHOD_LABELS[m]}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={r.expectedInterpretation} onChange={e => setRow(i, 'expectedInterpretation', e.target.value)}>
                        <option value="">Select…</option>
                        {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                      </select>
                    </td>
                  </>
                ) : controlType === 'qualitative' ? (
                  <td>
                    <select value={r.expectedResult} onChange={e => setRow(i, 'expectedResult', e.target.value)}>
                      <option value="">Select…</option>
                      {outcomes.map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                    </select>
                  </td>
                ) : (
                  <>
                    <td><TextField value={r.unit} onValue={nextValue => setRow(i, 'unit', nextValue)} style={{ width: 74 }} /></td>
                    <td><input value={r.targetMean} onChange={e => setRow(i, 'targetMean', e.target.value)} type="number" step="any" style={{ width: 92 }} /></td>
                    <td><input value={r.targetSd} onChange={e => setRow(i, 'targetSd', e.target.value)} type="number" step="any" style={{ width: 84 }} /></td>
                    <td><input value={r.acceptableLow} onChange={e => setRow(i, 'acceptableLow', e.target.value)} type="number" step="any" style={{ width: 80 }} /></td>
                    <td><input value={r.acceptableHigh} onChange={e => setRow(i, 'acceptableHigh', e.target.value)} type="number" step="any" style={{ width: 80 }} /></td>
                    <td><input value={r.decimalPlaces} onChange={e => setRow(i, 'decimalPlaces', e.target.value)} type="number" min={0} max={4} style={{ width: 54 }} /></td>
                  </>
                )}
                <td>{rows.length > 1 && <button type="button" className="tiny" onClick={() => setRows(rs => rs.filter((_, x) => x !== i))}><Trash2 size={12} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="secondary" onClick={() => setRows(rs => [...rs, emptyAnalyte()])}><Plus size={13} /> {isCs ? 'Add agent' : 'Add analyte'}</button>
        </>}
        {isCs && !wantsPanel && <p className="hint">Identification-only — this control has no antimicrobial panel. It passes when the reference strain is identified as the expected organism.</p>}
        {controlType === 'quantitative' && (
          <p className="hint">
            Leave the mean and SD blank if you are establishing them from your own runs — the acceptable range still
            applies, and the chart becomes available once the targets are set.
          </p>
        )}
      </fieldset>

      {/* 5 — how it is judged */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">5</span> How is it judged, and how often?</legend>
        <div className="form-grid">
          <label>Rule set
            <select value={form.ruleProfile} onChange={e => set('ruleProfile', e.target.value)} disabled={profiles.length === 1}>
              {profiles.map(p => <option key={p} value={p}>{IQC_RULE_PROFILE_LABELS[p]}</option>)}
            </select>
          </label>
          <label>Run frequency
            <select value={form.qcFrequency} onChange={e => set('qcFrequency', e.target.value)}>
              {IQC_FREQUENCIES.map(f => <option key={f} value={f}>{IQC_FREQUENCY_LABELS[f]}</option>)}
            </select>
          </label>
        </div>
        <p className="iqc-note">{IQC_RULE_PROFILE_HINTS[form.ruleProfile]}</p>
      </fieldset>

      <div className="form-actions">
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Define control'}</button>
      </div>
    </form>
  );
}
