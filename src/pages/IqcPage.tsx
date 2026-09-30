import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlaskConical, Beaker, CheckCircle2, AlertTriangle, LineChart, Plus, Trash2,
  ClipboardCheck, ShieldCheck, ArrowRight, Info, Pencil, X, Radio, Loader2, Check,
} from 'lucide-react';
import { api, errorText, apiRead } from '../services/api';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import { useAuth } from '../hooks/useAuth';
import DisabledModule from '../components/DisabledModule';
import PermissionTabs from '../components/PermissionTabs';
import XlsxToolbar from '../components/XlsxToolbar';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { useAnalyserListen, armAnalyser } from '../hooks/useAnalyserListen';
import { PageHeader, KpiStrip, ModuleAlerts } from '../components/ui';
import LeveyJenningsChart, { type ChartData } from '../components/LeveyJenningsChart';
import {
  IQC_CONTROL_TYPES, IQC_CONTROL_TYPE_LABELS,
  IQC_FREQUENCIES, IQC_FREQUENCY_LABELS,
  IQC_RULE_PROFILE_LABELS, PROFILES_FOR_TYPE,
  QUALITATIVE_SCALES, QUALITATIVE_LABELS,
  AST_INTERPRETATIONS, AST_INTERPRETATION_LABELS, AST_METHODS, AST_METHOD_LABELS,
  CS_SCOPES, CS_SCOPE_LABELS, csNeedsOrganism, csNeedsPanel,
  RULE_LABELS, RULE_MEANING, isRejection, scaleForOutcome,
  CONTINUITY_TOLERANCE_KINDS, CONTINUITY_TOLERANCE_KIND_LABELS, DEFAULT_CONTINUITY_TOLERANCE,
  IQC_RUN_KINDS, IQC_RUN_KIND_LABELS, RETAINED_SOURCE_LABELS,
  effectiveTolerance, formatTolerance,
  type IqcSource, type IqcControlType, type IqcRuleProfile, type QualitativeOutcome, type IqcRunKind,
} from '../../shared/constants/iqc';
import { LINK_STATE_LABELS } from '../../shared/constants/instruments';
import type { Section, Staff, EquipmentItem } from '../../shared/types/api';
import { equipmentIsDiagnostic } from '../../shared/constants/equipment';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';
import InstrumentLinksTab from './InstrumentLinksTab';
import DefineControlForm from '../components/iqc/DefineControlForm';

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
  expected_organism: string | null; cs_scope: string | null;
  performing_section_id: number | null;
  continuity_tolerance_kind: string | null; continuity_tolerance_value: number | null;
  analyte_count: number; run_count: number; last_run_date: string | null;
};

type Analyte = {
  id: number; iqc_material_id: number; analyte: string; unit: string | null;
  target_mean: number | null; target_sd: number | null;
  acceptable_low: number | null; acceptable_high: number | null;
  decimal_places: number; expected_result: string | null;
  ast_method: string | null; expected_interpretation: string | null;
  continuity_tolerance_kind: string | null; continuity_tolerance_value: number | null;
  is_active: number; display_order: number;
};

type Run = {
  id: number; run_number: string | null; iqc_material_id: number; run_date: string; run_time: string | null;
  status: string; rule_summary: string | null; patient_results_released: number | null;
  corrective_action: string | null; reviewed_at: string | null; reviewed_by: string | null;
  material_name: string; lot_number: string; test_name: string; control_type: IqcControlType;
  level_label: string | null; equipment_name: string | null; operator_name: string | null;
  run_kind: string | null; retained_sample_reference: string | null;
};

/* ---- previously run samples, kept when control material runs out ---- */

type RetainedValue = {
  iqc_analyte_id: number; analyte: string; unit: string | null;
  original_value: number | null; original_qualitative_result: string | null; original_interpretation: string | null;
};

type RetainedSample = {
  id: number; sample_code: string; sample_reference: string; sample_type: string | null;
  original_run_date: string; original_run_time: string | null; source: string;
  equipment_name: string | null; section_name: string | null; reason: string | null;
  original_run_number: string | null; original_control_date: string | null; original_control_status: string | null;
  rerun_count: number; last_rerun_date: string | null;
  values: RetainedValue[];
};

type CoverageRun = { id: number; run_number: string; run_date: string; run_time: string | null; status: string; rule_summary: string | null };

type FeedCandidate = {
  id: number; sample_id: string | null; received_at: string; instrument_run_at: string | null;
  feed_name: string | null; parsed_values: { analyte?: string; value?: number | string }[];
};

type AnalyserWaiting = {
  id: number; sample_id: string | null; lot_number: string | null;
  received_at: string; instrument_run_at: string | null;
  parsed_values: { analyte?: string; value?: number | string }[];
  status: string; status_note: string | null; source_name: string | null;
};

type AnalyserStatus = {
  linked: boolean; why?: string;
  source?: {
    kind: string; id: number; name: string; mode?: string; role?: string; protocol?: string;
    state: string; stateDetail: string | null; lastError: string | null; lastMessageAt: string | null;
    canFetch: boolean; open: boolean;
  };
  waiting: AnalyserWaiting[];
};

type AnalyserMapping = {
  readings: { analyteId: number; analyte: string; value: number | null; qualitativeResult?: string | null }[];
  unmatchedLabels: string[];
  missingAnalytes: { analyteId: number; analyte: string }[];
  matched: number;
};

type RunOutcome = {
  status: string; ruleSummary: string | null; mayReleasePatientResults: boolean;
  analytes: {
    analyte: string; status: string; rule: string | null; value?: number | null; zScore?: number | null;
    originalValue?: number | null; deviation?: number | null; deviationPercent?: number | null;
  }[];
};

const STATUS_TONE: Record<string, string> = { in_control: 'ok', warning: 'warn', out_of_control: 'bad' };
const STATUS_LABEL: Record<string, string> = { in_control: 'In control', warning: 'Warning', out_of_control: 'Rejected' };

