import { FormEvent, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, AlertTriangle, MessageSquare } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, CHART_COLORS, ModuleAlerts, DetailModal, NumberField, RegisterSearch } from '../components/ui';
import { useCappedRows } from '../hooks/useCappedRows';
import { api } from '../services/api';
import { useModules } from '../hooks/useModules';
import { usePermissions } from '../hooks/usePermissions';
import DisabledModule from '../components/DisabledModule';
import { useTabParam } from '../hooks/useTabParam';
import PermissionTabs from '../components/PermissionTabs';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { formatBadge, useLookupData, type ComplaintDetail, type LoadState } from './qmsShared';
import {
  COMPLAINT_STAGES, STAGE_LABELS, STAGE_NEXT_ACTION, COMPLAINT_SEVERITIES, SEVERITY_LABELS,
  CONTACT_METHODS, COMPLAINANT_TYPES, COMPLAINT_CATEGORIES, COMPLAINT_OUTCOMES, OUTCOME_LABELS,
  isOverdue, type ComplaintTargets,
} from '../../shared/constants/complaints';
import type { ComplaintRecord } from '../../shared/types/api';
import TextField from '../components/ui/TextField';
import { Notice } from '../components/ui/Feedback';

/* ============================================================================
   COMPLAINTS — ISO 15189:2022 §7.4

   The clause asks for a process, not a text box. A laboratory must receive and
   evaluate the complaint, acknowledge receipt, keep a record of what was done
   about it, have the decision made or reviewed by people NOT involved in the
   activity complained about, and formally tell the complainant when handling
   has ended.

   So this screen is that sequence. Each stage names the one thing the
   laboratory owes next, the record carries the dates it is working to, and the
   server refuses the steps that would skip a requirement — a complaint cannot
   be closed unreviewed, and the investigator cannot review their own work.
   ========================================================================= */

const COMPLAINT_TABS = ['Dashboard', 'Complaints Register', 'Log a complaint', 'Process targets'];

/** Where a complaint has got to, drawn as the path it has to walk. */
function StageTrail({ stage }: { stage: string }) {
  if (stage === 'withdrawn') {
    return <div className="cx-trail"><span className="cx-step done"><CheckCircle2 size={14} /> Withdrawn</span></div>;
  }
  const at = COMPLAINT_STAGES.indexOf(stage as never);
  return <div className="cx-trail">
    {COMPLAINT_STAGES.map((s, i) => (
      <span key={s} className={`cx-step${i < at ? ' done' : i === at ? ' now' : ''}`}>
        {i < at ? <CheckCircle2 size={14} /> : <Circle size={14} />} {STAGE_LABELS[s]}
      </span>
    ))}
  </div>;
}

const dateOnly = (v?: string | null) => (v ? String(v).slice(0, 10) : '—');

