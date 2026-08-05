import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlaskConical, Beaker, CheckCircle2, AlertTriangle, LineChart, Plus, Trash2,
  ClipboardCheck, ShieldCheck, ArrowRight, Info, Pencil,
} from 'lucide-react';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../hooks/useAuth';
import DisabledModule from '../components/DisabledModule';
import PermissionTabs from '../components/PermissionTabs';
import XlsxToolbar from '../components/XlsxToolbar';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { PageHeader, KpiStrip, ModuleAlerts } from '../components/ui';
import LeveyJenningsChart, { type ChartData } from '../components/LeveyJenningsChart';
import {
  IQC_SOURCES, IQC_SOURCE_LABELS, IQC_SOURCE_HINTS,
  IQC_CONTROL_TYPES, IQC_CONTROL_TYPE_LABELS, IQC_CONTROL_TYPE_HINTS,
  IQC_FREQUENCIES, IQC_FREQUENCY_LABELS,
  IQC_RULE_PROFILE_LABELS, IQC_RULE_PROFILE_HINTS, PROFILES_FOR_TYPE,
  QUALITATIVE_SCALES, QUALITATIVE_LABELS, ANALYTE_TEMPLATES,
  RULE_LABELS, RULE_MEANING, isRejection,
  type IqcSource, type IqcControlType, type IqcRuleProfile, type QualitativeOutcome,
} from '../../shared/constants/iqc';
import type { Section, Staff, EquipmentItem } from '../../shared/types/api';

/* ============================================================================
   IQC — internal quality control.

   Structured around what actually happens at the bench, in order:

     Define the control   once per lot: where it came from, what it measures,
                          what "acceptable" means for it
     Run the control      one screen, every analyte at once, rules applied
                          automatically for that control's type
     Review failures      what the rule means and what was done about it
     Chart                Levey-Jennings, for quantitative analytes
     Lot change           the bridge between an old lot and a new one

   The old workspace had nine tabs and asked the bench to know which Westgard
   rules applied to which control. The definition now carries that, so running
   a control is the same three steps whether it is an eight-parameter FBC or a
   single hepatitis B antigen.
   ========================================================================= */

type Material = {
  id: number; material_code: string; material_name: string; test_name: string; lot_number: string;
  manufacturer: string | null; expiry_date: string | null; section_id: number | null; section_name: string | null;
  equipment_id: number | null; equipment_name: string | null; is_active: number;
  source: IqcSource; control_type: IqcControlType; level_label: string | null; unit: string | null;
  qc_frequency: string; rule_profile: IqcRuleProfile;
  prepared_by_name: string | null; preparation_date: string | null; preparation_method: string | null;
  base_material: string | null; validation_summary: string | null; open_vial_expiry: string | null;
  analyte_count: number; run_count: number; last_run_date: string | null;
};

type Analyte = {
  id: number; iqc_material_id: number; analyte: string; unit: string | null;
  target_mean: number | null; target_sd: number | null;
  acceptable_low: number | null; acceptable_high: number | null;
  decimal_places: number; expected_result: string | null; is_active: number; display_order: number;
};

type Run = {
  id: number; run_number: string | null; iqc_material_id: number; run_date: string; run_time: string | null;
  status: string; rule_summary: string | null; patient_results_released: number | null;
  corrective_action: string | null; reviewed_at: string | null; reviewed_by: string | null;
  material_name: string; lot_number: string; test_name: string; control_type: IqcControlType;
  level_label: string | null; equipment_name: string | null; operator_name: string | null;
};

type AnalyteDraft = {
  analyte: string; unit: string; targetMean: string; targetSd: string;
  acceptableLow: string; acceptableHigh: string; decimalPlaces: string; expectedResult: string;
};

const emptyAnalyte = (): AnalyteDraft => ({
  analyte: '', unit: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '',
  decimalPlaces: '2', expectedResult: '',
});

const STATUS_TONE: Record<string, string> = { in_control: 'ok', warning: 'warn', out_of_control: 'bad' };
const STATUS_LABEL: Record<string, string> = { in_control: 'In control', warning: 'Warning', out_of_control: 'Rejected' };

function useLookups() {
  const [sections, setSections] = useState<Section[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  useEffect(() => {
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<EquipmentItem[]>('/equipment').then(setEquipment).catch(() => setEquipment([]));
  }, []);
  return { sections, staff, equipment };
}

export function IqcPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { can } = usePermissions();
  const { user } = useAuth();
  const { sections, staff, equipment } = useLookups();
  const isAdmin = user?.isAdministrator === true;

  const [tab, setTab] = useState(embedded ? 'Controls' : 'Dashboard');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mats, rns] = await Promise.all([
        api<Material[]>('/iqc/materials'),
        api<Run[]>('/iqc/runs'),
      ]);
      setMaterials(mats); setRuns(rns);
      api<Record<string, number>>('/dashboard/iqc-summary').then(setSummary).catch(() => undefined);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { if (embedded || isEnabled('iqc')) void load(); }, [embedded, isEnabled, load]);
  if (!embedded && !isEnabled('iqc')) return <DisabledModule />;

  const tabs = ['Dashboard', 'Controls', 'New Control', 'Run Control', 'Review', 'Levey-Jennings', 'Lot Changes']
    .filter(n => !embedded || n !== 'Dashboard');

  const pendingReview = runs.filter(r => !r.reviewed_at && r.status !== 'in_control');
  const failedRuns = runs.filter(r => r.status === 'out_of_control');

  return (
    <div className="module-page iqc">
      {!embedded && (
        <PageHeader
          eyebrow="Process Management"
          title="Internal Quality Control"
          subtitle="Define a control once, run it the same way every time, and let the rules for its type decide the outcome."
        />
      )}
      <PermissionTabs moduleKey="iqc" tabs={tabs} active={tab} onChange={setTab} />
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}

      {tab === 'Dashboard' && (
        <>
          <ModuleAlerts moduleKey="iqc" />
          <KpiStrip items={[
            { label: 'Active controls', value: materials.filter(m => m.is_active).length, onClick: () => setTab('Controls') },
            { label: 'Runs recorded', value: runs.length, onClick: () => setTab('Review') },
            { label: 'Rejected runs', value: failedRuns.length, tone: 'danger', onClick: () => setTab('Review') },
            { label: 'Awaiting review', value: pendingReview.length, tone: pendingReview.length ? 'warning' : undefined, onClick: () => setTab('Review') },
            { label: 'Results withheld', value: runs.filter(r => r.patient_results_released === 0).length, tone: 'danger', onClick: () => setTab('Review') },
          ]} />
          <ControlReadiness materials={materials} runs={runs} onOpen={() => setTab('Controls')} />
        </>
      )}

      {tab === 'Controls' && (
        <ControlRegister
          materials={materials} onChanged={load}
          onRun={() => setTab('Run Control')}
          onChart={() => setTab('Levey-Jennings')}
          canEdit={can('iqc', 'edit')}
          sections={sections} staff={staff} equipment={equipment}
          isAdmin={isAdmin} onError={setError} onNotice={setNotice}
        />
      )}

      {tab === 'New Control' && (
        can('iqc', 'create')
          ? <>
              <ImportControls onImported={async (n) => {
                await load();
                if (n > 0) setNotice(`${n} control${n === 1 ? '' : 's'} brought in from Excel. Check the register.`);
              }} />
              <DefineControl sections={sections} staff={staff} equipment={equipment}
                onSaved={async () => { await load(); setNotice('Control defined. It is ready to run.'); setTab('Controls'); }}
                onError={setError} />
            </>
          : <p className="muted">You do not have permission to define new controls.</p>
      )}

      {tab === 'Run Control' && (
        can('iqc', 'create')
          ? <RunControl materials={materials.filter(m => m.is_active)} equipment={equipment} staff={staff}
              onRecorded={async (msg) => { await load(); setNotice(msg); }} onError={setError} />
          : <p className="muted">You do not have permission to record control runs.</p>
      )}

      {tab === 'Review' && (
        <RunReview runs={runs} onChanged={load} canApprove={can('iqc', 'approve')}
          isAdmin={isAdmin} equipment={equipment} staff={staff} onError={setError} onNotice={setNotice} />
      )}

      {tab === 'Levey-Jennings' && <ChartTab materials={materials} onError={setError} />}

      {tab === 'Lot Changes' && <LotChanges materials={materials} onError={setError} canCreate={can('iqc', 'create')} />}
    </div>
  );
}