function useLookups() {
  const [sections, setSections] = useState<Section[]>([]);
  const [mySectionId, setMySectionId] = useState<number | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  useEffect(() => {
    // The units come from the lookup, not from /sections: that one is gated on
    // settings rights, so a unit head defining a control for their own bench
    // got an empty dropdown and saved a control with no unit on it. A control
    // with no unit never reaches anybody's board.
    api<{ mine: number | null; sections: Array<Section & { isMine?: boolean }> }>('/sections/options')
      .then(r => { setSections(r.sections); setMySectionId(r.mine ?? null); })
      .catch(() => setSections([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    // Only diagnostic (laboratory / measuring) equipment belongs in quality
    // control. Non-diagnostic support items — fridges, freezers, computers —
    // are classified 'support' in Equipment Management and never appear here.
    api<EquipmentItem[]>('/equipment')
      .then(list => setEquipment(list.filter(equipmentIsDiagnostic)))
      .catch(() => setEquipment([]));
  }, []);
  return { sections, staff, equipment, mySectionId };
}

export function IqcPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { can, unitsLed } = usePermissions();
  const { user } = useAuth();
  const { sections, staff, equipment, mySectionId } = useLookups();
  const isAdmin = user?.isAdministrator === true;

  // Two ways to reach this work. The Quality Control right carries the whole
  // laboratory; running a unit carries that unit's own controls and no others,
  // which is what the API allows and therefore what these screens offer.
  const ledIds = useMemo(() => new Set(unitsLed.map(u => Number(u.id))), [unitsLed]);
  const canCreateAll = can('iqc', 'create');
  const canCreate = canCreateAll || ledIds.size > 0;
  /** Does this control belong to a unit this account runs? */
  const ownUnit = (m: { section_id: number | null }) => m.section_id != null && ledIds.has(Number(m.section_id));
  const unitsForDefining = canCreateAll ? sections : sections.filter(sec => ledIds.has(Number(sec.id)));

  const [tab, setTab] = useState(embedded ? 'Controls' : 'Dashboard');
  const [materials, setMaterials] = useState<Material[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [mats, rns] = await Promise.all([
        apiRead<Material[]>('/iqc/materials', []),
        apiRead<Run[]>('/iqc/runs', []),
      ]);
      setMaterials(mats); setRuns(rns);
      api<Record<string, number>>('/dashboard/iqc-summary').then(setSummary).catch(() => undefined);
    } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { if (embedded || isEnabled('iqc')) void load(); }, [embedded, isEnabled, load]);
  if (!embedded && !isEnabled('iqc')) return <DisabledModule />;

  const tabs = ['Dashboard', 'Controls', 'New Control', 'Run Control', 'Review', 'Levey-Jennings', 'Lot Changes', 'Analyser Links']
    .filter(n => !embedded || n !== 'Dashboard');

  const pendingReview = runs.filter(r => !r.reviewed_at && r.status !== 'in_control');
  const failedRuns = runs.filter(r => r.status === 'out_of_control');

  return (
    <div className="module-page iqc">
      {!embedded && (
        <PageHeader
          eyebrow="Process Management"
          title="Internal Quality Control"
        />
      )}
      <PermissionTabs moduleKey="iqc" tabs={tabs} active={tab} onChange={setTab} />
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

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
          canEdit={can('iqc', 'edit')} ownUnit={ownUnit}
          sections={sections} staff={staff} equipment={equipment}
          isAdmin={isAdmin} onError={setError} onNotice={setNotice}
        />
      )}

      {tab === 'New Control' && (
        canCreate
          ? <>
              {can('iqc', 'import') && <ImportControls onImported={async (n) => {
                await load();
                if (n > 0) setNotice(`${n} control${n === 1 ? '' : 's'} brought in from Excel. Check the register.`);
              }} />}
              <DefineControlForm sections={unitsForDefining} staff={staff} equipment={equipment}
                mySectionId={mySectionId ?? (unitsLed[0]?.id ?? null)}
                onSaved={async () => { await load(); setNotice('Control defined. It is ready to run.'); setTab('Controls'); }}
                onError={setError} />
            </>
          : <p className="muted">You do not have permission to define new controls.</p>
      )}

      {tab === 'Run Control' && (
        canCreate
          ? <RunControl materials={materials.filter(m => m.is_active && (canCreateAll || ownUnit(m)))} equipment={equipment} staff={staff}
              sections={unitsForDefining} mySectionId={mySectionId ?? (unitsLed[0]?.id ?? null)}
              onRecorded={async (msg) => { await load(); setNotice(msg); }} onError={setError} />
          : <p className="muted">You do not have permission to record control runs.</p>
      )}

      {tab === 'Review' && (
        <RunReview runs={runs} onChanged={load} canApprove={can('iqc', 'approve')}
          isAdmin={isAdmin} equipment={equipment} staff={staff} onError={setError} onNotice={setNotice} />
      )}

      {tab === 'Levey-Jennings' && <ChartTab materials={materials} onError={setError} onNotice={setNotice} canEdit={can('iqc', 'edit')} />}

      {tab === 'Lot Changes' && <LotChanges materials={materials} onError={setError} canCreate={can('iqc', 'create')} />}

      {tab === 'Analyser Links' && <InstrumentLinksTab />}
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

function ControlRegister({ materials, onChanged, onRun, onChart, canEdit, ownUnit, sections, staff, equipment, isAdmin, onError, onNotice }: {
  materials: Material[]; onChanged: () => void; onRun: () => void; onChart: () => void; canEdit: boolean;
  /** A control this account may work on because it runs the unit that owns it. */
  ownUnit: (m: Material) => boolean;
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
                  <ControlDetail material={m} analytes={analytes[m.id] ?? []} canEdit={canEdit || ownUnit(m)}
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
        {material.control_type === 'culture_sensitivity' && <div><dt>Confirms</dt><dd>{CS_SCOPE_LABELS[(material.cs_scope ?? 'both') as never] ?? 'Identification & susceptibility'}</dd></div>}
        {material.control_type === 'culture_sensitivity' && material.expected_organism && <div><dt>Reference strain</dt><dd>{material.expected_organism}</dd></div>}
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

      {material.control_type === 'culture_sensitivity' && material.cs_scope === 'identification'
        ? <p className="hint">Identification only — expected: <strong>{material.expected_organism || '—'}</strong></p>
        : <table className="data-table compact">
        <thead><tr>
          <th>{material.control_type === 'culture_sensitivity' ? 'Antimicrobial agent' : 'Analyte'}</th>
          {material.control_type === 'culture_sensitivity'
            ? <><th>Method</th><th>Expected category</th></>
            : <><th>Unit</th>{material.control_type === 'qualitative'
              ? <th>Expected result</th>
              : <><th>Target mean</th><th>Target SD</th><th>Acceptable range</th></>}</>}
        </tr></thead>
        <tbody>
          {analytes.filter(a => a.is_active).map(a => (
            <tr key={a.id}>
              <td>{a.analyte}</td>
              {material.control_type === 'culture_sensitivity' ? (
                <>
                  <td>{a.ast_method ? AST_METHOD_LABELS[a.ast_method as never] ?? a.ast_method : '—'}</td>
                  <td>{a.expected_interpretation ? <span className="chip">{AST_INTERPRETATION_LABELS[a.expected_interpretation as never] ?? a.expected_interpretation}</span> : <span className="chip bad">not set</span>}</td>
                </>
              ) : (
                <>
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
                </>
              )}
            </tr>
          ))}
          {analytes.length === 0 && <tr><td colSpan={6} className="muted">No analytes defined. This control cannot be run until it measures something.</td></tr>}
        </tbody>
      </table>}

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
  const { can } = usePermissions();
  const [impact, setImpact] = useState<Record<string, any> | null>(null);
  const [confirming, setConfirming] = useState<'retire' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const openRemoval = async () => {
    setConfirming('retire'); setReason(''); setImpact(null);
    try { setImpact(await api(`/iqc/materials/${material.id}/deletion-impact`)); }
    catch (e) { onError(errorText(e)); }
  };

  async function remove(mode: 'retire' | 'delete', force = false) {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/iqc/materials/${material.id}?mode=${mode}${force ? '&force=1' : ''}`,
        { method: 'DELETE', body: JSON.stringify({ reason }) });
      setConfirming(null); await onChanged(); onNotice(r.message);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function reactivate() {
    setBusy(true);
    try {
      const r = await api<{ warning: string | null }>(`/iqc/materials/${material.id}/reactivate`, { method: 'POST', body: '{}' });
      await onChanged();
      onNotice(r.warning ?? `${material.material_name} lot ${material.lot_number} is back in use.`);
    } catch (e) { onError(errorText(e)); }
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
          <TextField as="textarea" rows={2} value={reason} onValue={nextValue => setReason(nextValue)}
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
            {can('iqc', 'edit') && <button type="button" className="secondary" disabled={busy} onClick={reactivate}>Put back in use</button>}
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
  const { can } = usePermissions();
  const qualitative = material.control_type === 'qualitative';
  const isCs = material.control_type === 'culture_sensitivity';
  const [csScope, setCsScope] = useState(material.cs_scope ?? 'both');
  const wantsOrganism = isCs && csNeedsOrganism(csScope);
  const wantsPanel = isCs && csNeedsPanel(csScope);
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
    validationSummary: material.validation_summary ?? '', expectedOrganism: material.expected_organism ?? '',
    continuityToleranceKind: material.continuity_tolerance_kind ?? DEFAULT_CONTINUITY_TOLERANCE.kind,
    continuityToleranceValue: material.continuity_tolerance_value === null || material.continuity_tolerance_value === undefined
      ? String(DEFAULT_CONTINUITY_TOLERANCE.value) : String(material.continuity_tolerance_value),
  });
  const [rows, setRows] = useState(() => analytes.filter(a => a.is_active).map(a => ({
    analyte: a.analyte, unit: a.unit ?? '',
    targetMean: a.target_mean === null ? '' : String(a.target_mean),
    targetSd: a.target_sd === null ? '' : String(a.target_sd),
    acceptableLow: a.acceptable_low === null ? '' : String(a.acceptable_low),
    acceptableHigh: a.acceptable_high === null ? '' : String(a.acceptable_high),
    decimalPlaces: String(a.decimal_places ?? 2), expectedResult: a.expected_result ?? '',
    astMethod: a.ast_method ?? '', expectedInterpretation: a.expected_interpretation ?? '',
    continuityTolerance: a.continuity_tolerance_value === null || a.continuity_tolerance_value === undefined
      ? '' : formatTolerance(a.continuity_tolerance_kind, a.continuity_tolerance_value).replace('±', ''),
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
    if (kept.length === 0 && !(isCs && !wantsPanel)) return onError('A control has to measure something — keep at least one analyte.');
    if (qualitative && kept.some(r => !r.expectedResult)) {
      return onError('Every qualitative analyte needs the result the control is expected to give.');
    }
    if (isCs) {
      if (wantsOrganism && !form.expectedOrganism.trim()) return onError('Name the reference strain this control is expected to identify.');
      if (wantsPanel && kept.some(r => !r.expectedInterpretation)) return onError('Every antimicrobial agent needs its expected category (S, SDD, I, R or NS).');
    }
    const payloadAnalytes = isCs && !wantsPanel ? [] : kept;
    setBusy(true);
    try {
      const r = await api<{ targetsMoved: string[]; affectedRuns: number; analyteChanges: Record<string, number> }>(
        `/iqc/materials/${material.id}`,
        { method: 'PUT', body: JSON.stringify({ ...form, csScope, analytes: payloadAnalytes, reason }) });
      const notes = [
        r.analyteChanges?.added ? `${r.analyteChanges.added} analyte(s) added` : null,
        r.analyteChanges?.retired ? `${r.analyteChanges.retired} retired` : null,
        r.affectedRuns ? `${r.affectedRuns} recorded run(s) now read against the new target` : null,
      ].filter(Boolean);
      await onSaved(`${material.material_name} lot ${form.lotNumber} updated${notes.length ? ` — ${notes.join(', ')}` : ''}.`);
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    // A PUT to /iqc/materials/:id. The form asked for `create`, so somebody
    // who may define a new control but not change one was shown an edit form
    // the server then refused.
    can('iqc', 'edit') && <form className="iqc-detail iqc-edit" onSubmit={submit}>
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
        <label>Control name<TextField value={form.materialName} onValue={nextValue => set('materialName', nextValue)} required /></label>
        <label>Test<TextField value={form.testName} onValue={nextValue => set('testName', nextValue)} required /></label>
        <label>Lot / batch number<TextField value={form.lotNumber} onValue={nextValue => set('lotNumber', nextValue)} required /></label>
        <label>Level or designation<TextField value={form.levelLabel} onValue={nextValue => set('levelLabel', nextValue)} /></label>
        {material.source === 'commercial' && <label>Manufacturer<TextField value={form.manufacturer} onValue={nextValue => set('manufacturer', nextValue)} /></label>}
        <label>Expiry date<input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} /></label>
        <label>Open-vial expiry<input type="date" value={form.openVialExpiry} onChange={e => set('openVialExpiry', e.target.value)} /></label>
        <label>Storage condition<TextField value={form.storageCondition} onValue={nextValue => set('storageCondition', nextValue)} placeholder="e.g. 2–8 °C" /></label>
        <label>Section<select value={form.sectionId} onChange={e => set('sectionId', e.target.value)}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Instrument<select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Run frequency<select value={form.qcFrequency} onChange={e => set('qcFrequency', e.target.value)}>{IQC_FREQUENCIES.map(f => <option key={f} value={f}>{IQC_FREQUENCY_LABELS[f]}</option>)}</select></label>
        <label>Rule set<select value={form.ruleProfile} onChange={e => set('ruleProfile', e.target.value)}>
          {PROFILES_FOR_TYPE[material.control_type].map(p => <option key={p} value={p}>{IQC_RULE_PROFILE_LABELS[p]}</option>)}
        </select></label>
        {isCs && <label>This control confirms<select value={csScope} onChange={e => setCsScope(e.target.value)}>
          {CS_SCOPES.map(s => <option key={s} value={s}>{CS_SCOPE_LABELS[s]}</option>)}
        </select></label>}
        {wantsOrganism && <label>Expected organism (reference strain)<TextField value={form.expectedOrganism} onValue={nextValue => set('expectedOrganism', nextValue)} placeholder="e.g. E. coli ATCC 25922" required /></label>}
        <label>Re-read tolerance<select value={form.continuityToleranceKind} onChange={e => set('continuityToleranceKind', e.target.value)}>
          {CONTINUITY_TOLERANCE_KINDS.map(k => <option key={k} value={k}>{CONTINUITY_TOLERANCE_KIND_LABELS[k]}</option>)}
        </select></label>
        <label>Allowed difference<input type="number" step="any" min={0} value={form.continuityToleranceValue}
          onChange={e => set('continuityToleranceValue', e.target.value)} /></label>
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
            <label>Base material<TextField value={form.baseMaterial} onValue={nextValue => set('baseMaterial', nextValue)} /></label>
          </div>
          <label className="stack">How it was prepared<TextField as="textarea" rows={2} value={form.preparationMethod} onValue={nextValue => set('preparationMethod', nextValue)} required /></label>
          <label className="stack">How its target was assigned<TextField as="textarea" rows={2} value={form.validationSummary} onValue={nextValue => set('validationSummary', nextValue)} /></label>
        </fieldset>
      )}

      {(!isCs || wantsPanel) && <>
      <table className="data-table compact iqc-entry">
        <thead><tr>
          <th>{isCs ? 'Antimicrobial agent' : 'Analyte'}</th>
          {isCs
            ? <><th>Method</th><th>Expected category</th></>
            : <><th>Unit</th>{qualitative ? <th>Expected result</th> : <><th>Target mean</th><th>Target SD</th><th>Acceptable low</th><th>Acceptable high</th><th>Decimals</th><th>Re-read ±</th></>}</>}
          <th />
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><TextField value={r.analyte} onValue={nextValue => setRow(i, 'analyte', nextValue)} required /></td>
              {isCs ? (
                <>
                  <td><select value={r.astMethod} onChange={e => setRow(i, 'astMethod', e.target.value)}>
                    <option value="">—</option>
                    {AST_METHODS.map(m => <option key={m} value={m}>{AST_METHOD_LABELS[m]}</option>)}
                  </select></td>
                  <td><select value={r.expectedInterpretation} onChange={e => setRow(i, 'expectedInterpretation', e.target.value)} required>
                    <option value="">—</option>
                    {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                  </select></td>
                </>
              ) : (
                <>
                  <td><TextField value={r.unit} onValue={nextValue => setRow(i, 'unit', nextValue)} style={{ width: 80 }} /></td>
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
                      <td><TextField value={r.continuityTolerance} onValue={nextValue => setRow(i, 'continuityTolerance', nextValue)}
                        placeholder={form.continuityToleranceValue
                          ? (form.continuityToleranceKind === 'absolute' ? form.continuityToleranceValue : `${form.continuityToleranceValue}%`)
                          : ''} style={{ width: 76 }} /></td>
                    </>
                  )}
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
      <button type="button" className="secondary tiny" onClick={() => setRows(rs => [...rs, { analyte: '', unit: '', targetMean: '', targetSd: '', acceptableLow: '', acceptableHigh: '', decimalPlaces: '2', expectedResult: '', astMethod: '', expectedInterpretation: '', continuityTolerance: '' }])}>
        <Plus size={12} /> {isCs ? 'Add an agent' : 'Add an analyte'}
      </button>
      </>}

      {needsReason && (
        <div className="iqc-note warn">
          <strong>{movedTargets.join(', ')}</strong>: you are moving the target on a lot with {material.run_count} recorded
          run(s). Every z-score already on file was measured against the old target, so say why.
          <label className="stack" style={{ marginTop: 8 }}>Reason
            <TextField as="textarea" rows={2} value={reason} onValue={nextValue => setReason(nextValue)}
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
      <XlsxToolbar
        module="iqc" importOnly exportName="IQC_Controls.xlsx"
        templatePath="/iqc/controls/template" importPath="/iqc/controls/import"
        onImported={r => void onImported((r.created ?? 0) + (r.updated ?? 0))}
      />
    </div>
  );
}

/* --------------------------------------------------------------- run control */

function RunControl({ materials, equipment, staff, sections, mySectionId, onRecorded, onError }: {
  materials: Material[]; equipment: EquipmentItem[]; staff: Staff[];
  /** The units this account may record a run for. One unit means no picker. */
  sections: Section[]; mySectionId: number | null;
  onRecorded: (msg: string) => void | Promise<void>; onError: (m: string) => void;
}) {
  const { can } = usePermissions();
  const [runKind, setRunKind] = useState<IqcRunKind>('control');
  const [unitId, setUnitId] = useState<string>(mySectionId != null ? String(mySectionId) : '');
  const [materialId, setMaterialId] = useState('');
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [values, setValues] = useState<Record<number, string>>({});
  const [meta, setMeta] = useState({ runDate: new Date().toISOString().slice(0, 10), runTime: '', shift: '', equipmentId: '', reagentLot: '', operatorStaffId: '', comment: '', observedOrganism: '' });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);

  // What the analyser is offering for this control, and what the last thing
  // brought in from it lined up against.
  const [analyser, setAnalyser] = useState<AnalyserStatus | null>(null);
  const [mapping, setMapping] = useState<AnalyserMapping | null>(null);

  // Previously run samples: the register for this control, which one is being
  // re-read, and whether the form for enrolling a new one is open.
  const [samples, setSamples] = useState<RetainedSample[]>([]);
  const [sampleId, setSampleId] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  const unitOf = (m: Material) => m.performing_section_id ?? m.section_id;
  const canChooseUnit = sections.length > 1;
  const inUnit = unitId === '' || !canChooseUnit
    ? materials
    : materials.filter(m => String(unitOf(m) ?? '') === unitId);
  const material = materials.find(m => String(m.id) === materialId);
  const sample = samples.find(s => String(s.id) === sampleId);
  const retained = runKind === 'retained_sample';
  const isCs = material?.control_type === 'culture_sensitivity';
  const categorical = material?.control_type === 'qualitative' || isCs;
  // The instruments offered narrow to the unit, so a haematology bench is not
  // scrolling past the chemistry analysers to find its own.
  const instruments = unitId === '' || !canChooseUnit
    ? equipment
    : equipment.filter(x => x.section_id == null || String(x.section_id) === unitId);

  // A control the unit picker has just filtered away cannot stay selected.
  useEffect(() => {
    if (materialId && !inUnit.some(m => String(m.id) === materialId)) setMaterialId('');
  }, [unitId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setOutcome(null); setValues({}); setSampleId(''); setEnrolling(false); setSamples([]);
    setAnalyser(null); setMapping(null);
    if (!materialId) { setAnalytes([]); return; }
    api<Analyte[]>(`/iqc/materials/${materialId}/analytes`)
      .then(rows => setAnalytes(rows.filter(a => a.is_active)))
      .catch(() => setAnalytes([]));
    api<AnalyserStatus>(`/iqc/materials/${materialId}/analyser`)
      .then(setAnalyser).catch(() => setAnalyser(null));
  }, [materialId]);

  const loadSamples = useCallback(async () => {
    if (!materialId) return;
    try { setSamples(await api<RetainedSample[]>(`/iqc/materials/${materialId}/retained-samples`)); }
    catch { setSamples([]); }
  }, [materialId]);

  useEffect(() => { if (retained && materialId) void loadSamples(); }, [retained, materialId, loadSamples]);

  /** What the chosen sample originally gave for one analyte. */
  const originalFor = (analyteId: number) => sample?.values.find(v => v.iqc_analyte_id === analyteId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!material) return onError('Choose which control you are running.');
    if (retained && !sample) return onError('Choose the previously run sample you are re-reading.');

    const readings = analytes
      .map(a => {
        const raw = values[a.id];
        if (raw === undefined || raw === '') return null;
        if (isCs) return { analyteId: a.id, interpretation: raw };
        return material.control_type === 'qualitative'
          ? { analyteId: a.id, qualitativeResult: raw }
          : { analyteId: a.id, value: Number(raw) };
      })
      .filter(Boolean);

    if (retained) {
      if (readings.length === 0) return onError('Enter what the sample gave on this re-read.');
    } else {
      if (readings.length === 0 && !(isCs && meta.observedOrganism.trim())) {
        return onError(isCs ? 'Record the organism identified and/or at least one susceptibility category.' : 'Enter at least one reading.');
      }
      if (isCs && csNeedsOrganism(material.cs_scope) && !meta.observedOrganism.trim()) {
        return onError('Record the organism the reference strain identified as.');
      }
    }

    setBusy(true);
    try {
      const r = await api<RunOutcome & { runNumber: string }>('/iqc/runs', {
        method: 'POST',
        body: JSON.stringify({
          iqcMaterialId: Number(materialId), ...meta, readings, runKind,
          sectionId: unitId || undefined,
          retainedSampleId: retained ? Number(sampleId) : undefined,
        }),
      });
      setOutcome(r);
      setValues({});
      // The sample's card carries how many times it has been re-read, so it is
      // refreshed rather than left saying "not yet" over a run just recorded.
      if (retained) await loadSamples();
      const what = retained ? `Re-read of ${sample!.sample_reference}` : `Run ${r.runNumber}`;
      await onRecorded(
        r.status === 'out_of_control'
          ? `${what} recorded and REJECTED. Patient results are withheld until this is investigated.`
          : `${what} recorded — ${r.status === 'warning' ? 'warning flagged' : 'in control'}.`);
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  const ready = Boolean(material) && (retained ? Boolean(sample) : (analytes.length > 0 || isCs));

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

    {can('iqc', 'create') && <form className="card iqc-run" onSubmit={submit}>
      <div className="section-head"><h3><ClipboardCheck size={16} /> Record a control run</h3></div>

      {/* 1 — what is going on the analyser */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">1</span> What are you running?</legend>
        <div className="iqc-choice">
          {IQC_RUN_KINDS.map(k => (
            <button key={k} type="button" className={runKind === k ? 'active' : ''}
              onClick={() => { setRunKind(k); setOutcome(null); }}>
              <strong>{IQC_RUN_KIND_LABELS[k]}</strong>
              <span>
                {k === 'control'
                  ? 'The control material itself, judged against the limits on its definition.'
                  : 'A sample this laboratory already tested, re-read and compared with the result it gave the first time.'}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* 2 — which control, and whose bench */}
      <fieldset className="iqc-step">
        <legend><span className="step-n">2</span> Which control?</legend>
        <div className="form-grid">
          {canChooseUnit && (
            <label>Unit
              <select value={unitId} onChange={e => setUnitId(e.target.value)}>
                <option value="">All units</option>
                {sections.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{mySectionId != null && Number(s.id) === Number(mySectionId) ? ' (yours)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>Control
            <select value={materialId} onChange={e => setMaterialId(e.target.value)} required>
              <option value="">Choose a control…</option>
              {inUnit.map(m => (
                <option key={m.id} value={m.id}>
                  {m.material_name}{m.level_label ? ` — ${m.level_label}` : ''} · {m.test_name} · lot {m.lot_number}
                </option>
              ))}
            </select>
          </label>
        </div>
        {canChooseUnit && inUnit.length === 0 && (
          <p className="iqc-note warn">No active control is filed under this unit.</p>
        )}
        {material && (
          <div className="iqc-run-ctx">
            <span className={`chip type-${material.control_type}`}>{IQC_CONTROL_TYPE_LABELS[material.control_type]}</span>
            <span className={`chip src-${material.source}`}>{material.source === 'in_house' ? 'In-house' : 'Commercial'}</span>
            <span className="chip">{IQC_RULE_PROFILE_LABELS[material.rule_profile]}</span>
            <span className="chip">{IQC_FREQUENCY_LABELS[material.qc_frequency as never] ?? material.qc_frequency}</span>
            {material.section_name && <span className="chip">{material.section_name}</span>}
          </div>
        )}
      </fieldset>

      {/* 2b — the sample standing in for the control */}
      {retained && material && (
        <RetainedSamplePicker
          material={material} analytes={analytes} samples={samples}
          sampleId={sampleId} onPick={setSampleId}
          enrolling={enrolling} onEnrolling={setEnrolling}
          equipment={instruments}
          onEnrolled={async (id) => { await loadSamples(); setSampleId(String(id)); setEnrolling(false); }}
          onError={onError} />
      )}

      {/* 3 — when, where and who */}
      {ready && (
        <fieldset className="iqc-step">
          <legend><span className="step-n">3</span> When, and on what?</legend>
          <div className="form-grid">
            <label>Run date<input type="date" value={meta.runDate} max={new Date().toISOString().slice(0, 10)} onChange={e => setMeta(m => ({ ...m, runDate: e.target.value }))} required /></label>
            <label>Time<input type="time" value={meta.runTime} onChange={e => setMeta(m => ({ ...m, runTime: e.target.value }))} /></label>
            <label>Shift<select value={meta.shift} onChange={e => setMeta(m => ({ ...m, shift: e.target.value }))}><option value="">—</option><option>Morning</option><option>Afternoon</option><option>Night</option></select></label>
            <label>Instrument<select value={meta.equipmentId} onChange={e => setMeta(m => ({ ...m, equipmentId: e.target.value }))}><option value="">— None (manual method) —</option>{instruments.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>Reagent lot<TextField value={meta.reagentLot} onValue={nextValue => setMeta(m => ({ ...m, reagentLot: nextValue }))} /></label>
            <label>Operator<select value={meta.operatorStaffId} onChange={e => setMeta(m => ({ ...m, operatorStaffId: e.target.value }))}><option value="">Me</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
          </div>
        </fieldset>
      )}

      {/* 4 — the readings */}
      {ready && (
        <fieldset className="iqc-step">
          <legend><span className="step-n">4</span> {retained ? 'What did it give this time?' : 'The readings'}</legend>

          {!retained && material && isCs && csNeedsOrganism(material.cs_scope) && (
            <div className="form-grid" style={{ marginBottom: 10 }}>
              <label>Organism identified
                <TextField value={meta.observedOrganism} onValue={nextValue => setMeta(m => ({ ...m, observedOrganism: nextValue }))}
                  placeholder={material.expected_organism ? `Expected: ${material.expected_organism}` : 'Organism the strain identified as'} />
              </label>
            </div>
          )}

          {/* The analyser, where one is attached to this control. Typing a
              twenty-three parameter FBC off a printout is not a workflow; it
              is a reason to stop keeping the record. */}
          {analyser?.linked && analyser.source && (
            <AnalyserPanel
              materialId={Number(materialId)} status={analyser} mapping={mapping}
              onStatus={setAnalyser} onMapping={setMapping}
              onReadings={rows => setValues(v => {
                const next = { ...v };
                for (const r of rows) {
                  next[r.analyteId] = r.value !== null && r.value !== undefined
                    ? String(r.value) : String(r.qualitativeResult ?? '');
                }
                return next;
              })}
              onError={onError} />
          )}

          {material && analytes.length > 0 && (
            <table className="data-table compact iqc-entry">
              <thead><tr>
                <th>{isCs ? 'Agent' : 'Analyte'}</th>
                {retained
                  ? <><th>Original</th>{!categorical && <th>Allowed</th>}<th>This re-read</th></>
                  : categorical
                    ? <><th>Expected</th><th>Observed</th></>
                    : <><th>Target</th><th>Acceptable</th><th>Result</th></>}
              </tr></thead>
              <tbody>
                {analytes.map(a => {
                  const original = retained ? originalFor(a.id) : undefined;
                  const tol = effectiveTolerance(a, material);
                  return (
                    <tr key={a.id}>
                      <td><strong>{a.analyte}</strong>{a.unit ? <span className="muted"> ({a.unit})</span> : null}</td>
                      {retained ? (
                        <>
                          <td className="muted">
                            {!original ? '—'
                              : categorical
                                ? (AST_INTERPRETATION_LABELS[(original.original_interpretation ?? '') as never]
                                    ?? QUALITATIVE_LABELS[(original.original_qualitative_result ?? '') as QualitativeOutcome]
                                    ?? original.original_qualitative_result ?? original.original_interpretation ?? '—')
                                : (original.original_value ?? '—')}
                          </td>
                          {!categorical && <td className="muted">{original ? formatTolerance(tol.kind, tol.value) : '—'}</td>}
                          <td>
                            {isCs ? (
                              <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                                <option value="">—</option>
                                {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                              </select>
                            ) : material.control_type === 'qualitative' ? (
                              <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                                <option value="">—</option>
                                {scaleForOutcome(original?.original_qualitative_result ?? a.expected_result)
                                  .map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                              </select>
                            ) : (
                              <input type="number" step="any" value={values[a.id] ?? ''}
                                onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))} style={{ width: 120 }} />
                            )}
                          </td>
                        </>
                      ) : isCs ? (
                        <>
                          <td>{a.expected_interpretation ? AST_INTERPRETATION_LABELS[a.expected_interpretation as never] ?? a.expected_interpretation : '—'}</td>
                          <td>
                            <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                              <option value="">—</option>
                              {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                            </select>
                          </td>
                        </>
                      ) : material.control_type === 'qualitative' ? (
                        <>
                          <td>{a.expected_result ? QUALITATIVE_LABELS[a.expected_result as QualitativeOutcome] : '—'}</td>
                          <td>
                            <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                              <option value="">—</option>
                              {scaleForOutcome(a.expected_result).map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
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
                  );
                })}
              </tbody>
            </table>
          )}

          {material && analytes.length === 0 && !isCs && (
            <p className="iqc-note bad">This control has no analytes defined, so it cannot be run. Edit its definition first.</p>
          )}

          <label className="stack">Comment<TextField as="textarea" value={meta.comment} onValue={nextValue => setMeta(m => ({ ...m, comment: nextValue }))} rows={2} /></label>
        </fieldset>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy || !ready}>{busy ? 'Evaluating…' : retained ? 'Record re-read' : 'Record run'}</button>
      </div>

      {outcome && <RunOutcomePanel outcome={outcome} retained={retained} />}
    </form>}
    </>
  );
}

/* ------------------------------------------------------- from the analyser */

/**
 * Taking the control's results off the analyser instead of typing them.
 *
 * It appears only where an analyser is actually attached to the control. What
 * arrived is shown lined up against the control's own parameters BEFORE
 * anything is filled in, and what could not be matched is named rather than
 * quietly dropped — a system that decides column four is MCHC and is wrong has
 * written a false control record with a real name on it.
 */
function AnalyserPanel({ materialId, status, mapping, onStatus, onMapping, onReadings, onError }: {
  materialId: number; status: AnalyserStatus; mapping: AnalyserMapping | null;
  onStatus: (s: AnalyserStatus) => void; onMapping: (m: AnalyserMapping | null) => void;
  onReadings: (rows: AnalyserMapping['readings']) => void; onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const source = status.source!;
  const waiting = status.waiting ?? [];

  const bringIn = useCallback(async (message: AnalyserWaiting) => {
    setBusy(message.id);
    try {
      const next = await api<AnalyserMapping>(`/iqc/materials/${materialId}/analyser/messages/${message.id}/map`);
      onMapping(next);
      onReadings(next.readings);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }, [materialId, onMapping, onReadings, onError]);

  // Pressing Fetch opens the door and waits. An analyser that dials in decides
  // for itself when to transmit, and a button that pretends otherwise is a
  // button people stop believing.
  const listen = useAnalyserListen<AnalyserWaiting>({
    arm: () => armAnalyser(`/iqc/materials/${materialId}/analyser/listen`),
    poll: async since => {
      const next = await api<AnalyserStatus>(`/iqc/materials/${materialId}/analyser?since=${since.control}`);
      return next.waiting ?? [];
    },
    onArrival: async message => {
      await bringIn(message);
      try { onStatus(await api<AnalyserStatus>(`/iqc/materials/${materialId}/analyser`)); } catch { /* the reading is in */ }
    },
  });

  return (
    <div className="iqc-analyser">
      <div className="iqc-analyser-head">
        <span className={`iqc-analyser-dot s-${source.state}`} />
        <strong>{source.name}</strong>
        <span className="muted">
          {source.lastMessageAt
            ? `last heard ${String(source.lastMessageAt).slice(11, 16)}`
            : 'nothing received yet'}
        </span>
        <button type="button" className={`iqc-fetch${listen.waiting ? ' is-waiting' : ''}`}
          onClick={() => (listen.waiting ? listen.stop() : void listen.start())}>
          {listen.waiting
            ? <><Loader2 size={13} className="pd-spin" /> Waiting… {listen.remaining}s</>
            : <><Radio size={13} /> Fetch from analyser</>}
        </button>
      </div>
      {listen.waiting && (
        <p className="iqc-listening">
          <span className="iqc-pulse" />
          Ready. Run the control on the analyser and its results drop straight into the boxes below.
        </p>
      )}
      {!listen.waiting && listen.note && <p className="iqc-hint">{listen.note}</p>}
      {listen.problem && <p className="iqc-note bad">{listen.problem}</p>}

      {/* A link the bridge deliberately never opens will never deliver
          anything. Saying so is the difference between a bench waiting all
          morning and a bench fixing it in a minute. */}
      {!source.open && (
        <p className="iqc-note warn">
          <AlertTriangle size={12} /> Nothing will arrive: this link is one LHIMS owns. Set it to follow the
          LHIMS client&rsquo;s log under Analyser Links to take a copy.
        </p>
      )}
      {source.lastError && <p className="iqc-note bad">{source.lastError}</p>}

      {waiting.length === 0 ? (
        !listen.waiting && <p className="iqc-hint">Nothing waiting. Press Fetch, then send the control from the analyser.</p>
      ) : (
        <ul className="iqc-analyser-list">
          {waiting.map(message => (
            <li key={message.id}>
              <div>
                <strong>{message.sample_id || 'control sample'}</strong>
                <span className="muted">
                  {' · '}{String(message.instrument_run_at ?? message.received_at).slice(5, 16).replace('T', ' ')}
                  {' · '}{message.parsed_values?.length ?? 0} parameters
                </span>
              </div>
              <button type="button" className="pq-link" disabled={busy !== null} onClick={() => void bringIn(message)}>
                {busy === message.id ? <Loader2 size={12} className="pd-spin" /> : <ArrowRight size={12} />} Use these
              </button>
            </li>
          ))}
        </ul>
      )}

      {mapping && (
        <div className="iqc-analyser-map">
          <strong>{mapping.matched} of {mapping.matched + mapping.missingAnalytes.length} parameters filled in.</strong>
          {mapping.unmatchedLabels.length > 0 && (
            <span> The analyser also sent {mapping.unmatchedLabels.join(', ')}, which this control does not measure.</span>
          )}
          {mapping.missingAnalytes.length > 0 && (
            <span> Still to enter: {mapping.missingAnalytes.map(a => a.analyte).join(', ')}.</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------- previously run samples */

/**
 * Which previously tested sample is standing in for the control, and what it
 * originally gave.
 *
 * The register is per control, so a sample enrolled against the haematology
 * control cannot be re-read as if it were the chemistry one. Picking a sample
 * shows the original result and the control run that covered it, because that
 * link is the whole reason this is quality control and not a repeat test.
 */
function RetainedSamplePicker({ material, analytes, samples, sampleId, onPick, enrolling, onEnrolling, equipment, onEnrolled, onError }: {
  material: Material; analytes: Analyte[]; samples: RetainedSample[];
  sampleId: string; onPick: (id: string) => void;
  enrolling: boolean; onEnrolling: (open: boolean) => void;
  equipment: EquipmentItem[];
  onEnrolled: (id: number) => void | Promise<void>; onError: (m: string) => void;
}) {
  const sample = samples.find(s => String(s.id) === sampleId);
  const categorical = material.control_type === 'qualitative' || material.control_type === 'culture_sensitivity';

  return (
    <fieldset className="iqc-step accent">
      <legend><span className="step-n">2b</span> Which previously run sample?</legend>

      <div className="iqc-sample-pick">
        <label>Sample
          <select value={sampleId} onChange={e => onPick(e.target.value)}>
            <option value="">Choose a sample…</option>
            {samples.map(s => (
              <option key={s.id} value={s.id}>
                {s.sample_reference} · first tested {s.original_run_date}
                {s.rerun_count ? ` · re-read ${s.rerun_count}×` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={() => onEnrolling(!enrolling)}>
          {enrolling ? <X size={13} /> : <Plus size={13} />} {enrolling ? 'Close' : 'Add a sample'}
        </button>
      </div>

      {samples.length === 0 && !enrolling && (
        <p className="iqc-note">No sample is on this control&rsquo;s register yet. Add the one you kept, with the result it originally gave.</p>
      )}

      {enrolling && (
        <EnrolRetainedSample material={material} analytes={analytes} equipment={equipment}
          onSaved={onEnrolled} onCancel={() => onEnrolling(false)} onError={onError} />
      )}

      {sample && (
        <div className="iqc-sample-card">
          <div className="iqc-sample-head">
            <strong>{sample.sample_reference}</strong>
            <span className="chip">{sample.sample_code}</span>
            {sample.sample_type && <span className="chip">{sample.sample_type}</span>}
            <span className="chip">{RETAINED_SOURCE_LABELS[(sample.source as never)] ?? sample.source}</span>
          </div>
          <dl className="iqc-sample-trace">
            <div><dt>First tested</dt><dd>{sample.original_run_date}{sample.original_run_time ? ` ${sample.original_run_time}` : ''}</dd></div>
            <div><dt>Instrument</dt><dd>{sample.equipment_name ?? '—'}</dd></div>
            <div><dt>Control run that covered it</dt>
              <dd>
                {sample.original_run_number
                  ? <>{sample.original_run_number} · {sample.original_control_date} · {STATUS_LABEL[sample.original_control_status ?? ''] ?? sample.original_control_status}</>
                  : <span className="iqc-trace-gap">Not linked</span>}
              </dd>
            </div>
            <div><dt>Re-read</dt><dd>{sample.rerun_count ? `${sample.rerun_count} time(s), last ${sample.last_rerun_date}` : 'Not yet'}</dd></div>
          </dl>
          <table className="data-table compact iqc-entry">
            <thead><tr><th>{material.control_type === 'culture_sensitivity' ? 'Agent' : 'Analyte'}</th><th>Original result</th>{!categorical && <th>Allowed difference</th>}</tr></thead>
            <tbody>
              {analytes.map(a => {
                const v = sample.values.find(x => x.iqc_analyte_id === a.id);
                const tol = effectiveTolerance(a, material);
                return (
                  <tr key={a.id}>
                    <td>{a.analyte}{a.unit ? <span className="muted"> ({a.unit})</span> : null}</td>
                    <td>
                      {!v ? <span className="muted">Not recorded</span>
                        : categorical
                          ? (AST_INTERPRETATION_LABELS[(v.original_interpretation ?? '') as never]
                              ?? QUALITATIVE_LABELS[(v.original_qualitative_result ?? '') as QualitativeOutcome]
                              ?? v.original_qualitative_result ?? v.original_interpretation)
                          : v.original_value}
                    </td>
                    {!categorical && <td className="muted">{v ? formatTolerance(tol.kind, tol.value) : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sample.reason && <p className="iqc-note">{sample.reason}</p>}
        </div>
      )}
    </fieldset>
  );
}

/**
 * Putting a sample on the register.
 *
 * Its original result is either typed in from the report it was issued on, or
 * taken off the analyser, which is the same route a control result arrives by.
 * Either way the record names the control run that was in control on the day,
 * so the re-read can be followed back to control material.
 */
function EnrolRetainedSample({ material, analytes, equipment, onSaved, onCancel, onError }: {
  material: Material; analytes: Analyte[]; equipment: EquipmentItem[];
  onSaved: (id: number) => void | Promise<void>; onCancel: () => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    sampleReference: '', sampleType: '',
    originalRunDate: new Date().toISOString().slice(0, 10), originalRunTime: '',
    equipmentId: material.equipment_id ? String(material.equipment_id) : '',
    originalIqcRunId: '', reason: '',
  });
  const [values, setValues] = useState<Record<number, string>>({});
  const [coverage, setCoverage] = useState<CoverageRun[]>([]);
  const [candidates, setCandidates] = useState<FeedCandidate[]>([]);
  // Where the original result came from. Not a choice the bench makes up front
  // any more — it is simply what happened, set by whichever way the numbers
  // actually arrived.
  const [source, setSource] = useState<'entered' | 'instrument'>('entered');
  const [feedMessageId, setFeedMessageId] = useState('');
  const [busy, setBusy] = useState(false);
  const categorical = material.control_type === 'qualitative' || material.control_type === 'culture_sensitivity';

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  useEffect(() => {
    api<CoverageRun[]>(`/iqc/materials/${material.id}/retained-coverage?on=${form.originalRunDate}`)
      .then(setCoverage).catch(() => setCoverage([]));
  }, [material.id, form.originalRunDate]);

  const loadCandidates = useCallback(() => {
    api<FeedCandidate[]>(`/iqc/materials/${material.id}/analyser/patient-samples`)
      .then(setCandidates).catch(() => setCandidates([]));
  }, [material.id]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);

  /** Fill the sample and its original readings from what the analyser sent. */
  const takeFromInstrument = useCallback((message: FeedCandidate) => {
    setFeedMessageId(String(message.id));
    setSource('instrument');
    const next: Record<number, string> = {};
    for (const parsed of message.parsed_values ?? []) {
      const match = analytes.find(a => a.analyte.toLowerCase() === String(parsed.analyte ?? '').toLowerCase());
      if (match && parsed.value !== undefined && parsed.value !== null) next[match.id] = String(parsed.value);
    }
    setValues(next);
    if (message.sample_id) setForm(f => ({ ...f, sampleReference: message.sample_id as string }));
    const at = message.instrument_run_at ?? message.received_at;
    if (at) {
      setForm(f => ({
        ...f,
        originalRunDate: String(at).slice(0, 10),
        originalRunTime: String(at).slice(11, 16),
      }));
    }
  }, [analytes]);

  // Pressing Fetch opens the door and waits, rather than pulling at an analyser
  // that decides for itself when to transmit.
  const listen = useAnalyserListen<FeedCandidate>({
    arm: () => armAnalyser(`/iqc/materials/${material.id}/analyser/listen`),
    poll: since => api<FeedCandidate[]>(`/iqc/materials/${material.id}/analyser/patient-samples?since=${since.patient}`),
    onArrival: message => { takeFromInstrument(message); loadCandidates(); },
  });

  async function save() {
    if (!form.sampleReference.trim()) return onError('Give the laboratory number the sample was reported under.');
    const rows = analytes
      .map(a => ({ analyteId: a.id, raw: values[a.id] }))
      .filter(r => r.raw !== undefined && r.raw !== '')
      .map(r => (categorical
        ? { analyteId: r.analyteId, originalQualitativeResult: r.raw }
        : { analyteId: r.analyteId, originalValue: Number(r.raw) }));
    if (rows.length === 0) return onError('Record what the sample originally gave for at least one parameter.');

    setBusy(true);
    try {
      const r = await api<{ id: number }>('/iqc/retained-samples', {
        method: 'POST',
        body: JSON.stringify({
          iqcMaterialId: material.id, ...form, source,
          feedMessageId: source === 'instrument' ? feedMessageId || undefined : undefined,
          values: rows,
        }),
      });
      await onSaved(r.id);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="iqc-sample-new">
      {/* One way in, not two. The sample number is typed OR the analyser sends
          it; either way the same boxes fill, so nobody has to decide which kind
          of person they are before they can start. */}
      <div className="iqc-source">
        <label>
          <span>Sample number</span>
          <TextField value={form.sampleReference} onValue={v => set('sampleReference', v)}
            placeholder="the number it was reported under" required />
        </label>
        <button type="button" className={`iqc-fetch${listen.waiting ? ' is-waiting' : ''}`}
          onClick={() => (listen.waiting ? listen.stop() : void listen.start())}>
          {listen.waiting
            ? <><Loader2 size={13} className="pd-spin" /> Waiting… {listen.remaining}s</>
            : <><Radio size={13} /> Fetch from analyser</>}
        </button>
        {candidates.length > 0 && (
          <select className="iqc-source-recent" value={feedMessageId}
            onChange={e => {
              const message = candidates.find(c => String(c.id) === e.target.value);
              if (message) takeFromInstrument(message);
            }}>
            <option value="">or one it sent earlier…</option>
            {candidates.map(c => (
              <option key={c.id} value={c.id}>
                {c.sample_id || 'sample'} · {String(c.instrument_run_at ?? c.received_at).slice(5, 16).replace('T', ' ')}
              </option>
            ))}
          </select>
        )}
      </div>
      {listen.waiting && (
        <p className="iqc-listening">
          <span className="iqc-pulse" />
          Ready. Send the sample from the analyser and its results drop in here.
        </p>
      )}
      {!listen.waiting && listen.note && <p className="iqc-hint">{listen.note}</p>}
      {listen.problem && <p className="iqc-note bad">{listen.problem}</p>}
      {source === 'instrument' && <p className="iqc-hint ok"><Check size={12} /> Filled in from the analyser.</p>}

      <div className="iqc-tight-grid">
        <label>Sample type<TextField value={form.sampleType} onValue={v => set('sampleType', v)} placeholder="e.g. EDTA whole blood" /></label>
        <label>First tested<input type="date" value={form.originalRunDate} max={new Date().toISOString().slice(0, 10)} onChange={e => set('originalRunDate', e.target.value)} required /></label>
        <label>Time<input type="time" value={form.originalRunTime} onChange={e => set('originalRunTime', e.target.value)} /></label>
        <label>Instrument<select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}><option value="">—</option>{equipment.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label className={form.originalIqcRunId ? '' : 'is-needed'}>Control run then
          <select value={form.originalIqcRunId} onChange={e => set('originalIqcRunId', e.target.value)}>
            <option value="">—</option>
            {coverage.map(c => (
              <option key={c.id} value={c.id}>
                {c.run_number} · {c.run_date}{c.run_time ? ` ${c.run_time}` : ''} · {STATUS_LABEL[c.status] ?? c.status}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!form.originalIqcRunId && (
        <p className="iqc-hint">Name the control run that covered this sample, or the re-read traces back to nothing.</p>
      )}

      <table className="data-table compact iqc-entry">
        <thead><tr><th>{material.control_type === 'culture_sensitivity' ? 'Agent' : 'Analyte'}</th><th>Result it originally gave</th></tr></thead>
        <tbody>
          {analytes.map(a => (
            <tr key={a.id}>
              <td><strong>{a.analyte}</strong>{a.unit ? <span className="muted"> ({a.unit})</span> : null}</td>
              <td>
                {material.control_type === 'culture_sensitivity' ? (
                  <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                    <option value="">—</option>
                    {AST_INTERPRETATIONS.map(o => <option key={o} value={o}>{AST_INTERPRETATION_LABELS[o]}</option>)}
                  </select>
                ) : material.control_type === 'qualitative' ? (
                  <select value={values[a.id] ?? ''} onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))}>
                    <option value="">—</option>
                    {scaleForOutcome(a.expected_result).map(o => <option key={o} value={o}>{QUALITATIVE_LABELS[o]}</option>)}
                  </select>
                ) : (
                  <input type="number" step="any" value={values[a.id] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [a.id]: e.target.value }))} style={{ width: 120 }} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <label className="stack">Why the sample is being used
        <TextField value={form.reason} onValue={v => set('reason', v)} placeholder="e.g. Control lot finished; replacement not yet delivered" />
      </label>

      <div className="iqc-sample-acts">
        <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Add to the register'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- the verdict */

function RunOutcomePanel({ outcome, retained }: { outcome: RunOutcome; retained: boolean }) {
  return (
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
            {retained && a.deviation != null && (
              <span className="muted">
                {' '}({a.originalValue} → {a.value}
                {a.deviationPercent != null ? `, ${a.deviationPercent > 0 ? '+' : ''}${a.deviationPercent.toFixed(1)}%` : ''})
              </span>
            )}
            {!retained && a.zScore !== null && a.zScore !== undefined && <span className="muted"> (z = {a.zScore.toFixed(2)})</span>}
            <div className="muted">{RULE_MEANING[a.rule!]}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------- review */

function RunReview({ runs, onChanged, canApprove, isAdmin, equipment, staff, onError, onNotice }: {
  runs: Run[]; onChanged: () => void; canApprove: boolean; isAdmin: boolean;
  equipment: EquipmentItem[]; staff: Staff[];
  onError: (m: string) => void; onNotice: (m: string) => void;
}) {
  const { can } = usePermissions();
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
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  };
  const release = async (run: Run, released: boolean) => {
    setBusy(run.id);
    try {
      await api(`/iqc/runs/${run.id}/release`, { method: 'POST', body: JSON.stringify({ released, note: action[run.id] ?? '' }) });
      onChanged();
    } catch (e) { onError(errorText(e)); }
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
                  {r.run_kind === 'retained_sample' && (
                    <span className="chip">Previously run sample{r.retained_sample_reference ? ` · ${r.retained_sample_reference}` : ''}</span>
                  )}
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
                    <TextField placeholder={r.status === 'out_of_control' ? 'What was done about this? (required)' : 'Note (optional)'}
                      value={action[r.id] ?? ''} onValue={nextValue => setAction(a => ({ ...a, [r.id]: nextValue }))} />
                    {can('iqc', 'approve') && <button type="button" disabled={busy === r.id} onClick={() => review(r)}>Sign off</button>}
                    {r.patient_results_released === 0 && (
                      can('iqc', 'approve') && <button type="button" className="secondary" disabled={busy === r.id} onClick={() => release(r, true)}>
                        Release patient results
                      </button>
                    )}
                    {r.patient_results_released === 1 && r.status === 'out_of_control' && (
                      can('iqc', 'approve') && <button type="button" className="danger" disabled={busy === r.id} onClick={() => release(r, false)}>
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
      .catch(e => onError(errorText(e)));
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
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try {
      const out = await api<{ message: string }>(`/iqc/runs/${run.id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
      await onDone(out.message);
    } catch (e) { onError(errorText(e)); }
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
        <label className="stack">Reason
          <TextField as="textarea" rows={2} value={reason} onValue={nextValue => setReason(nextValue)}
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
        <label>Reagent lot<TextField value={meta.reagentLot} onValue={nextValue => setMeta(m => ({ ...m, reagentLot: nextValue }))} /></label>
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
        <TextField as="textarea" rows={2} value={reason} onValue={nextValue => setReason(nextValue)}
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

function ChartTab({ materials, onError, onNotice, canEdit }: {
  materials: Material[]; onError: (m: string) => void;
  onNotice?: (m: string) => void; canEdit?: boolean;
}) {
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
    api<ChartData>(`/iqc/analytes/${analyteId}/chart${q}`).then(setData).catch(e => onError(errorText(e)));
  }, [analyteId, q, onError]);

  const analyteName = analytes.find(a => String(a.id) === analyteId)?.analyte ?? 'chart';

  /**
   * Establish the limits from this laboratory's own runs.
   *
   * `force` is passed only when the analyte already carries an SD somebody
   * entered: recalculating over a human's figure is a deliberate act — after a
   * service, a reagent lot change, a method adjustment — and never something
   * the system should do quietly on their behalf.
   */
  const establish = useCallback(async (force: boolean) => {
    if (!analyteId) return;
    try {
      const outcome = await api<{ changed: boolean; reason: string | null; target: { sd: number | null; n: number | null; days: number | null; basis: string | null } }>(
        `/iqc/analytes/${analyteId}/establish-targets`, { method: 'POST', body: JSON.stringify({ force }) });
      if (outcome.changed) {
        const t = outcome.target;
        onNotice?.(`${analyteName}: SD ${t.sd?.toFixed(4)} established from ${t.n} results over ${t.days} days${t.basis === 'interim' ? ' — interim, until 20 results over 20 days are in' : ''}.`);
        setData(await api<ChartData>(`/iqc/analytes/${analyteId}/chart${q}`));
      } else {
        onError(outcome.reason ?? 'Nothing could be established from the results recorded so far.');
      }
    } catch (e) { onError(errorText(e)); }
  }, [analyteId, analyteName, q, onError, onNotice]);

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

      {/* The runs themselves, as a record — every reading beside the target it
          was measured against, with the chart on the same document. The chart
          answers "is the method behaving"; this answers "what did it read, and
          was that acceptable", which is the question asked at review. */}
      {materialId && (
        <XlsxToolbar
          module="iqc"
          exportName={`Control_runs_${analyteName.replace(/\W+/g, '_')}.xlsx`}
          exportPath={`/iqc/runs/report.xlsx?materialIds=${materialId}${range ? `&${range}` : ''}`}
          printPath={`/iqc/runs/report/print?materialIds=${materialId}&charts=1${range ? `&${range}` : ''}`}
          printLabel="Print the runs, with the chart (PDF)"
          exportOnly
        />
      )}

      {data && (
        <LeveyJenningsChart
          data={data}
          canEstablish={Boolean(canEdit)}
          onEstablish={() => void establish(data.target?.source === 'vendor')}
        />
      )}
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
    catch (err) { onError(errorText(err)); }
  }
  const name = (id: unknown) => materials.find(m => m.id === Number(id))?.material_name ?? '—';

  return (
    <div className="card">
      <div className="section-head"><h3>Lot changes</h3></div>
      {canCreate && (
        <form className="form-grid" onSubmit={submit} style={{ marginBottom: 16 }}>
          <label>Old lot<select value={form.oldIqcMaterialId} onChange={e => setForm(f => ({ ...f, oldIqcMaterialId: e.target.value }))} required><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} · {m.lot_number}</option>)}</select></label>
          <label>New lot<select value={form.newIqcMaterialId} onChange={e => setForm(f => ({ ...f, newIqcMaterialId: e.target.value }))} required><option value="">—</option>{materials.map(m => <option key={m.id} value={m.id}>{m.material_name} · {m.lot_number}</option>)}</select></label>
          <label>Change date<input type="date" value={form.changeDate} onChange={e => setForm(f => ({ ...f, changeDate: e.target.value }))} required /></label>
          <label>Reason<TextField value={form.reason} onValue={nextValue => setForm(f => ({ ...f, reason: nextValue }))} placeholder="e.g. Previous lot exhausted" /></label>
          <label className="stack">Parallel-run verification<TextField as="textarea" value={form.verificationSummary} onValue={nextValue => setForm(f => ({ ...f, verificationSummary: nextValue }))} rows={2} placeholder="How the new lot's targets were established against the old." /></label>
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