export function ComplaintsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { isEnabled } = useModules();
  const { can } = usePermissions();
  const { staff, sections } = useLookupData();
  const [tab, setTab] = useState(embedded ? 'Complaints Register' : 'Dashboard');
  const [complaints, setComplaints] = useState<ComplaintRecord[]>([]);
  useFocusTarget(complaints);
  const [selected, setSelected] = useState<ComplaintDetail | null>(null);
  const [targets, setTargets] = useState<ComplaintTargets>({ acknowledgeDays: 3, resolveDays: 30 });
  const [loadState, setLoadState] = useState<LoadState>({ loading: false, error: null });
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const blank = {
    receivedDate: new Date().toISOString().slice(0, 10), source: '', complainantType: '', complainantName: '',
    contact: '', sectionId: '', category: '', title: '', description: '', severity: 'moderate',
    patientAffected: false, assignedToStaffId: '',
  };
  const [form, setForm] = useState(blank);
  // Each step of the workflow has its own small form; they never share a field,
  // so an unsaved acknowledgement cannot end up in a closure summary.
  const [ack, setAck] = useState({ method: '', note: '' });
  const [inv, setInv] = useState({ investigationSummary: '', rootCause: '', correction: '' });
  const [rev, setRev] = useState({ outcome: '', reviewedByStaffId: '', notes: '' });
  const [out, setOut] = useState({ method: '', summary: '' });
  const [closure, setClosure] = useState('');
  const [withdrawal, setWithdrawal] = useState('');

  useEffect(() => { if (!embedded && !isEnabled('complaints')) return; void load(); }, [isEnabled]);

  async function load() {
    setLoadState({ loading: true, error: null });
    try {
      setComplaints(await api<ComplaintRecord[]>('/complaints'));
      setTargets(await api<ComplaintTargets>('/complaints/config/targets'));
    } catch (error) { setLoadState({ loading: false, error: (error as Error).message }); return; }
    setLoadState({ loading: false, error: null });
  }

  async function open(id: number) {
    try {
      const d = await api<ComplaintDetail>(`/complaints/${id}`);
      setSelected(d);
      setInv({ investigationSummary: d.investigation_summary ?? '', rootCause: d.root_cause ?? '', correction: d.correction ?? '' });
      setAck({ method: '', note: '' }); setRev({ outcome: '', reviewedByStaffId: '', notes: '' });
      setOut({ method: '', summary: '' }); setClosure(''); setWithdrawal('');
      setLoadState({ loading: false, error: null });
    } catch (error) { setLoadState({ loading: false, error: (error as Error).message }); }
  }

  /** Every workflow step goes through here, so one place reports and reloads. */
  async function step(label: string, path: string, body: unknown, done: string) {
    if (!selected) return;
    setBusy(label); setLoadState({ loading: false, error: null }); setNotice(null);
    try {
      await api(`/complaints/${selected.id}${path}`, { method: 'POST', body: JSON.stringify(body) });
      setNotice(done);
      await load();
      await open(selected.id);
    } catch (error) { setLoadState({ loading: false, error: (error as Error).message }); }
    finally { setBusy(null); }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoadState({ loading: true, error: null }); setNotice(null);
    try {
      const r = await api<{ id: number; complaintNumber: string; acknowledgementDueDate: string }>('/complaints', {
        method: 'POST', body: JSON.stringify(form),
      });
      setForm(blank);
      setNotice(`${r.complaintNumber} logged. Acknowledge receipt to the complainant by ${r.acknowledgementDueDate}.`);
      await load();
      setTab('Complaints Register');
      await open(r.id);
    } catch (error) { setLoadState({ loading: false, error: (error as Error).message }); return; }
    setLoadState({ loading: false, error: null });
  }

  async function saveTargets(e: FormEvent) {
    e.preventDefault();
    setBusy('targets'); setNotice(null);
    try {
      setTargets(await api<ComplaintTargets>('/complaints/config/targets', { method: 'PUT', body: JSON.stringify(targets) }));
      setNotice('Targets saved. New complaints will be dated against them.');
    } catch (error) { setLoadState({ loading: false, error: (error as Error).message }); }
    finally { setBusy(null); }
  }

  const stageOf = (c: ComplaintRecord) => c.stage || 'received';
  const openOnes = complaints.filter(c => !['closed', 'withdrawn'].includes(stageOf(c)));
  const ackOverdue = openOnes.filter(c => isOverdue(c.acknowledgement_due_date, c.acknowledged_at));
  const resOverdue = openOnes.filter(c => isOverdue(c.resolution_due_date, c.closed_at));

  const filtered = useMemo(() => complaints.filter(c => {
    const term = search.toLowerCase();
    const matches = !term || [c.complaint_number, c.title, c.description, c.complainant_name, c.category]
      .some(v => v?.toLowerCase().includes(term));
    return matches && (!stageFilter || stageOf(c) === stageFilter);
  }), [complaints, search, stageFilter]);
  const page = useCappedRows(filtered);

  const staffName = (id?: number | null) => staff.find(s => s.id === id)?.fullName ?? (id ? `Staff #${id}` : '—');

  if (!embedded && !isEnabled('complaints')) return <DisabledModule />;

  const stage = selected ? stageOf(selected) : '';
  const mayEdit = can('complaints', 'edit');
  const mayApprove = can('complaints', 'approve');
  const mayClose = can('complaints', 'void_archive');

  return <div>
    {!embedded && <PageHeader eyebrow="Customer Focus" title="Complaints"
      subtitle="Receive, acknowledge, investigate, review and answer — ISO 15189 §7.4." />}
    <PermissionTabs moduleKey="complaints" tabs={COMPLAINT_TABS.filter(n => !embedded || n !== 'Dashboard')} active={tab} onChange={setTab} />
    {loadState.error && <Notice kind="error">{loadState.error}</Notice>}
    {notice && <Notice kind="success">{notice}</Notice>}

    {tab === 'Dashboard' && <><ModuleAlerts moduleKey="complaints" /><KpiStrip items={[
      { label: 'Open', value: openOnes.length, onClick: () => { setStageFilter(''); setTab('Complaints Register'); } },
      { label: 'Awaiting acknowledgement', value: openOnes.filter(c => !c.acknowledged_at).length, tone: ackOverdue.length ? 'warning' : undefined, onClick: () => { setStageFilter('received'); setTab('Complaints Register'); } },
      { label: 'Acknowledgement overdue', value: ackOverdue.length, tone: 'danger', onClick: () => { setStageFilter('received'); setTab('Complaints Register'); } },
      { label: 'Awaiting review', value: complaints.filter(c => stageOf(c) === 'awaiting_review').length, onClick: () => { setStageFilter('awaiting_review'); setTab('Complaints Register'); } },
      { label: 'Past the resolution target', value: resOverdue.length, tone: 'danger', onClick: () => { setStageFilter(''); setTab('Complaints Register'); } },
      { label: 'Closed', value: complaints.filter(c => stageOf(c) === 'closed').length, onClick: () => { setStageFilter('closed'); setTab('Complaints Register'); } },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Where complaints are" subtitle="Across the handling process">
        <DonutChart centerLabel="Total" data={COMPLAINT_STAGES.map((s, i) => ({
          label: STAGE_LABELS[s], value: complaints.filter(c => stageOf(c) === s).length, color: CHART_COLORS[i % CHART_COLORS.length],
        })).filter(d => d.value > 0)} />
      </ChartCard>
      <ChartCard title="What was decided" subtitle="Outcome of complaints that reached a decision">
        <BarMeter data={COMPLAINT_OUTCOMES.map((o, i) => ({
          label: OUTCOME_LABELS[o].split(' — ')[0], value: complaints.filter(c => c.outcome === o).length, color: CHART_COLORS[i % CHART_COLORS.length],
        }))} />
      </ChartCard>
    </div></>}

    {tab === 'Complaints Register' && <div className="card">
      <div className="reg-filters">
        <RegisterSearch onQuery={setSearch} placeholder="Search number, title, complainant…" />
        <label className="inline">Stage
          <select value={stageFilter} onChange={e => setStageFilter(e.target.value)}>
            <option value="">All</option>
            {[...COMPLAINT_STAGES, 'withdrawn'].map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </label>
        <span className="muted">{filtered.length} of {complaints.length}</span>
      </div>
      <div className="table-scroll">
        <table className="data-table"><thead><tr>
          <th>Complaint</th><th>Complainant</th><th>Stage</th><th>Acknowledged</th><th>Due</th><th>Outcome</th><th></th>
        </tr></thead><tbody>
          {page.shown.map(c => {
            const lateAck = isOverdue(c.acknowledgement_due_date, c.acknowledged_at);
            const lateRes = isOverdue(c.resolution_due_date, c.closed_at);
            return <tr key={c.id} {...focusAttr('complaints', c.id)}>
              <td>
                <span className="reg-primary">{c.title}</span>
                <span className="reg-sub">{c.complaint_number} · {dateOnly(c.received_date)} · {c.category || 'Uncategorised'}
                  {c.severity && c.severity !== 'moderate' ? ` · ${c.severity}` : ''}</span>
              </td>
              <td>
                <span className="reg-primary">{c.complainant_type || '—'}</span>
                <span className="reg-sub">{c.complainant_name || 'Anonymous'}</span>
              </td>
              <td>{formatBadge(STAGE_LABELS[stageOf(c)] ?? stageOf(c))}</td>
              <td>
                {c.acknowledged_at
                  ? <span className="reg-primary">{dateOnly(c.acknowledged_at)}</span>
                  : <span className={lateAck ? 'badge danger' : 'muted'}>{lateAck ? 'overdue' : 'not yet'}</span>}
                {!c.acknowledged_at && c.acknowledgement_due_date && <span className="reg-sub">by {dateOnly(c.acknowledgement_due_date)}</span>}
              </td>
              <td>
                <span className="reg-primary">{dateOnly(c.resolution_due_date)}</span>
                {lateRes && <span className="badge danger">overdue</span>}
              </td>
              <td>{c.outcome ? OUTCOME_LABELS[c.outcome]?.split(' — ')[0] ?? c.outcome : <span className="muted">—</span>}</td>
              <td><button type="button" className="tiny" onClick={() => open(c.id)}>Open</button></td>
            </tr>;
          })}
          {page.hidden > 0 && <tr><td colSpan={7} className="muted list-capped">
            Showing the most recent {page.shown.length.toLocaleString()} of {page.total.toLocaleString()} — search or filter to narrow it down.
          </td></tr>}
          {filtered.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 18, textAlign: 'center' }}>
            {complaints.length === 0 ? 'No complaints have been logged.' : 'Nothing matches those filters.'}
          </td></tr>}
        </tbody></table>
      </div>
    </div>}

    {tab === 'Log a complaint' && <div className="card">
      <h3>Log a complaint</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Anything a patient, clinician, ward or supplier raises about the laboratory's service. Logging it starts the
        clock: receipt must be acknowledged within {targets.acknowledgeDays} day{targets.acknowledgeDays === 1 ? '' : 's'},
        and the complaint resolved within {targets.resolveDays}.
      </p>
      {can('complaints', 'create') && <form className="form-grid" onSubmit={submit}>
        <label>Date received<input type="date" value={form.receivedDate} onChange={e => setForm({ ...form, receivedDate: e.target.value })} required /></label>
        <label>Complainant type
          <select value={form.complainantType} onChange={e => setForm({ ...form, complainantType: e.target.value })} required>
            <option value="">Select…</option>{COMPLAINANT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label><span>Complainant name <span className="muted">(optional)</span></span><TextField value={form.complainantName} onValue={nextValue => setForm({ ...form, complainantName: nextValue })} placeholder="May be left anonymous" /></label>
        <label><span>Contact <span className="muted">(optional)</span></span><TextField value={form.contact} onValue={nextValue => setForm({ ...form, contact: nextValue })} placeholder="Phone or email — needed to answer them" /></label>
        <label>How it reached us<TextField value={form.source} onValue={nextValue => setForm({ ...form, source: nextValue })} placeholder="e.g. OPD, ward round, suggestion box" /></label>
        <label>Category
          <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} required>
            <option value="">Select…</option>{COMPLAINT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Unit concerned
          <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}>
            <option value="">Not specific to one unit</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label>Severity
          <select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}>
            {COMPLAINT_SEVERITIES.map(s => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="wide">Summary<TextField value={form.title} onValue={nextValue => setForm({ ...form, title: nextValue })} placeholder="One line — what they are complaining about" required /></label>
        <label className="wide">What they said<TextField as="textarea" value={form.description} onValue={nextValue => setForm({ ...form, description: nextValue })} rows={4} placeholder="In their words as far as possible" required /></label>
        <label className="toggle wide">
          <input type="checkbox" checked={form.patientAffected} onChange={e => setForm({ ...form, patientAffected: e.target.checked })} />
          A patient or a reported result was affected
        </label>
        <label><span>Investigate this <span className="muted">(can be set later)</span></span>
          <select value={form.assignedToStaffId} onChange={e => setForm({ ...form, assignedToStaffId: e.target.value })}>
            <option value="">Decide later</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
          </select>
        </label>
        <button type="submit" disabled={loadState.loading}>{loadState.loading ? 'Logging…' : 'Log complaint'}</button>
      </form>}
    </div>}

    {tab === 'Process targets' && <div className="card">
      <h3>Process targets</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        An assessor asks whether the laboratory meets the targets its own documented complaints procedure states.
        Set them to match that procedure — every complaint logged afterwards is dated against them.
      </p>
      {can('complaints', 'edit') && <form className="form-grid" onSubmit={saveTargets}>
        <label>Acknowledge receipt within
          <NumberField min={1} max={365} value={targets.acknowledgeDays}
            onValue={n => setTargets(t => ({ ...t, acknowledgeDays: n ?? 0 }))} /> </label>
        <label>Resolve within
          <NumberField min={1} max={365} value={targets.resolveDays}
            onValue={n => setTargets(t => ({ ...t, resolveDays: n ?? 0 }))} /></label>
        <button type="submit" disabled={busy === 'targets'}>{busy === 'targets' ? 'Saving…' : 'Save targets'}</button>
      </form>}
    </div>}

    {/* ---- One complaint, and the one thing it owes next ------------------- */}
    <DetailModal
      open={!!selected}
      onClose={() => setSelected(null)}
      title={selected ? selected.title : ''}
      subtitle={selected ? `${selected.complaint_number} · received ${dateOnly(selected.received_date)} · ${selected.category || 'Uncategorised'}` : ''}
      header={selected ? formatBadge(STAGE_LABELS[stage] ?? stage) : undefined}
    >
      {selected && <div className="cx">
        {loadState.error && <Notice kind="error">{loadState.error}</Notice>}
        <StageTrail stage={stage} />
        <p className="cx-next"><AlertTriangle size={14} /> {STAGE_NEXT_ACTION[stage] ?? ''}</p>

        <div className="cx-facts">
          <div><span>Complainant</span><strong>{selected.complainant_type || '—'}{selected.complainant_name ? ` · ${selected.complainant_name}` : ''}</strong></div>
          <div><span>Contact</span><strong>{selected.contact || '—'}</strong></div>
          <div><span>Unit</span><strong>{sections.find(s => s.id === selected.section_id)?.name || '—'}</strong></div>
          <div><span>Severity</span><strong>{selected.severity || 'moderate'}{selected.patient_affected ? ' · patient affected' : ''}</strong></div>
          <div><span>Investigator</span><strong>{staffName(selected.assigned_to_staff_id)}</strong></div>
          <div><span>Resolve by</span><strong>{dateOnly(selected.resolution_due_date)}</strong></div>
        </div>
        <p className="cx-said">{selected.description}</p>

        {/* Acknowledge */}
        {!selected.acknowledged_at && mayEdit && <section className="cx-act">
          <h4>Acknowledge receipt</h4>
          <p className="muted">Due by {dateOnly(selected.acknowledgement_due_date)}. Record how you told them.</p>
          <div className="form-grid">
            <label>How<select value={ack.method} onChange={e => setAck({ ...ack, method: e.target.value })}>
              <option value="">Select…</option>{CONTACT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
            <label className="wide"><span>Note <span className="muted">(optional)</span></span><TextField value={ack.note} onValue={nextValue => setAck({ ...ack, note: nextValue })} placeholder="e.g. Spoke to Dr Mensah, explained the next steps" /></label>
          </div>
          <button type="button" disabled={!ack.method || busy === 'ack'} onClick={() => step('ack', '/acknowledge', ack, 'Receipt acknowledged.')}>
            {busy === 'ack' ? 'Recording…' : 'Record acknowledgement'}
          </button>
        </section>}
        {selected.acknowledged_at && <p className="cx-done"><CheckCircle2 size={14} /> Acknowledged {dateOnly(selected.acknowledged_at)} by {selected.acknowledgement_method?.toLowerCase()}{selected.acknowledged_by_staff_id ? ` · ${staffName(selected.acknowledged_by_staff_id)}` : ''}</p>}

        {/* Assign + investigate */}
        {!['closed', 'withdrawn'].includes(stage) && mayEdit && <section className="cx-act">
          <h4>Investigation</h4>
          <div className="form-grid">
            <label>Investigator
              <select value={String(selected.assigned_to_staff_id ?? '')}
                onChange={e => step('assign', '/assign', { assignedToStaffId: e.target.value }, 'Assigned.')}>
                <option value="">Choose…</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
              </select>
            </label>
            <label className="wide">What the investigation found<TextField as="textarea" rows={3} value={inv.investigationSummary} onValue={nextValue => setInv({ ...inv, investigationSummary: nextValue })} /></label>
            <label className="wide">Cause<TextField as="textarea" rows={2} value={inv.rootCause} onValue={nextValue => setInv({ ...inv, rootCause: nextValue })} placeholder="Why it happened" /></label>
            <label className="wide">Correction<TextField as="textarea" rows={2} value={inv.correction} onValue={nextValue => setInv({ ...inv, correction: nextValue })} placeholder="What was put right" /></label>
          </div>
          <div className="cx-acts">
            <button type="button" className="secondary" disabled={!inv.investigationSummary.trim() || busy === 'inv'}
              onClick={() => step('inv', '/investigate', { ...inv, sendForReview: false }, 'Findings saved.')}>
              {busy === 'inv' ? 'Saving…' : 'Save findings'}
            </button>
            {stage !== 'awaiting_review' && stage !== 'outcome_pending' &&
              <button type="button" disabled={!inv.investigationSummary.trim() || !inv.correction.trim() || busy === 'send'}
                onClick={() => step('send', '/investigate', { ...inv, sendForReview: true }, 'Sent for independent review.')}>
                {busy === 'send' ? 'Sending…' : 'Send for independent review →'}
              </button>}
          </div>
        </section>}

        {/* Independent review */}
        {stage === 'awaiting_review' && mayApprove && <section className="cx-act cx-review">
          <h4>Independent review</h4>
          <p className="muted">
            §7.4 requires the decision to be made or reviewed by somebody not involved in the activity complained
            about. The investigator{selected.assigned_to_staff_id ? ` (${staffName(selected.assigned_to_staff_id)})` : ''} cannot review it.
          </p>
          <div className="form-grid">
            <label>Reviewer
              <select value={rev.reviewedByStaffId} onChange={e => setRev({ ...rev, reviewedByStaffId: e.target.value })}>
                <option value="">Choose…</option>
                {staff.filter(s => s.id !== selected.assigned_to_staff_id && s.id !== selected.investigated_by_staff_id)
                  .map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
              </select>
            </label>
            <label>Decision
              <select value={rev.outcome} onChange={e => setRev({ ...rev, outcome: e.target.value })}>
                <option value="">Select…</option>{COMPLAINT_OUTCOMES.map(o => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
              </select>
            </label>
            <label className="wide">Review notes<TextField as="textarea" rows={2} value={rev.notes} onValue={nextValue => setRev({ ...rev, notes: nextValue })} /></label>
          </div>
          <button type="button" disabled={!rev.outcome || !rev.reviewedByStaffId || busy === 'rev'}
            onClick={() => step('rev', '/review', rev, 'Reviewed.')}>
            {busy === 'rev' ? 'Recording…' : 'Record the review'}
          </button>
        </section>}
        {selected.reviewed_at && <p className="cx-done"><CheckCircle2 size={14} /> Reviewed {dateOnly(selected.reviewed_at)} by {staffName(selected.reviewed_by_staff_id)} — {OUTCOME_LABELS[selected.outcome || '']?.split(' — ')[0] ?? selected.outcome}</p>}

        {/* Tell the complainant */}
        {selected.reviewed_at && !selected.outcome_communicated_at && mayEdit && <section className="cx-act">
          <h4>Tell the complainant</h4>
          <p className="muted">The formal notice that handling has ended. §7.4 asks for it, and it is what closes the loop for the person who complained.</p>
          <div className="form-grid">
            <label>How<select value={out.method} onChange={e => setOut({ ...out, method: e.target.value })}>
              <option value="">Select…</option>{CONTACT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
            <label className="wide">What they were told<TextField as="textarea" rows={3} value={out.summary} onValue={nextValue => setOut({ ...out, summary: nextValue })} /></label>
          </div>
          <button type="button" disabled={!out.method || !out.summary.trim() || busy === 'out'}
            onClick={() => step('out', '/communicate-outcome', out, 'Outcome communicated.')}>
            {busy === 'out' ? 'Recording…' : 'Record that they were told'}
          </button>
        </section>}
        {selected.outcome_communicated_at && <p className="cx-done"><CheckCircle2 size={14} /> Complainant told {dateOnly(selected.outcome_communicated_at)} by {selected.outcome_method?.toLowerCase()}</p>}

        {/* Escalate + close */}
        {!['closed', 'withdrawn'].includes(stage) && <section className="cx-act">
          <h4>Escalation and closure</h4>
          <div className="cx-acts">
            {can('nc_capa', 'create') && <button type="button" className="secondary" disabled={busy === 'nc'}
              onClick={() => step('nc', '/create-nc', {}, 'Nonconformity raised from this complaint.')}>Raise a nonconformity</button>}
            {can('nc_capa', 'create') && <button type="button" className="secondary" disabled={busy === 'capa'}
              onClick={() => step('capa', '/create-capa', { rootCause: selected.root_cause }, 'CAPA raised from this complaint.')}>Raise a CAPA</button>}
          </div>
          {mayClose && <>
            <label className="cx-field">Closure summary
              <TextField as="textarea" rows={2} value={closure} onValue={nextValue => setClosure(nextValue)} placeholder="What the laboratory did, and what remains being tracked elsewhere" />
            </label>
            <div className="cx-acts">
              <button type="button" disabled={!closure.trim() || busy === 'close'}
                onClick={() => step('close', '/close', { closureSummary: closure }, 'Complaint closed.')}>
                {busy === 'close' ? 'Closing…' : 'Close complaint'}
              </button>
            </div>
            <label className="cx-field">Or, if the complainant withdrew it
              <TextField value={withdrawal} onValue={nextValue => setWithdrawal(nextValue)} placeholder="Why it was withdrawn" />
            </label>
            <button type="button" className="secondary" disabled={!withdrawal.trim() || busy === 'wd'}
              onClick={() => step('wd', '/withdraw', { reason: withdrawal }, 'Recorded as withdrawn.')}>Record as withdrawn</button>
          </>}
        </section>}
        {selected.closure_summary && <p className="cx-done"><CheckCircle2 size={14} /> Closed {dateOnly(selected.closed_at)} — {selected.closure_summary}</p>}

        {/* The record of what was done */}
        <section className="cx-act">
          <h4><MessageSquare size={15} /> What was done</h4>
          <ul className="cx-log">
            {(selected.events ?? []).map(e => <li key={e.id}>
              <span className="cx-log-when">{String(e.created_at).slice(0, 16).replace('T', ' ')}</span>
              <span className="cx-log-what">{e.note || e.event_type.replace(/_/g, ' ')}</span>
              <span className="cx-log-who">{e.actor_name || e.actor_username || 'system'}</span>
            </li>)}
            {(selected.events ?? []).length === 0 && <li className="muted">Nothing recorded yet.</li>}
          </ul>
          {!!selected.links?.length && <ul className="link-list">
            {selected.links.map(l => <li key={l.id}>{l.target_record_type.replace(/_/g, ' ')} #{l.target_record_id} — {l.notes || 'linked'}</li>)}
          </ul>}
        </section>
      </div>}
    </DetailModal>
  </div>;
}

export default ComplaintsPage;
