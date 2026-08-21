import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { DetailModal, EmptyState } from '../../components/ui';
import { api } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { PrintButton, ScaleLegend, badgeFor, labelise } from './competencyShared';
import {
  APPRAISAL_SCALE_5, APPRAISAL_SECTIONS, APPRAISAL_SECTION_HINTS, APPRAISAL_SECTION_LABELS,
  APPRAISAL_CYCLE_STATUSES, APPRAISAL_CYCLE_TYPES,
} from '../../../shared/constants/competency';
import type { AppraisalCycle, AppraisalTemplate, Department, Section, Staff } from '../../../shared/types/api';

/**
 * Appraisal setup — the template and the cycle.
 *
 * The template settles what everybody in a job is asked about and how much
 * each answer counts, so two appraisers rating two people in the same post are
 * answering the same questions. The cycle settles when: one period, one
 * template, one closing date, and a register that shows who is outstanding
 * rather than each appraisal being an isolated event.
 */

const emptyTemplate = {
  title: '', appliesTo: 'all_staff', cadre: '', versionLabel: '1.0', description: '',
  maxScore: '5', selfAssessmentRequired: true, secondLevelReviewRequired: true,
  objectivesRequired: true, effectiveDate: '', nextReviewDate: '',
};

const emptyCycle = {
  cycleName: '', cycleType: 'annual', periodStart: '', periodEnd: '', templateId: '',
  selfAssessmentDue: '', appraisalDue: '', sectionId: '', departmentId: '', notes: '',
};