/* -------------------------------------------------------------- readiness */

/** Which controls are defined but not yet usable, and which are overdue. */
function ControlReadiness({ materials, runs, onOpen }: { materials: Material[]; runs: Run[]; onOpen: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const issues = materials.filter(m => m.is_active).map(m => {
    if (m.analyte_count === 0) return { m, issue: 'No analytes defined — cannot be run yet', tone: 'bad' as const };
    if (m.expiry_date && m.expiry_date < today) return { m, issue: `Lot expired ${m.expiry_date}`, tone: 'bad' as const };
    if (m.control_type === 'quantitative' && m.run_count < 20) {
      return { m, issue: `${m.run_count} of 20 runs — target mean and SD not yet established from own data`, tone: 'warn' as const };
    }
    if (!m.last_run_date) return { m, issue: 'Never run', tone: 'warn' as const };
    return null;
  }).filter(Boolean) as { m: Material; issue: string; tone: 'bad' | 'warn' }[];

  if (issues.length === 0) {
    return (
      <div className="card iqc-clear">
        <CheckCircle2 size={18} />
        <span>Every active control is defined, in date and running.</span>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="section-head"><h3>Controls needing attention</h3><button type="button" className="pq-link" onClick={onOpen}>Open register <ArrowRight size={13} /></button></div>
      <ul className="iqc-issues">
        {issues.map(({ m, issue, tone }) => (
          <li key={m.id}>
            <span className={`iqc-rail ${tone}`} />
            <div>
              <strong>{m.material_name}</strong>
              <span className="muted"> · {m.test_name} · lot {m.lot_number}</span>
              <p>{issue}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- register */

function ControlRegister({ materials, onChanged, onRun, onChart, canEdit, sections, staff, equipment, isAdmin, onError, onNotice }: {
  materials: Material[]; onChanged: () => void; onRun: () => void; onChart: () => void; canEdit: boolean;
  sections: Section[]; staff: Staff[]; equipment: EquipmentItem[]; isAdmin: boolean;
  onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [analytes, setAnalytes] = useState<Record<number, Analyte[]>>({});

  const expand = async (m: Material) => {
    setOpen(open === m.id ? null : m.id);
    if (!analytes[m.id]) {
      try { setAnalytes(a => ({ ...a, [m.id]: [] })); const rows = await api<Analyte[]>(`/iqc/materials/${m.id}/analytes`); setAnalytes(a => ({ ...a, [m.id]: rows })); }
      catch { /* leave empty */ }
    }
  };

  // The register export takes a period, which for a register means the window in
  // which the lots were brought into use.
  const toolbar = <XlsxToolbar
    module="iqc" exportPath="/iqc/controls/export" exportName="IQC_Controls.xlsx"
    exportOnly dateRange dateLabel="Registered" />;

  if (materials.length === 0) {
    return <div className="card">
      {toolbar}
      <div className="empty-state">
        <span className="es-ico"><Beaker size={26} /></span>
        <h3>No controls defined yet</h3>
        <p>Define a control material — commercial or in-house — and say what it measures. Once defined it can be run.</p>
      </div>
    </div>;
  }

  return (
    <div className="card">
      <div className="section-head">
        <h3>Control materials</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="secondary" onClick={onRun}>Run a control</button>
          <button type="button" className="secondary" onClick={onChart}>Charts</button>
        </div>
      </div>
      {toolbar}
      <table className="data-table iqc-table">
        <thead><tr>
          <th>Control</th><th>Test</th><th>Type</th><th>Source</th><th>Lot</th>
          <th>Expiry</th><th>Measures</th><th>Last run</th><th></th>
        </tr></thead>
        <tbody>
          {materials.map(m => (
            <>
              <tr key={m.id} className={m.is_active ? '' : 'muted-row'}>
                <td>
                  <strong>{m.material_name}</strong>
                  {m.level_label && <div className="cell-sub">{m.level_label}</div>}
                </td>
                <td>{m.test_name}</td>
                <td><span className={`chip type-${m.control_type}`}>{IQC_CONTROL_TYPE_LABELS[m.control_type]}</span></td>
                <td><span className={`chip src-${m.source}`}>{m.source === 'in_house' ? 'In-house' : 'Commercial'}</span></td>
                <td>{m.lot_number}</td>
                <td>{m.expiry_date || '—'}</td>
                <td>{m.analyte_count === 0 ? <span className="chip bad">none</span> : `${m.analyte_count} analyte${m.analyte_count === 1 ? '' : 's'}`}</td>
                <td>{m.last_run_date || <span className="muted">never</span>}</td>
                <td><button type="button" className="tiny" onClick={() => expand(m)}>{open === m.id ? 'Close' : 'Details'}</button></td>
              </tr>
              {open === m.id && (
                <tr key={`${m.id}-d`}><td colSpan={9}>
                  <ControlDetail material={m} analytes={analytes[m.id] ?? []} canEdit={canEdit}
                    onChanged={async () => { setAnalytes(a => { const n = { ...a }; delete n[m.id]; return n; }); onChanged(); }}
                    sections={sections} staff={staff} equipment={equipment} isAdmin={isAdmin}
                    onError={onError} onNotice={onNotice} />
                </td></tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ControlDetail({ material, analytes, canEdit, onChanged, sections, staff, equipment, isAdmin, onError, onNotice }: {
  material: Material; analytes: Analyte[]; canEdit: boolean; onChanged: () => void;
  sections: Section[]; staff: Staff[]; equipment: EquipmentItem[]; isAdmin: boolean;
  onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <EditControl
      material={material} analytes={analytes} sections={sections} staff={staff} equipment={equipment}
      onCancel={() => setEditing(false)}
      onSaved={async (msg) => { setEditing(false); await onChanged(); onNotice(msg); }}
      onError={onError} />;
  }

  return (
    <div className="iqc-detail">
      <div className="iqc-detail-facts">
        <div><dt>Rule set</dt><dd>{IQC_RULE_PROFILE_LABELS[material.rule_profile]}</dd></div>
        <div><dt>Frequency</dt><dd>{IQC_FREQUENCY_LABELS[material.qc_frequency as never] ?? material.qc_frequency}</dd></div>
        {material.equipment_name && <div><dt>Instrument</dt><dd>{material.equipment_name}</dd></div>}
        {material.section_name && <div><dt>Section</dt><dd>{material.section_name}</dd></div>}
        {material.source === 'commercial' && material.manufacturer && <div><dt>Manufacturer</dt><dd>{material.manufacturer}</dd></div>}
        {material.open_vial_expiry && <div><dt>Open-vial expiry</dt><dd>{material.open_vial_expiry}</dd></div>}
      </div>

      {material.source === 'in_house' && (
        <div className="iqc-inhouse">
          <strong><Info size={13} /> In-house preparation</strong>
          <dl>
            {material.prepared_by_name && <div><dt>Prepared by</dt><dd>{material.prepared_by_name}</dd></div>}
            {material.preparation_date && <div><dt>Prepared on</dt><dd>{material.preparation_date}</dd></div>}
            {material.base_material && <div><dt>Base material</dt><dd>{material.base_material}</dd></div>}
          </dl>
          {material.preparation_method && <p><em>Method:</em> {material.preparation_method}</p>}
          {material.validation_summary && <p><em>Validation:</em> {material.validation_summary}</p>}
        </div>
      )}

      <table className="data-table compact">
        <thead><tr>
          <th>Analyte</th><th>Unit</th>
          {material.control_type === 'qualitative'
            ? <th>Expected result</th>
            : <><th>Target mean</th><th>Target SD</th><th>Acceptable range</th></>}
        </tr></thead>
        <tbody>
          {analytes.filter(a => a.is_active).map(a => (
            <tr key={a.id}>
              <td>{a.analyte}</td>
              <td>{a.unit || '—'}</td>
              {material.control_type === 'qualitative' ? (
                <td>{a.expected_result ? QUALITATIVE_LABELS[a.expected_result as QualitativeOutcome] ?? a.expected_result : <span className="chip bad">not set</span>}</td>
              ) : (
                <>
                  <td>{a.target_mean ?? '—'}</td>
                  <td>{a.target_sd ?? '—'}</td>
                  <td>{a.acceptable_low ?? '—'} – {a.acceptable_high ?? '—'}</td>
                </>
              )}
            </tr>
          ))}
          {analytes.length === 0 && <tr><td colSpan={6} className="muted">No analytes defined. This control cannot be run until it measures something.</td></tr>}
        </tbody>
      </table>

      {canEdit
        ? <ControlActions material={material} isAdmin={isAdmin} onEdit={() => setEditing(true)}
            onChanged={onChanged} onError={onError} onNotice={onNotice} />
        : <p className="hint">You can view this definition but not change it.</p>}
    </div>
  );
}

/**
 * What can be done to a control lot, and what each choice costs.
 *
 * Retiring is the ordinary answer and is always offered: the lot stops being
 * available to run and everything it produced stays on the record. Erasing is
 * an administrator's, needs a reason, and is only shown once the impact of it
 * has been fetched and read.
 */
function ControlActions({ material, isAdmin, onEdit, onChanged, onError, onNotice }: {
  material: Material; isAdmin: boolean; onEdit: () => void;
  onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  const [impact, setImpact] = useState<Record<string, any> | null>(null);
  const [confirming, setConfirming] = useState<'retire' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const openRemoval = async () => {
    setConfirming('retire'); setReason(''); setImpact(null);
    try { setImpact(await api(`/iqc/materials/${material.id}/deletion-impact`)); }
    catch (e) { onError((e as Error).message); }
  };

  async function remove(mode: 'retire' | 'delete', force = false) {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/iqc/materials/${material.id}?mode=${mode}${force ? '&force=1' : ''}`,
        { method: 'DELETE', body: JSON.stringify({ reason }) });
      setConfirming(null); await onChanged(); onNotice(r.message);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function reactivate() {
    setBusy(true);
    try {
      const r = await api<{ warning: string | null }>(`/iqc/materials/${material.id}/reactivate`, { method: 'POST', body: '{}' });
      await onChanged();
      onNotice(r.warning ?? `${material.material_name} lot ${material.lot_number} is back in use.`);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (confirming) {
    const hasHistory = (impact?.runs ?? 0) > 0;
    return (
      <div className="iqc-danger">
        <strong><AlertTriangle size={14} /> Remove {material.material_name} lot {material.lot_number}</strong>
        {impact === null ? <p className="muted">Checking what is attached to this lot…</p> : (
          <p>
            This lot carries <strong>{impact.runs}</strong> run(s) and <strong>{impact.results}</strong> reading(s)
            {impact.firstRun ? <> recorded between {impact.firstRun} and {impact.lastRun}</> : null}
            {impact.linkedToInvestigations > 0 && <>, <strong>{impact.linkedToInvestigations}</strong> of them cited by an investigation</>}.
          </p>
        )}
        <label className="stack">Reason
          <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Lot registered twice in error — this duplicate was never run." />
        </label>
        <div className="iqc-danger-acts">
          <button type="button" disabled={busy} onClick={() => remove('retire')}>
            Retire this lot{hasHistory ? ' (keeps its records)' : ''}
          </button>
          {isAdmin && impact && (
            impact.canDeleteOutright
              ? <button type="button" className="danger" disabled={busy || reason.trim().length < 10} onClick={() => remove('delete')}>
                  Erase it entirely
                </button>
              : <button type="button" className="danger" disabled={busy || reason.trim().length < 10}
                  onClick={() => { if (confirm(`Erasing destroys ${impact.runs} run(s) of quality record. The audit trail keeps what was there. Continue?`)) void remove('delete', true); }}>
                  Erase it and its {impact.runs} run(s)
                </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
        {isAdmin && reason.trim().length < 10 && <p className="hint">Erasing needs a reason of at least a sentence.</p>}
        {!isAdmin && <p className="hint">Only an administrator can erase a control outright.</p>}
      </div>
    );
  }

  return (
    <div className="iqc-detail-acts">
      <button type="button" className="secondary" onClick={onEdit}>
        <Pencil size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Edit parameters
      </button>
      {material.is_active
        ? <button type="button" className="secondary" onClick={openRemoval}>
            <Trash2 size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />Retire or remove
          </button>
        : <>
            <span className="chip warn">Retired</span>
            <button type="button" className="secondary" disabled={busy} onClick={reactivate}>Put back in use</button>
          </>}
    </div>
  );
}

/**
 * Correcting a control's parameters.
 *
 * The same fields the control was defined with, filled in from what is stored.
 * Two things are treated as more than ordinary edits: a lot that has already
 * been run cannot change what kind of control it is, and moving a target mean
 * or SD on such a lot re-scales every z-score already recorded — so the form
 * asks for a reason before it will send that, and says how many runs it
 * touches.
 */
function EditControl({ material, analytes, sections, staff, equipment, onSaved, onCancel, onError }: {
  material: Material; analytes: Analyte[];
  sections: Section[]; staff: Staff[]; equipment: EquipmentItem[];
  onSaved: (message: string) => void | Promise<void>; onCancel: () => void; onError: (m: string) => void;
}) {
  const qualitative = material.control_type === 'qualitative';
  const [form, setForm] = useState({
    materialName: material.material_name, testName: material.test_name, lotNumber: material.lot_number,
    levelLabel: material.level_label ?? '', manufacturer: material.manufacturer ?? '',
    expiryDate: material.expiry_date ?? '', openVialExpiry: material.open_vial_expiry ?? '',
    storageCondition: (material as Record<string, any>).storage_condition ?? '',
    sectionId: material.section_id ? String(material.section_id) : '',
    equipmentId: material.equipment_id ? String(material.equipment_id) : '',
    qcFrequency: material.qc_frequency, ruleProfile: material.rule_profile as IqcRuleProfile,
    preparedByStaffId: '', preparationDate: material.preparation_date ?? '',
    preparationMethod: material.preparation_method ?? '', baseMaterial: material.base_material ?? '',
    validationSummary: material.validation_summary ?? '',
  });
  const [rows, setRows] = useState(() => analytes.filter(a => a.is_active).map(a => ({
    analyte: a.analyte, unit: a.unit ?? '',
    targetMean: a.target_mean === null ? '' : String(a.target_mean),
    targetSd: a.target_sd === null ? '' : String(a.target_sd),
    acceptableLow: a.acceptable_low === null ? '' : String(a.acceptable_low),
    acceptableHigh: a.acceptable_high === null ? '' : String(a.acceptable_high),
    decimalPlaces: String(a.decimal_places ?? 2), expectedResult: a.expected_result ?? '',
  })));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const setRow = (i: number, k: string, v: string) => setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  // Which targets the operator has actually moved, and therefore whether a
  // reason is needed. Worked out here so the requirement appears as they type
  // rather than as a refusal when they press save.
  const original = new Map(analytes.map(a => [a.analyte.toLowerCase(), a]));
  const movedTargets = rows.filter(r => {
    const a = original.get(r.analyte.trim().toLowerCase());
    if (!a) return false;
    const asNum = (v: string) => (v.trim() === '' ? null : Number(v));
    return asNum(r.targetMean) !== a.target_mean || asNum(r.targetSd) !== a.target_sd;
  }).map(r => r.analyte);
  const needsReason = movedTargets.length > 0 && material.run_count > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const kept = rows.filter(r => r.analyte.trim());
    if (kept.length === 0) return onError('A control has to measure something — keep at least one analyte.');
    if (qualitative && kept.some(r => !r.expectedResult)) {
      return onError('Every qualitative analyte needs the result the control is expected to give.');
    }
    setBusy(true);
    try {
      const r = await api<{ targetsMoved: string[]; affectedRuns: number; analyteChanges: Record<string, number> }>(
        `/iqc/materials/${material.id}`,
        { method: 'PUT', body: JSON.stringify({ ...form, analytes: kept, reason }) });
      const notes = [
        r.analyteChanges?.added ? `${r.analyteChanges.added} analyte(s) added` : null,
        r.analyteChanges?.retired ? `${r.analyteChanges.retired} retired` : null,
        r.affectedRuns ? `${r.affectedRuns} recorded run(s) now read against the new target` : null,
      ].filter(Boolean);
      await onSaved(`${material.material_name} lot ${form.lotNumber} updated${notes.length ? ` — ${notes.join(', ')}` : ''}.`);
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <form className="iqc-detail iqc-edit" onSubmit={submit}>
      <div className="section-head">
        <h4><Pencil size={14} /> Edit {material.material_name} · lot {material.lot_number}</h4>
        <span className="chip">{IQC_CONTROL_TYPE_LABELS[material.control_type]}</span>
      </div>

      {material.run_count > 0 && (
        <p className="iqc-note">
          This lot has <strong>{material.run_count}</strong> recorded run(s). Its source and control type are fixed now —
          to change those, retire it and register the corrected control as a new lot.
        </p>
      )}

      <div className="form-grid">
        <label>Control name<input value={form.materialName} onChange={e => set('materialName', e.target.value)} required /></label>
        <label>Test<input value={form.testName} onChange={e => set('testName', e.target.value)} required /></label>
        <label>Lot / batch number<input value={form.lotNumber} onChange={e => set('lotNumber', e.target.value)} required /></label>
        <label>Level or designation<input value={form.levelLabel} onChange={e => set('levelLabel', e.target.value)} /></label>
        {material.source === 'commercial' && <label>Manufacturer<input value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></label>}
        <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} /></label>
        <label>Open-vial expiry<input type="date" value={form.openVialExpiry} onChange={e => set('openVialExpiry', e.target.value)} /></label>
        <label>Storage condition<input value={form.storageCondition} onChange={e => set('storageCondition', e.target.value)} placeholder="e.g. 2–8 °C" /></label>
        <label>Section<select value={form.sectionId} onChange={e => set('sectionId', e.target.value)}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Instrument<select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Run frequency<select value={form.qcFrequency} onChange={e => set('qcFrequency', e.target.value)}>{IQC_FREQUENCIES.map(f => <option key={f} value={f}>{IQC_FREQUENCY_LABELS[f]}</option>)}</select></label>
        <label>Rule set<select value={form.ruleProfile} onChange={e => set('ruleProfile', e.target.value)}>
          {PROFILES_FOR_TYPE[material.control_type].map(p => <option key={p} value={p}>{IQC_RULE_PROFILE_LABELS[p]}</option>)}
        </select></label>
      </div>

      {material.source === 'in_house' && (
        <fieldset className="iqc-step accent">
          <legend>In-house preparation</legend>
          <div className="form-grid">
            <label>Prepared by<select value={form.preparedByStaffId} onChange={e => set('preparedByStaffId', e.target.value)}>
              <option value="">{material.prepared_by_name ?? '—'}</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select></label>
            <label>Preparation date<input type="date" value={form.preparationDate} onChange={e => set('preparationDate', e.target.value)} /></label>
            <label>Base material<input value={form.baseMaterial} onChange={e => set('baseMaterial', e.target.value)} /></label>
          </div>
          <label className="stack">How it was prepared<textarea rows={2} value={form.preparationMethod} onChange={e => set('preparationMethod', e.target.value)} required /></label>
          <label className="stack">How its target was assigned<textarea rows={2} value={form.validationSummary} onChange={e => set('validationSummary', e.target.value)} /></label>
        </fieldset>
      )}

      <table className="data-table compact iqc-entry">
        <thead><tr>
          <th>Analyte</th><th>Unit</th>
          {qualitative ? <th>Expected result</th> : <><th>Target mean</th><th>Target SD</th><th>Acceptable low</th><th>Acceptable high</th><th>Decimals</th></>}
          <th />
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input value={r.analyte} onChange={e => setRow(i, 'analyte', e.target.value)} required /></td>
              <td><input value={r.unit} onChange={e => setRow(i, 'unit', e.target.value)} style={{ width: 80 }} /></td>
              {qualitative ? (
                <td><select value={r.expectedResult} onChange={e => setRow(i, 'expectedResult', e.target.value)} required>
                  <option value="">—</option>
                  {QUALITATIVE_SCALES.flatMap(s => s.outcomes).filter((o, idx, all) => all.indexOf(o) === idx)
                    .map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                </select></td>
              ) : (
                <>
                  <td><input type="number" step="any" value={r.targetMean} onChange={e => setRow(i, 'targetMean', e.target.value)} style={{ width: 96 }} /></td>
                  <td><input type="number" step="any" value={r.targetSd} onChange={e => setRow(i, 'targetSd', e.target.value)} style={{ width: 96 }} /></td>
                  <td><input type="number" step="any" value={r.acceptableLow} onChange={e => setRow(i, 'acceptableLow', e.target.value)} style={{ width: 96 }} /></td>
                  <td><input type="number" step="any" value={r.acceptableHigh} onChange={e => setRow(i, 'acceptableHigh', e.target.value)} style={{ width: 96 }} /></td>
                  <td><input type="number" min="0" max="4" value={r.decimalPlaces} onChange={e => setRow(i, 'decimalPlaces', e.target.value)} style={{ width: 64 }} /></td>
                </>
              )}
              <td>
                <button type="button" className="tiny" title="Stop measuring this analyte"
                  onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}><Trash2 size={12} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className="secondary tiny" onClick={() => setRows(rs => [...rs, { analyte: '', unit: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '', decimalPlaces: '2', expectedResult: '' }])}>
        <Plus size={12} /> Add an analyte
      </button>
      <p className="hint">
        An analyte removed here stops being measured. If it already has readings it is retired rather than deleted, so its
        chart and history survive.
      </p>

      {needsReason && (
        <div className="iqc-note warn">
          <strong>{movedTargets.join(', ')}</strong>: you are moving the target on a lot with {material.run_count} recorded
          run(s). Every z-score already on file was measured against the old target, so say why.
          <label className="stack" style={{ marginTop: 8 }}>Reason
            <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Manufacturer reissued the value sheet for this lot on 2026-07-30." />
          </label>
        </div>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy || (needsReason && reason.trim().length < 10)}>{busy ? 'Saving…' : 'Save changes'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ define control */

/**
 * Bringing controls in from Excel. One sheet carries one control or the whole
 * register — control-level columns simply repeat down the rows of each of its
 * analytes — so a laboratory setting the system up does not have to type forty
 * lots in by hand. A lot that already exists is updated rather than duplicated.
 */
function ImportControls({ onImported }: { onImported: (created: number) => void | Promise<void> }) {
  return (
    <div className="card iqc-import">
      <div className="section-head">
        <h3>Already have your controls in a spreadsheet?</h3>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Download the template, fill in one row per analyte (repeat the control's own columns down its
        rows), and import it. A single control or a whole register works the same way. Anything that
        cannot be accepted is reported by row number, and nothing in that row is written.
      </p>
      <XlsxToolbar
        module="iqc" importOnly exportName="IQC_Controls.xlsx"
        templatePath="/iqc/controls/template" importPath="/iqc/controls/import"
        onImported={r => void onImported((r.created ?? 0) + (r.updated ?? 0))}
      />
    </div>
  );
}

function DefineControl({ sections, staff, equipment, onSaved, onError }: {
  sections: Section[]; staff: Staff[]; equipment: EquipmentItem[];
  onSaved: () => void | Promise<void>; onError: (m: string) => void;
}) {
  const [source, setSource] = useState<IqcSource>('commercial');
  const [controlType, setControlType] = useState<IqcControlType>('quantitative');
  const [form, setForm] = useState({
    materialName: '', testName: '', lotNumber: '', levelLabel: '', manufacturer: '',
    expiryDate: '', openVialExpiry: '', storageCondition: '', sectionId: '', equipmentId: '',
    qcFrequency: 'each_run', ruleProfile: 'westgard_standard' as IqcRuleProfile,
    preparedByStaffId: '', preparationDate: '', preparationMethod: '', baseMaterial: '',
    validationSummary: '', stabilityPeriod: '', instructions: '',
  });
  const [rows, setRows] = useState<AnalyteDraft[]>([emptyAnalyte()]);
  const [scale, setScale] = useState(QUALITATIVE_SCALES[0].key);
  const [busy, setBusy] = useState(false);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const profiles = PROFILES_FOR_TYPE[controlType];
  useEffect(() => { if (!profiles.includes(form.ruleProfile)) set('ruleProfile', profiles[0]); }, [controlType]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = (key: string) => {
    const t = ANALYTE_TEMPLATES.find(x => x.key === key);
    if (!t) return;
    setControlType(t.controlType);
    setRows(t.analytes.map(a => ({ ...emptyAnalyte(), analyte: a.analyte, unit: a.unit ?? '', decimalPlaces: String(a.decimalPlaces ?? 2) })));
  };

  const setRow = (i: number, k: keyof AnalyteDraft, v: string) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const analytes = rows.filter(r => r.analyte.trim());
    if (analytes.length === 0) return onError('Add at least one analyte — what does this control measure?');
    if (controlType === 'qualitative' && analytes.some(a => !a.expectedResult)) {
      return onError('Every qualitative analyte needs the result the control is expected to give.');
    }
    setBusy(true);
    try {
      await api('/iqc/materials', { method: 'POST', body: JSON.stringify({ ...form, source, controlType, analytes }) });
      await onSaved();
      setForm(f => ({ ...f, materialName: '', lotNumber: '', levelLabel: '' }));
      setRows([emptyAnalyte()]);
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }

  const outcomes = QUALITATIVE_SCALES.find(s => s.key === scale)?.outcomes ?? [];

  return (
    <form className="card iqc-define" onSubmit={submit}>
      <div className="section-head"><h3>Define a control</h3></div>

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
        <div className="iqc-choice three">
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
          <label>Control name<input value={form.materialName} onChange={e => set('materialName', e.target.value)} required placeholder="e.g. Haematology Control Normal" /></label>
          <label>Test<input value={form.testName} onChange={e => set('testName', e.target.value)} required placeholder="e.g. Full blood count" /></label>
          <label>Lot / batch number<input value={form.lotNumber} onChange={e => set('lotNumber', e.target.value)} required /></label>
          <label>Level or designation<input value={form.levelLabel} onChange={e => set('levelLabel', e.target.value)} placeholder="e.g. Level 1 (Normal), Positive control" /></label>
          {source === 'commercial' && <label>Manufacturer<input value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} /></label>}
          <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} /></label>
          <label>Open-vial expiry<input type="date" value={form.openVialExpiry} onChange={e => set('openVialExpiry', e.target.value)} /></label>
          <label>Storage condition<input value={form.storageCondition} onChange={e => set('storageCondition', e.target.value)} placeholder="e.g. 2–8 °C" /></label>
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
            <label>Base material<input value={form.baseMaterial} onChange={e => set('baseMaterial', e.target.value)} placeholder="e.g. Pooled patient serum" /></label>
            <label>Stability period<input value={form.stabilityPeriod} onChange={e => set('stabilityPeriod', e.target.value)} placeholder="e.g. 30 days at −20 °C" /></label>
          </div>
          <label className="stack">Preparation method <em>(required)</em>
            <textarea value={form.preparationMethod} onChange={e => set('preparationMethod', e.target.value)} rows={3}
              placeholder="How the material was pooled, aliquoted and stored." required />
          </label>
          <label className="stack">Validation summary
            <textarea value={form.validationSummary} onChange={e => set('validationSummary', e.target.value)} rows={2}
              placeholder="How the target values were established, and against what." />
          </label>
        </fieldset>
      )}

      {/* 4 — what it measures */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">4</span> What does it measure?</legend>
        <div className="iqc-template">
          <span className="muted">Start from a template:</span>
          <select value="" onChange={e => e.target.value && applyTemplate(e.target.value)}>
            <option value="">Choose…</option>
            {ANALYTE_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <span className="hint">One vial, many parameters — an FBC control reads eight, a serology control reads one.</span>
        </div>

        {controlType === 'qualitative' && (
          <label className="iqc-scale">Result scale
            <select value={scale} onChange={e => setScale(e.target.value)}>
              {QUALITATIVE_SCALES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        )}

        <table className="data-table compact iqc-analyte-table">
          <thead><tr>
            <th>Analyte</th>
            {controlType === 'qualitative'
              ? <th>Expected result</th>
              : <><th>Unit</th><th>Target mean</th><th>Target SD</th><th>Low</th><th>High</th><th>Dec.</th></>}
            <th></th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input value={r.analyte} onChange={e => setRow(i, 'analyte', e.target.value)} placeholder="e.g. Haemoglobin" /></td>
                {controlType === 'qualitative' ? (
                  <td>
                    <select value={r.expectedResult} onChange={e => setRow(i, 'expectedResult', e.target.value)}>
                      <option value="">Select…</option>
                      {outcomes.map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                    </select>
                  </td>
                ) : (
                  <>
                    <td><input value={r.unit} onChange={e => setRow(i, 'unit', e.target.value)} style={{ width: 74 }} /></td>
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
        <button type="button" className="secondary" onClick={() => setRows(rs => [...rs, emptyAnalyte()])}><Plus size={13} /> Add analyte</button>
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

/* --------------------------------------------------------------- run control */

function RunControl({ materials, equipment, staff, onRecorded, onError }: {
  materials: Material[]; equipment: EquipmentItem[]; staff: Staff[];
  onRecorded: (msg: string) => void | Promise<void>; onError: (m: string) => void;
}) {
  const [materialId, setMaterialId] = useState('');
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [meta, setMeta] = useState({ runDate: new Date().toISOString().slice(0, 10), runTime: '', shift: '', equipmentId: '', reagentLot: '', operatorStaffId: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ status: string; ruleSummary: string | null; analytes: { analyte: string; status: string; rule: string | null; zScore: number | null }[]; mayReleasePatientResults: boolean } | null>(null);

  const material = materials.find(m => String(m.id) === materialId);

  useEffect(() => {
    setOutcome(null); setValues({});
    if (!materialId) { setAnalytes([]); return; }
    api<Analyte[]>(`/iqc/materials/${materialId}/analytes`)
      .then(rows => setAnalytes(rows.filter(a => a.is_active)))
      .catch(() => setAnalytes([]));
  }, [materialId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!material) return onError('Choose which control you are running.');
    const readings = analytes
      .map(a => {
        const raw = values[a.id];
        if (raw === undefined || raw === '') return null;
        return material.control_type === 'qualitative'
          ? { analyteId: a.id, qualitativeResult: raw }
          : { analyteId: a.id, value: Number(raw) };
      })
      .filter(Boolean);
    if (readings.length === 0) return onError('Enter at least one reading.');

    setBusy(true);
    try {
      const r = await api<typeof outcome & { runNumber: string }>('/iqc/runs', {
        method: 'POST', body: JSON.stringify({ iqcMaterialId: Number(materialId), ...meta, readings }),
      });
      setOutcome(r);
      setValues({});
      await onRecorded(
        r!.status === 'out_of_control'
          ? `Run ${r!.runNumber} recorded and REJECTED. Patient results are withheld until this is investigated.`
          : `Run ${r!.runNumber} recorded — ${r!.status === 'warning' ? 'warning flagged' : 'in control'}.`);
    } catch (err) { onError((err as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
    {/* Analysers that already write QC to a spreadsheet, and benches catching up
        on a backlog, come in here. The file is put through exactly the same
        evaluation as a run typed below, so an imported failure is flagged and
        withholds patient results in the same way. */}
    <div className="card iqc-import">
      <div className="section-head"><h3>Import runs from Excel</h3></div>
      <p className="muted" style={{ marginTop: 0 }}>
        One row per reading. Rows sharing a lot, date, time and instrument are treated as one run and
        evaluated together — which is what the multirules need.
        {material
          ? <> The template below is pre-filled for <strong>{material.material_name}</strong> (lot {material.lot_number}).</>
          : <> Choose a control below first and the template comes pre-filled with its analytes.</>}
      </p>
      <XlsxToolbar
        module="iqc" importOnly exportName="IQC_Runs.xlsx"
        templatePath={`/iqc/runs/template${materialId ? `?materialId=${materialId}` : ''}`}
        importPath="/iqc/runs/import"
        onImported={r => {
          const n = r.created ?? 0;
          if (n === 0) return;
          void onRecorded(r.rejected
            ? `${n} run(s) imported — ${r.rejected} rejected. Patient results for those runs are withheld.`
            : `${n} run(s) imported from Excel.`);
        }}
      />
    </div>

    <form className="card iqc-run" onSubmit={submit}>
      <div className="section-head"><h3><ClipboardCheck size={16} /> Record a control run</h3></div>

      <div className="form-grid">
        <label>Control
          <select value={materialId} onChange={e => setMaterialId(e.target.value)} required>
            <option value="">Choose a control…</option>
            {materials.map(m => (
              <option key={m.id} value={m.id}>
                {m.material_name}{m.level_label ? ` — ${m.level_label}` : ''} · {m.test_name} · lot {m.lot_number}
              </option>
            ))}
          </select>
        </label>
        <label>Run date<input type="date" value={meta.runDate} onChange={e => setMeta(m => ({ ...m, runDate: e.target.value }))} required /></label>
        <label>Time<input type="time" value={meta.runTime} onChange={e => setMeta(m => ({ ...m, runTime: e.target.value }))} /></label>
        <label>Shift<select value={meta.shift} onChange={e => setMeta(m => ({ ...m, shift: e.target.value }))}><option value="">—</option><option>Morning</option><option>Afternoon</option><option>Night</option></select></label>
        <label>Instrument<select value={meta.equipmentId} onChange={e => setMeta(m => ({ ...m, equipmentId: e.target.value }))}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Reagent lot<input value={meta.reagentLot} onChange={e => setMeta(m => ({ ...m, reagentLot: e.target.value }))} /></label>
        <label>Operator<select value={meta.operatorStaffId} onChange={e => setMeta(m => ({ ...m, operatorStaffId: e.target.value }))}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      </div>

      {material && (
        <div className="iqc-run-ctx">
          <span className={`chip type-${material.control_type}`}>{IQC_CONTROL_TYPE_LABELS[material.control_type]}</span>
          <span className={`chip src-${material.source}`}>{material.source === 'in_house' ? 'In-house' : 'Commercial'}</span>
          <span className="chip">{IQC_RULE_PROFILE_LABELS[material.rule_profile]}</span>
          <span className="chip">{IQC_FREQUENCY_LABELS[material.qc_frequency as never] ?? material.qc_frequency}</span>
        </div>
      )}

      {material && analytes.length > 0 && (
        <table className="data-table compact iqc-entry">
          <thead><tr>
            <th>Analyte</th>
            {material.control_type === 'qualitative' ? <><th>Expected</th><th>Observed</th></> : <><th>Target</th><th>Acceptable</th><th>Result</th></>}
          </tr></thead>
          <tbody>
            {analytes.map(a => (
              <tr key={a.id}>
                <td><strong>{a.analyte}</strong>{a.unit ? <span className="muted"> ({a.unit})</span> : null}</td>
                {material.control_type === 'qualitative' ? (
                  <>
                    <td>{a.expected_result ? QUALITATIVE_LABELS[a.expected_result as QualitativeOutcome] : '—'}</td>
                    <td>
                      <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                        <option value="">—</option>
                        {(QUALITATIVE_SCALES.find(s => s.outcomes.includes(a.expected_result as QualitativeOutcome))?.outcomes ?? QUALITATIVE_SCALES[0].outcomes)
                          .map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                      </select>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="muted">{a.target_mean ?? '—'}{a.target_sd ? ` ± ${a.target_sd}` : ''}</td>
                    <td className="muted">{a.acceptable_low ?? '—'} – {a.acceptable_high ?? '—'}</td>
                    <td><input type="number" step="any" value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))} style={{ width: 120 }} /></td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {material && analytes.length === 0 && (
        <p className="iqc-note bad">This control has no analytes defined, so it cannot be run. Edit its definition first.</p>
      )}

      <label className="stack">Comment<textarea value={meta.comment} onChange={e => setMeta(m => ({ ...m, comment: e.target.value }))} rows={2} /></label>

      <div className="form-actions">
        <button type="submit" disabled={busy || !material || analytes.length === 0}>{busy ? 'Evaluating…' : 'Record run'}</button>
      </div>

      {outcome && (
        <div className={`iqc-outcome ${STATUS_TONE[outcome.status]}`}>
          <strong>
            {outcome.status === 'out_of_control' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            {STATUS_LABEL[outcome.status]}
          </strong>
          {outcome.ruleSummary && <p>{outcome.ruleSummary}</p>}
          {!outcome.mayReleasePatientResults && (
            <p className="iqc-hold"><ShieldCheck size={13} /> Patient results are withheld for this run until it has been investigated and reviewed.</p>
          )}
          <ul>
            {outcome.analytes.filter(a => a.rule && a.rule !== 'within_control').map(a => (
              <li key={a.analyte}>
                <strong>{a.analyte}</strong> — {RULE_LABELS[a.rule!] ?? a.rule}
                {a.zScore !== null && <span className="muted"> (z = {a.zScore.toFixed(2)})</span>}
                <div className="muted">{RULE_MEANING[a.rule!]}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
    </>
  );
}

/* ------------------------------------------------------------------- review */

function RunReview({ runs, onChanged, canApprove, isAdmin, equipment, staff, onError, onNotice }: {
  runs: Run[]; onChanged: () => void; canApprove: boolean; isAdmin: boolean;
  equipment: EquipmentItem[]; staff: Staff[];
  onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  // Correcting or removing a run is an administrator override, so the controls
  // for it are not drawn for anyone else — see server/middleware/administrator.
  const [correcting, setCorrecting] = useState<number | null>(null);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  // A dashboard alert lands here with ?tab=Review&focus=iqc_runs:<id>.
  useFocusTarget(runs);
  const [action, setAction] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);

  const shown = filter === 'attention' ? runs.filter(r => r.status !== 'in_control' || !r.reviewed_at) : runs;

  const review = async (run: Run) => {
    setBusy(run.id);
    try {
      await api(`/iqc/runs/${run.id}/review`, { method: 'POST', body: JSON.stringify({ correctiveAction: action[run.id] ?? '' }) });
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };
  const release = async (run: Run, released: boolean) => {
    setBusy(run.id);
    try {
      await api(`/iqc/runs/${run.id}/release`, { method: 'POST', body: JSON.stringify({ released, note: action[run.id] ?? '' }) });
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <div className="card">
      <div className="section-head">
        <h3>Control runs</h3>
        <div className="tabs inline">
          <button type="button" className={filter === 'attention' ? 'active' : ''} onClick={() => setFilter('attention')}>Needs attention</button>
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All runs</button>
        </div>
      </div>

      {/* The QC record for a period — results, outcomes and rules — as one file. */}
      <XlsxToolbar
        module="iqc" exportOnly dateRange dateLabel="Runs"
        exportPath="/iqc/runs/export" exportName="IQC_Runs.xlsx" />

      {shown.length === 0 ? (
        <div className="iqc-clear plain"><CheckCircle2 size={18} /><span>Nothing waiting. Every run is in control and reviewed.</span></div>
      ) : (
        <ul className="iqc-runs">
          {shown.map(r => (
            <li key={r.id} className={STATUS_TONE[r.status]} {...focusAttr('iqc_runs', r.id)}>
              <span className={`iqc-rail ${STATUS_TONE[r.status]}`} />
              <div className="iqc-run-main">
                <div className="iqc-run-title">
                  <strong>{r.material_name}</strong>
                  <span className="muted">{r.test_name} · lot {r.lot_number}{r.level_label ? ` · ${r.level_label}` : ''}</span>
                  <span className={`chip ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  {r.patient_results_released === 0 && <span className="chip bad">Results withheld</span>}
                  {r.reviewed_at && <span className="chip ok">Reviewed</span>}
                </div>
                <div className="iqc-run-meta">
                  {r.run_number} · {r.run_date}{r.run_time ? ` ${r.run_time}` : ''}
                  {r.equipment_name ? ` · ${r.equipment_name}` : ''}{r.operator_name ? ` · ${r.operator_name}` : ''}
                </div>
                {r.rule_summary && <div className="iqc-run-rule">{r.rule_summary}</div>}
                {r.corrective_action && <div className="iqc-run-action"><em>Action taken:</em> {r.corrective_action}</div>}

                {canApprove && !r.reviewed_at && (
                  <div className="iqc-run-act">
                    <input placeholder={r.status === 'out_of_control' ? 'What was done about this? (required)' : 'Note (optional)'}
                      value={action[r.id] ?? ''} onChange={e => setAction(a => ({ ...a, [r.id]: e.target.value }))} />
                    <button type="button" disabled={busy === r.id} onClick={() => review(r)}>Sign off</button>
                    {r.patient_results_released === 0 && (
                      <button type="button" className="secondary" disabled={busy === r.id} onClick={() => release(r, true)}>
                        Release patient results
                      </button>
                    )}
                    {r.patient_results_released === 1 && r.status === 'out_of_control' && (
                      <button type="button" className="danger" disabled={busy === r.id} onClick={() => release(r, false)}>
                        Withhold results
                      </button>
                    )}
                  </div>
                )}

                {/* Reserved for an administrator, and drawn for nobody else. */}
                {isAdmin && correcting !== r.id && (
                  <div className="iqc-admin-acts">
                    <span className="iqc-admin-tag"><ShieldCheck size={11} /> Administrator</span>
                    <button type="button" className="tiny" onClick={() => setCorrecting(r.id)}>
                      <Pencil size={11} /> Correct this run
                    </button>
                    <button type="button" className="tiny danger" onClick={() => setCorrecting(-r.id)}>
                      <Trash2 size={11} /> Remove it
                    </button>
                  </div>
                )}
                {isAdmin && (correcting === r.id || correcting === -r.id) && (
                  <RunCorrection
                    run={r} mode={correcting === r.id ? 'edit' : 'delete'}
                    equipment={equipment} staff={staff}
                    onClose={() => setCorrecting(null)}
                    onDone={async (msg) => { setCorrecting(null); await onChanged(); onNotice(msg); }}
                    onError={onError} />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Correcting or removing a run — the administrator's panel.
 *
 * A control run is a quality record: it says what the instrument did and
 * whether patient results could go out, and somebody may already have acted on
 * it. So this asks for a reason, states plainly what the change will do, and
 * — on a correction — re-runs the same evaluation, which means the outcome
 * shown afterwards follows from the numbers now on file rather than the ones
 * that were there before.
 */
function RunCorrection({ run, mode, equipment, staff, onClose, onDone, onError }: {
  run: Run; mode: 'edit' | 'delete';
  equipment: EquipmentItem[]; staff: Staff[];
  onClose: () => void; onDone: (message: string) => void | Promise<void>; onError: (m: string) => void;
}) {
  const [detail, setDetail] = useState<{ readings: Record<string, any>[] } | null>(null);
  const [meta, setMeta] = useState({
    runDate: run.run_date, runTime: run.run_time ?? '',
    equipmentId: '', operatorStaffId: '', reagentLot: '', comment: '',
  });
  const [values, setValues] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'edit') return;
    api<{ readings: Record<string, any>[]; equipment_id: number | null; operator_staff_id: number | null; reagent_lot: string | null; comment: string | null }>(`/iqc/runs/${run.id}`)
      .then(d => {
        setDetail({ readings: d.readings });
        setMeta(m => ({
          ...m,
          equipmentId: d.equipment_id ? String(d.equipment_id) : '',
          operatorStaffId: d.operator_staff_id ? String(d.operator_staff_id) : '',
          reagentLot: d.reagent_lot ?? '', comment: d.comment ?? '',
        }));
        const v: Record<number, string> = {};
        for (const r of d.readings) {
          v[r.iqc_analyte_id] = Number(r.is_qualitative) === 1 ? String(r.qualitative_result ?? '') : String(r.result_value ?? '');
        }
        setValues(v);
      })
      .catch(e => onError((e as Error).message));
  }, [mode, run.id, onError]);

  const qualitative = run.control_type === 'qualitative';
  const ready = reason.trim().length >= 10;

  async function correct() {
    setBusy(true);
    try {
      const readings = (detail?.readings ?? []).map(r => ({
        analyteId: r.iqc_analyte_id,
        ...(qualitative ? { qualitativeResult: values[r.iqc_analyte_id] } : { value: values[r.iqc_analyte_id] }),
      }));
      const out = await api<{ status: string; ruleSummary: string | null; reviewCleared: boolean; message: string }>(
        `/iqc/runs/${run.id}`, { method: 'PUT', body: JSON.stringify({ ...meta, readings, reason }) });
      await onDone(`${out.message} It now reads ${STATUS_LABEL[out.status]}${out.ruleSummary ? ` — ${out.ruleSummary}` : ''}.`);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      const out = await api<{ message: string }>(`/iqc/runs/${run.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
      await onDone(out.message);
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (mode === 'delete') {
    return (
      <div className="iqc-danger">
        <strong><AlertTriangle size={14} /> Remove run {run.run_number}</strong>
        <p>
          This erases the run of {run.material_name} lot {run.lot_number} recorded on {run.run_date} and every reading on it.
          Later runs on this lot were judged with it in their history, so their charts will read without it.
          The audit trail keeps what was removed.
        </p>
        <p className="hint">
          This is for a run that should never have been recorded — a duplicate, a test entry, a run logged against the
          wrong control. A failure is not removed; it is investigated and signed off.
        </p>
        <label className="stack">Reason
          <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Duplicate entry — the same run was recorded twice on 2026-07-14." />
        </label>
        <div className="iqc-danger-acts">
          <button type="button" className="danger" disabled={busy || !ready} onClick={remove}>
            {busy ? 'Removing…' : 'Remove this run'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
        {!ready && <p className="hint">A reason of at least a sentence is required.</p>}
      </div>
    );
  }

  return (
    <div className="iqc-danger edit">
      <strong><Pencil size={14} /> Correct run {run.run_number}</strong>
      <p className="hint">
        The run is re-evaluated against this control's rules after the change, so its outcome and its patient-results
        decision follow from the corrected numbers.{run.reviewed_at ? ' It has been signed off, so correcting it sends it back for review.' : ''}
      </p>

      <div className="form-grid">
        <label>Run date<input type="date" value={meta.runDate} onChange={e => setMeta(m => ({ ...m, runDate: e.target.value }))} /></label>
        <label>Time<input type="time" value={meta.runTime} onChange={e => setMeta(m => ({ ...m, runTime: e.target.value }))} /></label>
        <label>Instrument<select value={meta.equipmentId} onChange={e => setMeta(m => ({ ...m, equipmentId: e.target.value }))}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Operator<select value={meta.operatorStaffId} onChange={e => setMeta(m => ({ ...m, operatorStaffId: e.target.value }))}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Reagent lot<input value={meta.reagentLot} onChange={e => setMeta(m => ({ ...m, reagentLot: e.target.value }))} /></label>
      </div>

      {detail === null ? <p className="muted">Loading the readings…</p> : (
        <table className="data-table compact iqc-entry">
          <thead><tr><th>Analyte</th><th>As recorded</th><th>Corrected to</th></tr></thead>
          <tbody>
            {detail.readings.map(r => (
              <tr key={r.id}>
                <td><strong>{r.analyte}</strong>{r.unit ? <span className="muted"> ({r.unit})</span> : null}</td>
                <td className="muted">{Number(r.is_qualitative) === 1
                  ? (QUALITATIVE_LABELS[r.qualitative_result as QualitativeOutcome] ?? r.qualitative_result)
                  : r.result_value}</td>
                <td>
                  {qualitative
                    ? <select value={values[r.iqc_analyte_id] ?? ''} onChange={e => setValues(v => ({ ...v, [r.iqc_analyte_id]: e.target.value }))}>
                        {QUALITATIVE_SCALES.flatMap(s => s.outcomes).filter((o, i, all) => all.indexOf(o) === i)
                          .map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                      </select>
                    : <input type="number" step="any" value={values[r.iqc_analyte_id] ?? ''}
                        onChange={e => setValues(v => ({ ...v, [r.iqc_analyte_id]: e.target.value }))} style={{ width: 120 }} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <label className="stack">Reason
        <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g. Haemoglobin transcribed as 1.35 instead of 13.5 — corrected against the analyser printout." />
      </label>
      <div className="iqc-danger-acts">
        <button type="button" disabled={busy || !ready || detail === null} onClick={correct}>
          {busy ? 'Re-evaluating…' : 'Save and re-evaluate'}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {!ready && <p className="hint">A reason of at least a sentence is required.</p>}
    </div>
  );
}

/* -------------------------------------------------------------------- chart */

function ChartTab({ materials, onError }: { materials: Material[]; onError: (m: string) => void }) {
  const quantitative = materials.filter(m => m.control_type !== 'qualitative');
  const [materialId, setMaterialId] = useState('');
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [analyteId, setAnalyteId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<ChartData | null>(null);

  // One period governs the chart on screen, the printed record and the export,
  // so what a reviewer signs is what they were looking at.
  const range = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const q = range ? `?${range}` : '';

  useEffect(() => {
    setAnalyteId(''); setData(null);
    if (!materialId) { setAnalytes([]); return; }
    api<Analyte[]>(`/iqc/materials/${materialId}/analytes`)
      .then(rows => { const active = rows.filter(a => a.is_active); setAnalytes(active); if (active[0]) setAnalyteId(String(active[0].id)); })
      .catch(() => setAnalytes([]));
  }, [materialId]);

  useEffect(() => {
    if (!analyteId) { setData(null); return; }
    api<ChartData>(`/iqc/analytes/${analyteId}/chart${q}`).then(setData).catch(e => onError((e as Error).message));
  }, [analyteId, q, onError]);

  const analyteName = analytes.find(a => String(a.id) === analyteId)?.analyte ?? 'chart';

  return (
    <div className="card">
      <div className="section-head"><h3><LineChart size={16} /> Levey-Jennings</h3></div>
      <div className="form-grid" style={{ marginBottom: 14 }}>
        <label>Control
          <select value={materialId} onChange={e => setMaterialId(e.target.value)}>
            <option value="">Choose a control…</option>
            {quantitative.map(m => <option key={m.id} value={m.id}>{m.material_name}{m.level_label ? ` — ${m.level_label}` : ''} · lot {m.lot_number}</option>)}
          </select>
        </label>
        <label>Analyte
          <select value={analyteId} onChange={e => setAnalyteId(e.target.value)} disabled={!analytes.length}>
            {analytes.map(a => <option key={a.id} value={a.id}>{a.analyte}</option>)}
          </select>
        </label>
        <label>From<input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} /></label>
      </div>
      {(from || to) && (
        <p className="muted" style={{ marginTop: -6 }}>
          Showing {from || 'the first result'} to {to || 'today'}.
          {' '}<button type="button" className="link-button" onClick={() => { setFrom(''); setTo(''); }}>Show all results</button>
        </p>
      )}

      {analyteId && (
        <XlsxToolbar
          module="iqc"
          exportName={`LJ_${analyteName.replace(/\W+/g, '_')}.xlsx`}
          exportPath={`/iqc/analytes/${analyteId}/chart.xlsx${q}`}
          printPath={`/iqc/analytes/${analyteId}/chart/print${q}`}
          printLabel="Print chart (PDF)"
          exportOnly
        />
      )}

      {!materialId && <p className="muted">Choose a quantitative control to chart. Qualitative controls have no numeric series — review them under Review instead.</p>}
      {data && <LeveyJenningsChart data={data} />}
    </div>
  );
}

/* --------------------------------------------------------------- lot change */

function LotChanges({ materials, onError, canCreate }: { materials: Material[]; onError: (m: string) => void; canCreate: boolean }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [form, setForm] = useState({ oldIqcMaterialId: '', newIqcMaterialId: '', changeDate: new Date().toISOString().slice(0, 10), reason: '', verificationSummary: '' });
  const load = useCallback(() => { api<Record<string, unknown>[]>('/iqc/lot-changes').then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try { await api('/iqc/lot-change', { method: 'POST', body: JSON.stringify(form) }); setForm(f => ({ ...f, reason: '', verificationSummary: '' })); load(); }
    catch (err) { onError((err as Error).message); }
  }
  const name = (id: unknown) => materials.find(m => m.id === Number(id))?.material_name ?? '—';

  return (
    <div className="card">
      <div className="section-head"><h3>Lot changes</h3></div>
      <p className="muted">A new lot has its own target values, so the two are bridged by running them in parallel. Recording it here marks the change on every chart.</p>
      {canCreate && (
        <form className="form-grid" onSubmit={submit} style={{ marginBottom: 16 }}>
          <label>Old lot<select value={form.oldIqcMaterialId} onChange={e => setForm(f => ({ ...f, oldIqcMaterialId: e.target.value }))} required><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} · {m.lot_number}</option>)}</select></label>
          <label>New lot<select value={form.newIqcMaterialId} onChange={e => setForm(f => ({ ...f, newIqcMaterialId: e.target.value }))} required><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} · {m.lot_number}</option>)}</select></label>
          <label>Change date<input type="date" value={form.changeDate} onChange={e => setForm(f => ({ ...f, changeDate: e.target.value }))} required /></label>
          <label>Reason<input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="e.g. Previous lot exhausted" /></label>
          <label className="stack">Parallel-run verification<textarea value={form.verificationSummary} onChange={e => setForm(f => ({ ...f, verificationSummary: e.target.value }))} rows={2} placeholder="How the new lot's targets were established against the old." /></label>
          <div className="form-actions"><button type="submit">Record lot change</button></div>
        </form>
      )}
      <table className="data-table"><thead><tr><th>Date</th><th>From</th><th>To</th><th>Reason</th><th>Verification</th></tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}><td>{String(r.change_date)}</td><td>{name(r.old_iqc_material_id)}</td><td>{name(r.new_iqc_material_id)}</td><td>{String(r.reason ?? '—')}</td><td>{String(r.verification_summary ?? '—')}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">No lot changes recorded.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default IqcPage;