export default function AppraisalSetup({ staff, sections, departments, onChanged }: {
  staff: Staff[];
  sections: Section[];
  departments: Department[];
  onChanged?: () => void;
}) {
  const { can } = usePermissions();
  const mayCreate = can('personnel.appraisals', 'create');
  const mayEdit = can('personnel.appraisals', 'edit');
  const mayApprove = can('personnel.appraisals', 'approve');
  const mayArchive = can('personnel.appraisals', 'void_archive');

  const [templates, setTemplates] = useState<AppraisalTemplate[]>([]);
  const [cycles, setCycles] = useState<AppraisalCycle[]>([]);
  const [openTemplate, setOpenTemplate] = useState<AppraisalTemplate | null>(null);
  const [openCycle, setOpenCycle] = useState<AppraisalCycle | null>(null);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [creatingCycle, setCreatingCycle] = useState(false);
  const [templateForm, setTemplateForm] = useState(emptyTemplate);
  const [cycleForm, setCycleForm] = useState(emptyCycle);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([
        api<AppraisalTemplate[]>('/personnel/appraisal-templates'),
        api<AppraisalCycle[]>('/personnel/appraisal-cycles'),
      ]);
      setTemplates(t); setCycles(c);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reopenTemplate = useCallback(async (id: number) => {
    try { setOpenTemplate(await api<AppraisalTemplate>(`/personnel/appraisal-templates/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }, []);

  async function submitTemplate(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      const created = await api<{ id: number }>('/personnel/appraisal-templates', { method: 'POST', body: JSON.stringify(templateForm) });
      setTemplateForm(emptyTemplate); setCreatingTemplate(false);
      await load(); onChanged?.();
      await reopenTemplate(created.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitCycle(event: FormEvent) {
    event.preventDefault(); setError(null);
    try {
      await api('/personnel/appraisal-cycles', { method: 'POST', body: JSON.stringify(cycleForm) });
      setCycleForm(emptyCycle); setCreatingCycle(false);
      await load(); onChanged?.();
    } catch (e) { setError((e as Error).message); }
  }

  async function templateStatus(id: number, status: string) {
    setError(null);
    try {
      await api(`/personnel/appraisal-templates/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      await load(); onChanged?.();
      if (openTemplate?.id === id) await reopenTemplate(id);
    } catch (e) { setError((e as Error).message); }
  }

  async function cycleStatus(id: number, status: string, force = false) {
    setError(null);
    try {
      await api(`/personnel/appraisal-cycles/${id}/status`, { method: 'POST', body: JSON.stringify({ status, force }) });
      await load(); onChanged?.();
      if (openCycle?.id === id) setOpenCycle(c => c && { ...c, status });
    } catch (e) { setError((e as Error).message); }
  }

  const activeTemplates = templates.filter(t => t.status === 'active');

  return <div className="appraisal-setup">
    {error && <div className="error">{error}</div>}

    {/* ── Cycles ── */}
    <div className="workspace-head">
      <div>
        <h3>Appraisal cycles</h3>
        <p className="muted">One period, one template, one closing date. Opening a cycle raises an appraisal for everybody in scope, so nobody is missed and the register shows who is outstanding.</p>
      </div>
      {mayCreate && <div className="workspace-actions">
        <button type="button" onClick={() => setCreatingCycle(v => !v)}>
          <Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New cycle
        </button>
      </div>}
    </div>

    {creatingCycle && mayCreate && <form className="form-grid" onSubmit={submitCycle}>
      <label>Cycle name<input value={cycleForm.cycleName} onChange={e => setCycleForm({ ...cycleForm, cycleName: e.target.value })} required placeholder="e.g. 2026 annual review" /></label>
      <label>Type
        <select value={cycleForm.cycleType} onChange={e => setCycleForm({ ...cycleForm, cycleType: e.target.value })}>
          {APPRAISAL_CYCLE_TYPES.map(t => <option key={t} value={t}>{labelise(t)}</option>)}
        </select>
      </label>
      <label>Period start<input type="date" value={cycleForm.periodStart} onChange={e => setCycleForm({ ...cycleForm, periodStart: e.target.value })} required /></label>
      <label>Period end<input type="date" value={cycleForm.periodEnd} onChange={e => setCycleForm({ ...cycleForm, periodEnd: e.target.value })} required /></label>
      <label>Template
        <select value={cycleForm.templateId} onChange={e => setCycleForm({ ...cycleForm, templateId: e.target.value })} required>
          <option value="">—</option>
          {activeTemplates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
        {activeTemplates.length === 0 && <small className="field-hint">No active template yet — create and activate one below.</small>}
      </label>
      <label>Self-assessment due<input type="date" value={cycleForm.selfAssessmentDue} onChange={e => setCycleForm({ ...cycleForm, selfAssessmentDue: e.target.value })} /></label>
      <label>Appraisals due<input type="date" value={cycleForm.appraisalDue} onChange={e => setCycleForm({ ...cycleForm, appraisalDue: e.target.value })} /></label>
      <label>Scope
        <select value={cycleForm.sectionId} onChange={e => setCycleForm({ ...cycleForm, sectionId: e.target.value })}>
          <option value="">Whole laboratory</option>
          {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>Department
        <select value={cycleForm.departmentId} onChange={e => setCycleForm({ ...cycleForm, departmentId: e.target.value })}>
          <option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      <label className="wide">Notes<textarea rows={2} value={cycleForm.notes} onChange={e => setCycleForm({ ...cycleForm, notes: e.target.value })} /></label>
      <button type="submit">Create cycle</button>
    </form>}

    {cycles.length === 0
      ? <EmptyState title="No appraisal cycles" message="A cycle groups a round of appraisals into one period so completion can be tracked." />
      : <table className="data-table">
        <thead><tr><th>Cycle</th><th>Type</th><th>Period</th><th>Template</th><th>Scope</th><th>Progress</th><th>Status</th><th /></tr></thead>
        <tbody>
          {cycles.map(c => <tr key={c.id} className="row-click" onClick={() => setOpenCycle(c)}>
            <td>{c.cycle_name}</td>
            <td>{labelise(c.cycle_type)}</td>
            <td>{c.period_start} → {c.period_end}</td>
            <td>{c.template_title || '—'}</td>
            <td>{c.section_name || 'Whole laboratory'}</td>
            <td>{c.appraisals_completed ?? 0} of {c.appraisals_raised ?? 0} complete</td>
            <td>{badgeFor(c.status)}</td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => setOpenCycle(c)}>Open</button></td>
          </tr>)}
        </tbody>
      </table>}

    {/* ── Templates ── */}
    <div className="workspace-head" style={{ marginTop: 26 }}>
      <div>
        <h3>Appraisal templates</h3>
        <p className="muted">What everybody in a job is asked about, and how much each answer counts towards the overall figure.</p>
      </div>
      {mayCreate && <div className="workspace-actions">
        <button type="button" onClick={() => setCreatingTemplate(v => !v)}>
          <Plus size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />New template
        </button>
      </div>}
    </div>

    {creatingTemplate && mayCreate && <form className="form-grid" onSubmit={submitTemplate}>
      <label>Title<input value={templateForm.title} onChange={e => setTemplateForm({ ...templateForm, title: e.target.value })} required placeholder="e.g. Annual appraisal — laboratory scientists" /></label>
      <label>Applies to<input value={templateForm.appliesTo} onChange={e => setTemplateForm({ ...templateForm, appliesTo: e.target.value })} placeholder="all_staff" /></label>
      <label>Cadre<input value={templateForm.cadre} onChange={e => setTemplateForm({ ...templateForm, cadre: e.target.value })} placeholder="e.g. Scientist" /></label>
      <label>Version<input value={templateForm.versionLabel} onChange={e => setTemplateForm({ ...templateForm, versionLabel: e.target.value })} /></label>
      <label>Top of rating scale
        <select value={templateForm.maxScore} onChange={e => setTemplateForm({ ...templateForm, maxScore: e.target.value })}>
          <option value="5">5-point</option><option value="4">4-point</option><option value="3">3-point</option>
        </select>
      </label>
      <label>Effective from<input type="date" value={templateForm.effectiveDate} onChange={e => setTemplateForm({ ...templateForm, effectiveDate: e.target.value })} /></label>
      <label className="check-inline"><input type="checkbox" checked={templateForm.selfAssessmentRequired} onChange={e => setTemplateForm({ ...templateForm, selfAssessmentRequired: e.target.checked })} /> The member of staff rates themselves first</label>
      <label className="check-inline"><input type="checkbox" checked={templateForm.secondLevelReviewRequired} onChange={e => setTemplateForm({ ...templateForm, secondLevelReviewRequired: e.target.checked })} /> A second-level reviewer moderates before the record closes</label>
      <label className="check-inline"><input type="checkbox" checked={templateForm.objectivesRequired} onChange={e => setTemplateForm({ ...templateForm, objectivesRequired: e.target.checked })} /> Objectives are agreed for the period ahead</label>
      <label className="wide">Description<textarea rows={2} value={templateForm.description} onChange={e => setTemplateForm({ ...templateForm, description: e.target.value })} /></label>
      <button type="submit">Create template</button>
    </form>}

    {templates.length === 0
      ? <EmptyState title="No appraisal templates" message="A template settles the questions and their weights so appraisals stay comparable between people and between years." />
      : <table className="data-table">
        <thead><tr><th>Code</th><th>Template</th><th>Applies to</th><th>Items</th><th>Scale</th><th>Workflow</th><th>Status</th><th /></tr></thead>
        <tbody>
          {templates.map(t => <tr key={t.id} className="row-click" onClick={() => void reopenTemplate(t.id)}>
            <td>{t.template_code}</td>
            <td>{t.title}<br /><small className="muted">v{t.version_label}{t.appraisal_count ? ` · ${t.appraisal_count} appraisal(s) raised` : ''}</small></td>
            <td>{labelise(t.applies_to)}{t.cadre ? ` · ${t.cadre}` : ''}</td>
            <td>{t.item_count ?? 0}</td>
            <td>1 – {t.max_score}</td>
            <td><small>{[t.self_assessment_required ? 'Self-assessment' : null, t.second_level_review_required ? 'Moderated' : null, t.objectives_required ? 'Objectives' : null].filter(Boolean).join(' · ') || 'Appraiser only'}</small></td>
            <td>{badgeFor(t.status)}</td>
            <td onClick={e => e.stopPropagation()}><button type="button" className="secondary" onClick={() => void reopenTemplate(t.id)}>Open</button></td>
          </tr>)}
        </tbody>
      </table>}

    {openTemplate && <TemplateEditor
      template={openTemplate}
      mayEdit={mayEdit}
      mayCreate={mayCreate}
      mayApprove={mayApprove}
      mayArchive={mayArchive}
      onClose={() => setOpenTemplate(null)}
      onReload={() => reopenTemplate(openTemplate.id)}
      onListChanged={() => { void load(); onChanged?.(); }}
      onStatus={templateStatus}
    />}

    {openCycle && <CycleDetail
      cycle={openCycle}
      staff={staff}
      templates={templates}
      mayCreate={mayCreate}
      mayApprove={mayApprove}
      onClose={() => setOpenCycle(null)}
      onChanged={() => { void load(); onChanged?.(); }}
      onStatus={cycleStatus}
    />}
  </div>;
}

/* ── Template editor ────────────────────────────────────────────────────── */

function TemplateEditor({ template, mayEdit, mayCreate, mayApprove, mayArchive, onClose, onReload, onListChanged, onStatus }: {
  template: AppraisalTemplate;
  mayEdit: boolean;
  mayCreate: boolean;
  mayApprove: boolean;
  mayArchive: boolean;
  onClose: () => void;
  onReload: () => Promise<void>;
  onListChanged: () => void;
  onStatus: (id: number, status: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState({ section: 'delivery', itemTitle: '', itemDescription: '', successMeasure: '', weight: '1' });
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const items = template.items ?? [];
  const editable = mayEdit && template.status === 'draft';
  const base = `/personnel/appraisal-templates/${template.id}`;
  const totalWeight = items.filter(i => i.is_active).reduce((sum, i) => sum + (Number(i.weight) || 0), 0);

  const refresh = async () => { await onReload(); onListChanged(); };

  async function addItem(section: string) {
    if (!item.itemTitle.trim()) { setError('An item title is required.'); return; }
    setError(null);
    try {
      await api(`${base}/items`, { method: 'POST', body: JSON.stringify({ ...item, section }) });
      setItem({ section, itemTitle: '', itemDescription: '', successMeasure: '', weight: '1' });
      setAddingTo(null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
  }

  async function removeItem(id: number) {
    setError(null);
    try { await api(`${base}/items/${id}`, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError((e as Error).message); }
  }

  async function duplicate() {
    setError(null);
    try { await api(`${base}/duplicate`, { method: 'POST', body: JSON.stringify({}) }); onListChanged(); onClose(); }
    catch (e) { setError((e as Error).message); }
  }

  async function remove() {
    setError(null);
    try { await api(base, { method: 'DELETE' }); onListChanged(); onClose(); }
    catch (e) { setError((e as Error).message); }
  }

  return <DetailModal
    open
    onClose={onClose}
    width="wide"
    title={<>{template.template_code} — {template.title}</>}
    subtitle={<>v{template.version_label} · {items.length} item(s) · total weight {totalWeight}</>}
    header={<>
      {badgeFor(template.status)}
      <PrintButton path={`${base}/print`} label="Print blank form" />
    </>}
    footer={<div className="modal-foot-row">
      <div className="foot-left">
        {template.status === 'draft' && mayApprove && <button type="button" onClick={() => void onStatus(template.id, 'active')}>Activate template</button>}
        {template.status === 'active' && mayApprove && <button type="button" className="secondary" onClick={() => void onStatus(template.id, 'archived')}>Archive</button>}
        {template.status === 'archived' && mayApprove && <button type="button" className="secondary" onClick={() => void onStatus(template.id, 'draft')}>Return to draft</button>}
        {mayCreate && <button type="button" className="secondary" onClick={() => void duplicate()}>
          <Copy size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />New version
        </button>}
      </div>
      {mayArchive && !(template.appraisals_raised ?? 0) && <button type="button" className="secondary danger-text" onClick={() => void remove()}>Delete</button>}
    </div>}
  >
    {error && <div className="error">{error}</div>}
    {template.status === 'active' && <p className="notice-ok">
      This template is in force. To change what it asks, take a new version — the appraisals already raised from this one keep the questions they were answered against.
    </p>}
    {template.description && <p className="muted">{template.description}</p>}
    <ScaleLegend scale={APPRAISAL_SCALE_5} max={template.max_score} />

    {APPRAISAL_SECTIONS.map(section => {
      const rows = items.filter(i => i.section === section);
      const sectionWeight = rows.reduce((sum, r) => sum + (Number(r.weight) || 0), 0);
      return <section key={section} className="element-group">
        <header>
          <span className="eg-title">{APPRAISAL_SECTION_LABELS[section]}</span>
          <span className="muted"> · {rows.length} item(s){totalWeight > 0 ? ` · ${Math.round((sectionWeight / totalWeight) * 100)}% of the overall figure` : ''}</span>
          {editable && <div className="eg-actions">
            <button type="button" className="secondary" onClick={() => { setItem({ ...item, section }); setAddingTo(section); }}>
              <Plus size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />Item
            </button>
          </div>}
        </header>
        <p className="muted eg-desc">{APPRAISAL_SECTION_HINTS[section]}</p>
        {rows.length > 0 && <table className="data-table">
          <thead><tr><th style={{ width: '4%' }}>#</th><th>Assessed item</th><th style={{ width: '30%' }}>How success is measured</th><th style={{ width: '8%' }}>Weight</th>{editable && <th style={{ width: '5%' }} />}</tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={row.id}>
              <td>{index + 1}</td>
              <td><strong>{row.item_title}</strong>{row.item_description && <><br /><small className="muted">{row.item_description}</small></>}</td>
              <td><small>{row.success_measure || '—'}</small></td>
              <td>{row.weight}</td>
              {editable && <td><button type="button" className="link-button danger" onClick={() => void removeItem(row.id)} aria-label="Remove item"><Trash2 size={14} /></button></td>}
            </tr>)}
          </tbody>
        </table>}
        {addingTo === section && <div className="element-add">
          <label className="wide">Item<input autoFocus value={item.itemTitle} onChange={e => setItem({ ...item, itemTitle: e.target.value })} placeholder="What is being assessed" /></label>
          <label className="wide">Description<textarea rows={2} value={item.itemDescription} onChange={e => setItem({ ...item, itemDescription: e.target.value })} /></label>
          <label className="wide">How success is measured<input value={item.successMeasure} onChange={e => setItem({ ...item, successMeasure: e.target.value })} placeholder="The evidence an appraiser looks for" /></label>
          <label>Weight<input type="number" min={0.5} step="0.5" value={item.weight} onChange={e => setItem({ ...item, weight: e.target.value })} /></label>
          <div className="element-add-actions">
            <button type="button" onClick={() => void addItem(section)}>Add item</button>
            <button type="button" className="secondary" onClick={() => setAddingTo(null)}>Cancel</button>
          </div>
        </div>}
      </section>;
    })}
  </DetailModal>;
}

/* ── Cycle detail ───────────────────────────────────────────────────────── */

function CycleDetail({ cycle, staff, templates, mayCreate, mayApprove, onClose, onChanged, onStatus }: {
  cycle: AppraisalCycle;
  staff: Staff[];
  templates: AppraisalTemplate[];
  mayCreate: boolean;
  mayApprove: boolean;
  onClose: () => void;
  onChanged: () => void;
  onStatus: (id: number, status: string, force?: boolean) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [raise, setRaise] = useState({ appraiserStaffId: '', reviewerStaffId: '', appraisalDate: cycle.period_end });
  const [selectedStaff, setSelectedStaff] = useState<number[]>([]);
  const template = templates.find(t => t.id === cycle.template_id);

  async function doRaise() {
    setError(null); setNotice(null);
    try {
      const result = await api<{ created: number; skipped: string[] }>(`/personnel/appraisal-cycles/${cycle.id}/raise`, {
        method: 'POST',
        body: JSON.stringify({ ...raise, staffIds: selectedStaff.length ? selectedStaff : undefined }),
      });
      setNotice(`${result.created} appraisal(s) raised${result.skipped.length ? `; ${result.skipped.length} already had one in this cycle.` : '.'}`);
      setSelectedStaff([]);
      onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  return <DetailModal
    open
    onClose={onClose}
    width="wide"
    title={cycle.cycle_name}
    subtitle={<>{labelise(cycle.cycle_type)} · {cycle.period_start} → {cycle.period_end} · {cycle.section_name || 'Whole laboratory'}</>}
    header={<>
      {badgeFor(cycle.status)}
      <PrintButton path={`/personnel/appraisal-cycles/${cycle.id}/print`} label="Print cycle summary" />
    </>}
    footer={mayApprove ? <div className="modal-foot-row">
      <div className="foot-left">
        {cycle.status === 'planned' && <button type="button" onClick={() => void onStatus(cycle.id, 'open')}>Open the cycle</button>}
        {cycle.status === 'open' && <button type="button" className="secondary" onClick={() => void onStatus(cycle.id, 'in_review')}>Move to review</button>}
        {cycle.status !== 'closed' && <button type="button" className="secondary" onClick={() => void onStatus(cycle.id, 'closed')}>Close the cycle</button>}
        {cycle.status === 'closed' && <button type="button" className="secondary" onClick={() => void onStatus(cycle.id, 'open')}>Reopen</button>}
      </div>
    </div> : undefined}
  >
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice-ok">{notice}</div>}

    <dl className="record-facts">
      <div><dt>Template</dt><dd>{cycle.template_title || 'Not set'}</dd></div>
      <div><dt>Self-assessment due</dt><dd>{cycle.self_assessment_due || '—'}</dd></div>
      <div><dt>Appraisals due</dt><dd>{cycle.appraisal_due || '—'}</dd></div>
      <div><dt>Raised</dt><dd>{cycle.appraisals_raised ?? 0}</dd></div>
      <div><dt>Completed</dt><dd>{cycle.appraisals_completed ?? 0}</dd></div>
      <div><dt>Opened</dt><dd>{cycle.opened_at ? String(cycle.opened_at).slice(0, 10) : '—'}</dd></div>
      {cycle.notes && <div className="wide"><dt>Notes</dt><dd className="prewrap">{cycle.notes}</dd></div>}
    </dl>

    {mayCreate && cycle.status !== 'closed' && <section className="signoff-card">
      <h4>Raise appraisals</h4>
      <p className="muted">
        {template
          ? <>Creates an appraisal from <strong>{template.title}</strong> for everybody in scope who does not already have one in this cycle{template.self_assessment_required ? ', starting with the member of staff for their self-assessment' : ''}.</>
          : <>Set a template on this cycle before raising appraisals from it.</>}
      </p>
      <div className="form-grid">
        <label>Appraiser for all
          <select value={raise.appraiserStaffId} onChange={e => setRaise({ ...raise, appraiserStaffId: e.target.value })}>
            <option value="">Me</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Second-level reviewer
          <select value={raise.reviewerStaffId} onChange={e => setRaise({ ...raise, reviewerStaffId: e.target.value })}>
            <option value="">Decide later</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <label>Appraisal date<input type="date" value={raise.appraisalDate} onChange={e => setRaise({ ...raise, appraisalDate: e.target.value })} /></label>
      </div>
      <details className="staff-picker">
        <summary>{selectedStaff.length ? `${selectedStaff.length} member(s) of staff chosen` : 'Everybody in scope — choose specific people instead'}</summary>
        <div className="chip-select">
          {staff.map(s => {
            const on = selectedStaff.includes(s.id);
            return <label key={s.id} className={`pick${on ? ' on' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => setSelectedStaff(list => on ? list.filter(id => id !== s.id) : [...list, s.id])} />
              {s.fullName}
            </label>;
          })}
        </div>
        {selectedStaff.length > 0 && <button type="button" className="link-button" onClick={() => setSelectedStaff([])}>Clear and use the whole scope</button>}
      </details>
      <button type="button" disabled={!template} onClick={() => void doRaise()}>
        {selectedStaff.length ? `Raise ${selectedStaff.length} appraisal(s)` : 'Raise appraisals for everybody in scope'}
      </button>
    </section>}

    {cycle.status === 'closed' && <p className="notice-warn">This cycle is closed. Reopen it to raise or change appraisals within it.</p>}

    <p className="muted">Cycle status: {APPRAISAL_CYCLE_STATUSES.map(s => labelise(s)).join(' → ')}.</p>
  </DetailModal>;
}
