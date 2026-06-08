import { FormEvent, useEffect, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Location, Section, Staff, MonitoringItem,
  BloodUnit, BloodBankHandover, BloodHandoverUnit, BloodDonationCampaign,
  BloodAdverseEvent, BloodDiscard, BloodBankSummary, BloodMonthlySummary,
  BloodDonationSummary, BloodTransfusionSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const BLOOD_GROUPS = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];
const COMPONENT_TYPES = ['whole_blood', 'packed_cells', 'plasma', 'platelets', 'other'];
const DONOR_TYPES = ['family_donor', 'voluntary_donor', 'commercial_paid_donor', 'outside_campaign_donor', 'unknown'];
const SCREENING_RESULTS = ['', 'negative', 'reactive', 'indeterminate', 'not_done', 'unknown'];
const UNIT_STATUSES = ['available', 'reserved', 'transfused', 'expired', 'discarded', 'quarantined', 'transferred', 'unknown'];
const ADVERSE_EVENT_TYPES = ['donor_reaction', 'transfusion_reaction', 'transfusion_incident', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [monitoringItems, setMonitoringItems] = useState<MonitoringItem[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Location[]>('/locations').then(setLocations).catch(() => setLocations([]));
    api<MonitoringItem[]>('/monitoring/items').then(setMonitoringItems).catch(() => setMonitoringItems([]));
  }, []);
  return { staff, sections, locations, monitoringItems };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

const emptyUnitForm = { unitNumber: '', batchNumber: '', bloodGroup: 'O+', componentType: 'whole_blood', donorType: 'voluntary_donor', collectionDate: '', expiryDate: '', screeningHbsag: '', screeningHcv: '', screeningSyphilis: '', screeningHiv: '', locationId: '', refrigeratorMonitoringItemId: '', notes: '' };
const emptyHandoverForm = { handoverDate: '', periodStart: '', periodEnd: '', outgoingStaffId: '', incomingStaffId: '', bloodBankUnitHeadId: '', totalUnitsAvailable: '', totalUnitsExpiringSoon: '', totalUnitsExpired: '', totalDonations: '', familyDonorCount: '', voluntaryDonorCount: '', commercialPaidDonorCount: '', outsideCampaignDonorCount: '', totalTransfusions: '', totalDiscards: '', donorReactionsCount: '', transfusionReactionsCount: '', issuesNoted: '' };
const emptyCampaignForm = { campaignDate: '', location: '', organizer: '', totalScreened: '', totalCollected: '', familyDonorCount: '', voluntaryDonorCount: '', commercialPaidDonorCount: '', rejectedOrDeferredCount: '', responsibleStaffId: '', remarks: '' };
const emptyAdverseForm = { eventDate: '', eventType: 'donor_reaction', relatedUnitId: '', bloodGroup: '', donorType: '', sectionId: '', locationId: '', title: '', description: '', immediateAction: '', severity: 'medium', outcome: '' };

export function BloodBankHandoverPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations, monitoringItems } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<BloodBankSummary | null>(null);
  const [units, setUnits] = useState<BloodUnit[]>([]);
  const [handovers, setHandovers] = useState<BloodBankHandover[]>([]);
  const [selectedHandover, setSelectedHandover] = useState<BloodBankHandover | null>(null);
  const [campaigns, setCampaigns] = useState<BloodDonationCampaign[]>([]);
  const [adverseEvents, setAdverseEvents] = useState<BloodAdverseEvent[]>([]);
  const [discards, setDiscards] = useState<BloodDiscard[]>([]);
  const [monthlySummary, setMonthlySummary] = useState<BloodMonthlySummary | null>(null);
  const [monthSelector, setMonthSelector] = useState(new Date().toISOString().slice(0, 7));

  const [unitForm, setUnitForm] = useState(emptyUnitForm);
  const [handoverForm, setHandoverForm] = useState(emptyHandoverForm);
  const [campaignForm, setCampaignForm] = useState(emptyCampaignForm);
  const [adverseForm, setAdverseForm] = useState(emptyAdverseForm);
  const [addUnitForm, setAddUnitForm] = useState({ bloodUnitId: '', notes: '' });
  const [discardForm, setDiscardForm] = useState({ unitId: '', reason: '', remarks: '' });
  const [donationSummaryForm, setDonationSummaryForm] = useState({ summaryDate: '', donorType: '', numberScreened: '', numberAccepted: '', numberDeferred: '', numberCollected: '', remarks: '' });
  const [transfusionSummaryForm, setTransfusionSummaryForm] = useState({ summaryDate: '', bloodGroup: '', componentType: '', numberTransfused: '', remarks: '' });

  async function load() {
    try {
      const [sum, u, h, c, ae] = await Promise.all([
        api<BloodBankSummary>('/dashboard/blood-bank-summary').catch(() => null),
        api<BloodUnit[]>('/blood-bank-handover/units'),
        api<BloodBankHandover[]>('/blood-bank-handover/handovers'),
        api<BloodDonationCampaign[]>('/blood-bank-handover/campaigns'),
        api<BloodAdverseEvent[]>('/blood-bank-handover/adverse-events')
      ]);
      if (sum) setSummary(sum);
      setUnits(u); setHandovers(h); setCampaigns(c); setAdverseEvents(ae);
      const allDiscards: BloodDiscard[] = [];
      for (const unit of u) {
        if (unit.current_status === 'discarded') {
          const detail = await api<any>(`/blood-bank-handover/units/${unit.id}`).catch(() => null);
          if (detail) allDiscards.push({ id: unit.id, discard_date: unit.updated_at || unit.created_at, blood_unit_id: unit.id, unit_number: unit.unit_number, blood_group: unit.blood_group, component_type: unit.component_type, reason: '—', created_by: unit.created_by, created_at: unit.updated_at || unit.created_at });
        }
      }
      setDiscards(allDiscards);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('blood_bank_handover')) void load(); }, [isEnabled]);
  if (!isEnabled('blood_bank_handover')) return <DisabledModule />;

  async function openHandover(id: number) {
    try { setSelectedHandover(await api<BloodBankHandover>(`/blood-bank-handover/handovers/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitUnit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/blood-bank-handover/units', { method: 'POST', body: JSON.stringify(unitForm) });
      setUnitForm(emptyUnitForm); await load(); setTab('Blood Units');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitHandover(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/blood-bank-handover/handovers', { method: 'POST', body: JSON.stringify(handoverForm) });
      setHandoverForm(emptyHandoverForm); await load(); setTab('Handovers');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitCampaign(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/blood-bank-handover/campaigns', { method: 'POST', body: JSON.stringify(campaignForm) });
      setCampaignForm(emptyCampaignForm); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitAdverse(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/blood-bank-handover/adverse-events', { method: 'POST', body: JSON.stringify(adverseForm) });
      setAdverseForm(emptyAdverseForm); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitDiscard(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!discardForm.unitId) return setError('Select a unit');
    try {
      await api(`/blood-bank-handover/units/${discardForm.unitId}/discard`, { method: 'POST', body: JSON.stringify({ reason: discardForm.reason, remarks: discardForm.remarks }) });
      setDiscardForm({ unitId: '', reason: '', remarks: '' }); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function addUnitToHandover(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedHandover) return;
    try {
      await api(`/blood-bank-handover/handovers/${selectedHandover.id}/add-unit`, { method: 'POST', body: JSON.stringify(addUnitForm) });
      setAddUnitForm({ bloodUnitId: '', notes: '' });
      await openHandover(selectedHandover.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function addDonationSummary(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedHandover) return;
    try {
      await api(`/blood-bank-handover/handovers/${selectedHandover.id}/donation-summary`, { method: 'POST', body: JSON.stringify(donationSummaryForm) });
      setDonationSummaryForm({ summaryDate: '', donorType: '', numberScreened: '', numberAccepted: '', numberDeferred: '', numberCollected: '', remarks: '' });
      await openHandover(selectedHandover.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function addTransfusionSummary(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedHandover) return;
    try {
      await api(`/blood-bank-handover/handovers/${selectedHandover.id}/transfusion-summary`, { method: 'POST', body: JSON.stringify(transfusionSummaryForm) });
      setTransfusionSummaryForm({ summaryDate: '', bloodGroup: '', componentType: '', numberTransfused: '', remarks: '' });
      await openHandover(selectedHandover.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function signOutgoing(id: number) {
    try { await api(`/blood-bank-handover/handovers/${id}/sign-outgoing`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function signIncoming(id: number) {
    try { await api(`/blood-bank-handover/handovers/${id}/sign-incoming`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function reviewHandover(id: number) {
    try { await api(`/blood-bank-handover/handovers/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function closeHandover(id: number) {
    try { await api(`/blood-bank-handover/handovers/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function createHandoverNc(id: number) {
    try { await api(`/blood-bank-handover/handovers/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }
  async function createHandoverAction(id: number) {
    const title = prompt('Action title?');
    if (!title) return;
    try { await api(`/blood-bank-handover/handovers/${id}/create-action`, { method: 'POST', body: JSON.stringify({ title }) }); await load(); if (selectedHandover?.id === id) await openHandover(id); }
    catch (e) { setError((e as Error).message); }
  }

  async function createAdverseNc(id: number) {
    try { await api(`/blood-bank-handover/adverse-events/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createAdverseCapa(id: number) {
    try { await api(`/blood-bank-handover/adverse-events/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createAdverseSafetyIncident(id: number) {
    try { await api(`/blood-bank-handover/adverse-events/${id}/create-safety-incident`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function closeAdverse(id: number) {
    try { await api(`/blood-bank-handover/adverse-events/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function loadMonthlySummary() {
    try { setMonthlySummary(await api<BloodMonthlySummary>(`/blood-bank-handover/monthly-summary?month=${monthSelector}`)); }
    catch (e) { setError((e as Error).message); }
  }

  const tabs = ['Dashboard', 'Blood Units', 'New Blood Unit', 'Thursday Handover', 'Handovers', 'Donation Campaigns', 'Adverse Events', 'Discards', 'Monthly Summary', 'Reports'];

  return <div className="module-page">
    <h2>Blood Bank Quality & Inventory Handover</h2>
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && <>
      {summary ? <div className="cards">
        <div className="card"><h4>Units available</h4><p className="metric">{summary.unitsAvailable}</p></div>
        <div className="card"><h4>Units expiring soon</h4><p className="metric">{summary.unitsExpiringSoon}</p></div>
        <div className="card"><h4>Expired units</h4><p className="metric">{summary.unitsExpired}</p></div>
        <div className="card"><h4>Pending handovers</h4><p className="metric">{summary.pendingHandovers}</p></div>
        <div className="card"><h4>Adverse events open</h4><p className="metric">{summary.openAdverseEvents}</p></div>
        <div className="card"><h4>Discards this month</h4><p className="metric">{summary.discardsThisMonth}</p></div>
        <div className="card"><h4>Donor reactions (month)</h4><p className="metric">{summary.donorReactionsThisMonth}</p></div>
        <div className="card"><h4>Transfusion reactions (month)</h4><p className="metric">{summary.transfusionReactionsThisMonth}</p></div>
        <div className="card"><h4>NC/CAPA links</h4><p className="metric">—</p><small>Surfaced via individual records.</small></div>
      </div> : <p>Loading summary…</p>}
    </>}

    {tab === 'Blood Units' && <table className="data-table"><thead><tr><th>Unit #</th><th>Batch</th><th>Group</th><th>Component</th><th>Donor type</th><th>Collected</th><th>Expiry</th><th>Expiry status</th><th>Screening</th><th>Current</th><th>Actions</th></tr></thead><tbody>
      {units.map(u => <tr key={u.id}>
        <td>{u.unit_number}</td><td>{u.batch_number || '—'}</td><td>{u.blood_group}</td>
        <td>{u.component_type.replace(/_/g, ' ')}</td><td>{(u.donor_type || '—').replace(/_/g, ' ')}</td>
        <td>{u.collection_date}</td><td>{u.expiry_date}</td><td>{formatBadge(u.expiry_status)}</td>
        <td>{formatBadge(u.screening_status)}</td><td>{formatBadge(u.current_status)}</td>
        <td>
          {u.current_status !== 'discarded' && <button onClick={() => setDiscardForm({ unitId: String(u.id), reason: '', remarks: '' })}>Mark discard</button>}
        </td>
      </tr>)}
    </tbody></table>}

    {tab === 'New Blood Unit' && <form className="form-grid" onSubmit={submitUnit}>
      <label>Unit number<input value={unitForm.unitNumber} onChange={e => setUnitForm({ ...unitForm, unitNumber: e.target.value })} required /></label>
      <label>Batch number<input value={unitForm.batchNumber} onChange={e => setUnitForm({ ...unitForm, batchNumber: e.target.value })} /></label>
      <label>Blood group<select value={unitForm.bloodGroup} onChange={e => setUnitForm({ ...unitForm, bloodGroup: e.target.value })} required>{BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
      <label>Component type<select value={unitForm.componentType} onChange={e => setUnitForm({ ...unitForm, componentType: e.target.value })} required>{COMPONENT_TYPES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Donor type<select value={unitForm.donorType} onChange={e => setUnitForm({ ...unitForm, donorType: e.target.value })} required>{DONOR_TYPES.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Collection date<input type="date" value={unitForm.collectionDate} onChange={e => setUnitForm({ ...unitForm, collectionDate: e.target.value })} required /></label>
      <label>Expiry date<input type="date" value={unitForm.expiryDate} onChange={e => setUnitForm({ ...unitForm, expiryDate: e.target.value })} required /></label>
      <label>HBsAg<select value={unitForm.screeningHbsag} onChange={e => setUnitForm({ ...unitForm, screeningHbsag: e.target.value })}>{SCREENING_RESULTS.map(s => <option key={s} value={s}>{s || '—'}</option>)}</select></label>
      <label>HCV<select value={unitForm.screeningHcv} onChange={e => setUnitForm({ ...unitForm, screeningHcv: e.target.value })}>{SCREENING_RESULTS.map(s => <option key={s} value={s}>{s || '—'}</option>)}</select></label>
      <label>Syphilis<select value={unitForm.screeningSyphilis} onChange={e => setUnitForm({ ...unitForm, screeningSyphilis: e.target.value })}>{SCREENING_RESULTS.map(s => <option key={s} value={s}>{s || '—'}</option>)}</select></label>
      <label>HIV<select value={unitForm.screeningHiv} onChange={e => setUnitForm({ ...unitForm, screeningHiv: e.target.value })}>{SCREENING_RESULTS.map(s => <option key={s} value={s}>{s || '—'}</option>)}</select></label>
      <label>Location<select value={unitForm.locationId} onChange={e => setUnitForm({ ...unitForm, locationId: e.target.value })}><option value="">—</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label>Refrigerator monitoring item<select value={unitForm.refrigeratorMonitoringItemId} onChange={e => setUnitForm({ ...unitForm, refrigeratorMonitoringItemId: e.target.value })}><option value="">—</option>{monitoringItems.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>Notes<textarea value={unitForm.notes} onChange={e => setUnitForm({ ...unitForm, notes: e.target.value })} /></label>
      <button type="submit">Register blood unit</button>
    </form>}

    {tab === 'Thursday Handover' && <form className="form-grid" onSubmit={submitHandover}>
      <label>Handover date<input type="date" value={handoverForm.handoverDate} onChange={e => setHandoverForm({ ...handoverForm, handoverDate: e.target.value })} required /></label>
      <label>Period start<input type="date" value={handoverForm.periodStart} onChange={e => setHandoverForm({ ...handoverForm, periodStart: e.target.value })} required /></label>
      <label>Period end<input type="date" value={handoverForm.periodEnd} onChange={e => setHandoverForm({ ...handoverForm, periodEnd: e.target.value })} required /></label>
      <label>Outgoing staff<select value={handoverForm.outgoingStaffId} onChange={e => setHandoverForm({ ...handoverForm, outgoingStaffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Incoming staff<select value={handoverForm.incomingStaffId} onChange={e => setHandoverForm({ ...handoverForm, incomingStaffId: e.target.value })} required><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Blood Bank Unit Head<select value={handoverForm.bloodBankUnitHeadId} onChange={e => setHandoverForm({ ...handoverForm, bloodBankUnitHeadId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Units available<input type="number" value={handoverForm.totalUnitsAvailable} onChange={e => setHandoverForm({ ...handoverForm, totalUnitsAvailable: e.target.value })} /></label>
      <label>Units expiring soon<input type="number" value={handoverForm.totalUnitsExpiringSoon} onChange={e => setHandoverForm({ ...handoverForm, totalUnitsExpiringSoon: e.target.value })} /></label>
      <label>Units expired<input type="number" value={handoverForm.totalUnitsExpired} onChange={e => setHandoverForm({ ...handoverForm, totalUnitsExpired: e.target.value })} /></label>
      <label>Total donations<input type="number" value={handoverForm.totalDonations} onChange={e => setHandoverForm({ ...handoverForm, totalDonations: e.target.value })} /></label>
      <label>Family donors<input type="number" value={handoverForm.familyDonorCount} onChange={e => setHandoverForm({ ...handoverForm, familyDonorCount: e.target.value })} /></label>
      <label>Voluntary donors<input type="number" value={handoverForm.voluntaryDonorCount} onChange={e => setHandoverForm({ ...handoverForm, voluntaryDonorCount: e.target.value })} /></label>
      <label>Commercial/paid donors<input type="number" value={handoverForm.commercialPaidDonorCount} onChange={e => setHandoverForm({ ...handoverForm, commercialPaidDonorCount: e.target.value })} /></label>
      <label>Outside campaign donors<input type="number" value={handoverForm.outsideCampaignDonorCount} onChange={e => setHandoverForm({ ...handoverForm, outsideCampaignDonorCount: e.target.value })} /></label>
      <label>Total transfusions<input type="number" value={handoverForm.totalTransfusions} onChange={e => setHandoverForm({ ...handoverForm, totalTransfusions: e.target.value })} /></label>
      <label>Total discards<input type="number" value={handoverForm.totalDiscards} onChange={e => setHandoverForm({ ...handoverForm, totalDiscards: e.target.value })} /></label>
      <label>Donor reactions<input type="number" value={handoverForm.donorReactionsCount} onChange={e => setHandoverForm({ ...handoverForm, donorReactionsCount: e.target.value })} /></label>
      <label>Transfusion reactions<input type="number" value={handoverForm.transfusionReactionsCount} onChange={e => setHandoverForm({ ...handoverForm, transfusionReactionsCount: e.target.value })} /></label>
      <label>Issues noted<textarea value={handoverForm.issuesNoted} onChange={e => setHandoverForm({ ...handoverForm, issuesNoted: e.target.value })} /></label>
      <button type="submit">Create handover</button>
    </form>}

    {tab === 'Handovers' && <>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Period</th><th>Outgoing</th><th>Incoming</th><th>Unit head</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {handovers.map(h => <tr key={h.id}>
          <td>{h.handover_number}</td><td>{h.handover_date}</td>
          <td>{h.period_start} → {h.period_end}</td>
          <td>{h.outgoing_staff_name || staffName(staff, h.outgoing_staff_id)}</td>
          <td>{h.incoming_staff_name || staffName(staff, h.incoming_staff_id)}</td>
          <td>{h.unit_head_name || staffName(staff, h.blood_bank_unit_head_id)}</td>
          <td>{formatBadge(h.status)}</td>
          <td>
            <button onClick={() => openHandover(h.id)}>Open</button>
            {!h.outgoing_staff_signed_at && <button onClick={() => signOutgoing(h.id)}>Sign outgoing</button>}
            {!h.incoming_staff_signed_at && <button onClick={() => signIncoming(h.id)}>Sign incoming</button>}
            {!h.unit_head_reviewed_at && <button onClick={() => reviewHandover(h.id)}>Unit head review</button>}
            {h.status !== 'closed' && <button onClick={() => closeHandover(h.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedHandover && <div className="card" style={{ marginTop: 16 }}>
        <h3>{selectedHandover.handover_number}</h3>
        <p>Date: {selectedHandover.handover_date} | Period: {selectedHandover.period_start} → {selectedHandover.period_end} | Status: {formatBadge(selectedHandover.status)}</p>
        <p>Outgoing: {selectedHandover.outgoing_staff_name || staffName(staff, selectedHandover.outgoing_staff_id)} {selectedHandover.outgoing_staff_signed_at ? `✓ ${selectedHandover.outgoing_staff_signed_at}` : '(unsigned)'}</p>
        <p>Incoming: {selectedHandover.incoming_staff_name || staffName(staff, selectedHandover.incoming_staff_id)} {selectedHandover.incoming_staff_signed_at ? `✓ ${selectedHandover.incoming_staff_signed_at}` : '(unsigned)'}</p>
        <p>Unit head: {selectedHandover.unit_head_name || staffName(staff, selectedHandover.blood_bank_unit_head_id)} {selectedHandover.unit_head_reviewed_at ? `✓ ${selectedHandover.unit_head_reviewed_at}` : '(unreviewed)'}</p>
        <p>Available: {selectedHandover.total_units_available} | Expiring soon: {selectedHandover.total_units_expiring_soon} | Expired: {selectedHandover.total_units_expired}</p>
        <p>Donations: {selectedHandover.total_donations} (family {selectedHandover.family_donor_count}, voluntary {selectedHandover.voluntary_donor_count}, paid {selectedHandover.commercial_paid_donor_count}, outside {selectedHandover.outside_campaign_donor_count}) | Transfusions: {selectedHandover.total_transfusions} | Discards: {selectedHandover.total_discards}</p>
        <p>Donor reactions: {selectedHandover.donor_reactions_count} | Transfusion reactions: {selectedHandover.transfusion_reactions_count}</p>
        {selectedHandover.issues_noted && <p><strong>Issues noted:</strong> {selectedHandover.issues_noted}</p>}

        <h4>Units in handover</h4>
        <table className="data-table"><thead><tr><th>Unit #</th><th>Group</th><th>Component</th><th>Expiry</th><th>Screening</th><th>Status at handover</th></tr></thead><tbody>
          {(selectedHandover.units || []).map((u: BloodHandoverUnit) => <tr key={u.id}><td>{u.unit_number || '—'}</td><td>{u.blood_group || '—'}</td><td>{(u.component_type || '—').replace(/_/g, ' ')}</td><td>{u.expiry_date || '—'}</td><td>{formatBadge(u.screening_status)}</td><td>{formatBadge(u.unit_status_at_handover)}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addUnitToHandover}>
          <label>Add unit<select value={addUnitForm.bloodUnitId} onChange={e => setAddUnitForm({ ...addUnitForm, bloodUnitId: e.target.value })} required><option value="">—</option>{units.map(u => <option key={u.id} value={u.id}>{u.unit_number} ({u.blood_group})</option>)}</select></label>
          <label>Notes<input value={addUnitForm.notes} onChange={e => setAddUnitForm({ ...addUnitForm, notes: e.target.value })} /></label>
          <button type="submit">Add to handover</button>
        </form>

        <h4>Donation summaries</h4>
        <table className="data-table"><thead><tr><th>Date</th><th>Donor type</th><th>Screened</th><th>Accepted</th><th>Deferred</th><th>Collected</th></tr></thead><tbody>
          {(selectedHandover.donationSummaries || []).map((d: BloodDonationSummary) => <tr key={d.id}><td>{d.summary_date}</td><td>{(d.donor_type || '—').replace(/_/g, ' ')}</td><td>{d.number_screened}</td><td>{d.number_accepted}</td><td>{d.number_deferred}</td><td>{d.number_collected}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addDonationSummary}>
          <label>Summary date<input type="date" value={donationSummaryForm.summaryDate} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, summaryDate: e.target.value })} required /></label>
          <label>Donor type<select value={donationSummaryForm.donorType} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, donorType: e.target.value })}><option value="">—</option>{DONOR_TYPES.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Screened<input type="number" value={donationSummaryForm.numberScreened} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, numberScreened: e.target.value })} /></label>
          <label>Accepted<input type="number" value={donationSummaryForm.numberAccepted} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, numberAccepted: e.target.value })} /></label>
          <label>Deferred<input type="number" value={donationSummaryForm.numberDeferred} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, numberDeferred: e.target.value })} /></label>
          <label>Collected<input type="number" value={donationSummaryForm.numberCollected} onChange={e => setDonationSummaryForm({ ...donationSummaryForm, numberCollected: e.target.value })} /></label>
          <button type="submit">Add donation summary</button>
        </form>

        <h4>Transfusion summaries</h4>
        <table className="data-table"><thead><tr><th>Date</th><th>Group</th><th>Component</th><th>Transfused</th></tr></thead><tbody>
          {(selectedHandover.transfusionSummaries || []).map((t: BloodTransfusionSummary) => <tr key={t.id}><td>{t.summary_date}</td><td>{t.blood_group || '—'}</td><td>{(t.component_type || '—').replace(/_/g, ' ')}</td><td>{t.number_transfused}</td></tr>)}
        </tbody></table>
        <form className="form-grid" onSubmit={addTransfusionSummary}>
          <label>Summary date<input type="date" value={transfusionSummaryForm.summaryDate} onChange={e => setTransfusionSummaryForm({ ...transfusionSummaryForm, summaryDate: e.target.value })} required /></label>
          <label>Blood group<select value={transfusionSummaryForm.bloodGroup} onChange={e => setTransfusionSummaryForm({ ...transfusionSummaryForm, bloodGroup: e.target.value })}><option value="">—</option>{BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
          <label>Component<select value={transfusionSummaryForm.componentType} onChange={e => setTransfusionSummaryForm({ ...transfusionSummaryForm, componentType: e.target.value })}><option value="">—</option>{COMPONENT_TYPES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Number transfused<input type="number" value={transfusionSummaryForm.numberTransfused} onChange={e => setTransfusionSummaryForm({ ...transfusionSummaryForm, numberTransfused: e.target.value })} /></label>
          <button type="submit">Add transfusion summary</button>
        </form>

        {selectedHandover.links && selectedHandover.links.length > 0 && <>
          <h4>Linked records</h4>
          <ul>{selectedHandover.links.map(l => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` — ${l.notes}` : ''}</li>)}</ul>
        </>}

        <div style={{ marginTop: 12 }}>
          <button onClick={() => createHandoverAction(selectedHandover.id)}>Create action</button>{' '}
          <button onClick={() => createHandoverNc(selectedHandover.id)}>Create NC</button>{' '}
          <button className="secondary" onClick={() => setSelectedHandover(null)}>Close panel</button>
        </div>
      </div>}
    </>}

    {tab === 'Donation Campaigns' && <>
      <form className="form-grid" onSubmit={submitCampaign}>
        <label>Campaign date<input type="date" value={campaignForm.campaignDate} onChange={e => setCampaignForm({ ...campaignForm, campaignDate: e.target.value })} required /></label>
        <label>Location<input value={campaignForm.location} onChange={e => setCampaignForm({ ...campaignForm, location: e.target.value })} required /></label>
        <label>Organizer<input value={campaignForm.organizer} onChange={e => setCampaignForm({ ...campaignForm, organizer: e.target.value })} /></label>
        <label>Total screened<input type="number" value={campaignForm.totalScreened} onChange={e => setCampaignForm({ ...campaignForm, totalScreened: e.target.value })} required /></label>
        <label>Total collected<input type="number" value={campaignForm.totalCollected} onChange={e => setCampaignForm({ ...campaignForm, totalCollected: e.target.value })} required /></label>
        <label>Family donors<input type="number" value={campaignForm.familyDonorCount} onChange={e => setCampaignForm({ ...campaignForm, familyDonorCount: e.target.value })} /></label>
        <label>Voluntary donors<input type="number" value={campaignForm.voluntaryDonorCount} onChange={e => setCampaignForm({ ...campaignForm, voluntaryDonorCount: e.target.value })} /></label>
        <label>Commercial/paid donors<input type="number" value={campaignForm.commercialPaidDonorCount} onChange={e => setCampaignForm({ ...campaignForm, commercialPaidDonorCount: e.target.value })} /></label>
        <label>Rejected/deferred<input type="number" value={campaignForm.rejectedOrDeferredCount} onChange={e => setCampaignForm({ ...campaignForm, rejectedOrDeferredCount: e.target.value })} /></label>
        <label>Responsible staff<select value={campaignForm.responsibleStaffId} onChange={e => setCampaignForm({ ...campaignForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Remarks<textarea value={campaignForm.remarks} onChange={e => setCampaignForm({ ...campaignForm, remarks: e.target.value })} /></label>
        <button type="submit">Record campaign</button>
      </form>
      <table className="data-table"><thead><tr><th>Date</th><th>Location</th><th>Organizer</th><th>Screened</th><th>Collected</th><th>Family</th><th>Voluntary</th><th>Paid</th><th>Rejected</th><th>Responsible</th></tr></thead><tbody>
        {campaigns.map(c => <tr key={c.id}>
          <td>{c.campaign_date}</td><td>{c.location}</td><td>{c.organizer || '—'}</td>
          <td>{c.total_screened}</td><td>{c.total_collected}</td>
          <td>{c.family_donor_count}</td><td>{c.voluntary_donor_count}</td><td>{c.commercial_paid_donor_count}</td>
          <td>{c.rejected_or_deferred_count}</td>
          <td>{c.responsible_staff_name || staffName(staff, c.responsible_staff_id)}</td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Adverse Events' && <>
      <form className="form-grid" onSubmit={submitAdverse}>
        <label>Event date<input type="date" value={adverseForm.eventDate} onChange={e => setAdverseForm({ ...adverseForm, eventDate: e.target.value })} required /></label>
        <label>Event type<select value={adverseForm.eventType} onChange={e => setAdverseForm({ ...adverseForm, eventType: e.target.value })} required>{ADVERSE_EVENT_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Related unit<select value={adverseForm.relatedUnitId} onChange={e => setAdverseForm({ ...adverseForm, relatedUnitId: e.target.value })}><option value="">—</option>{units.map(u => <option key={u.id} value={u.id}>{u.unit_number} ({u.blood_group})</option>)}</select></label>
        <label>Blood group<select value={adverseForm.bloodGroup} onChange={e => setAdverseForm({ ...adverseForm, bloodGroup: e.target.value })}><option value="">—</option>{BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}</select></label>
        <label>Donor type<select value={adverseForm.donorType} onChange={e => setAdverseForm({ ...adverseForm, donorType: e.target.value })}><option value="">—</option>{DONOR_TYPES.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Section<select value={adverseForm.sectionId} onChange={e => setAdverseForm({ ...adverseForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={adverseForm.locationId} onChange={e => setAdverseForm({ ...adverseForm, locationId: e.target.value })}><option value="">—</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Title<input value={adverseForm.title} onChange={e => setAdverseForm({ ...adverseForm, title: e.target.value })} required /></label>
        <label>Severity<select value={adverseForm.severity} onChange={e => setAdverseForm({ ...adverseForm, severity: e.target.value })} required>{SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <label>Outcome<input value={adverseForm.outcome} onChange={e => setAdverseForm({ ...adverseForm, outcome: e.target.value })} /></label>
        <label>Description<textarea value={adverseForm.description} onChange={e => setAdverseForm({ ...adverseForm, description: e.target.value })} required /></label>
        <label>Immediate action<textarea value={adverseForm.immediateAction} onChange={e => setAdverseForm({ ...adverseForm, immediateAction: e.target.value })} /></label>
        <button type="submit">Log adverse event</button>
      </form>
      <table className="data-table"><thead><tr><th>Number</th><th>Date</th><th>Type</th><th>Unit</th><th>Title</th><th>Severity</th><th>Outcome</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {adverseEvents.map(e => <tr key={e.id}>
          <td>{e.event_number}</td><td>{e.event_date}</td><td>{e.event_type.replace(/_/g, ' ')}</td>
          <td>{e.related_unit_number || '—'}</td><td>{e.title}</td><td>{formatBadge(e.severity)}</td>
          <td>{e.outcome || '—'}</td><td>{formatBadge(e.status)}</td>
          <td>
            {!e.nc_id && <button onClick={() => createAdverseNc(e.id)}>Create NC</button>}
            {!e.capa_id && <button onClick={() => createAdverseCapa(e.id)}>Create CAPA</button>}
            {!e.safety_incident_id && <button onClick={() => createAdverseSafetyIncident(e.id)}>Create safety incident</button>}
            {e.status !== 'closed' && <button onClick={() => closeAdverse(e.id)}>Close</button>}
          </td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Discards' && <>
      <form className="form-grid" onSubmit={submitDiscard}>
        <label>Blood unit<select value={discardForm.unitId} onChange={e => setDiscardForm({ ...discardForm, unitId: e.target.value })} required><option value="">—</option>{units.filter(u => u.current_status !== 'discarded').map(u => <option key={u.id} value={u.id}>{u.unit_number} ({u.blood_group})</option>)}</select></label>
        <label>Reason<input value={discardForm.reason} onChange={e => setDiscardForm({ ...discardForm, reason: e.target.value })} required /></label>
        <label>Remarks<textarea value={discardForm.remarks} onChange={e => setDiscardForm({ ...discardForm, remarks: e.target.value })} /></label>
        <button type="submit">Mark as discard</button>
      </form>
      <table className="data-table"><thead><tr><th>Unit #</th><th>Group</th><th>Component</th><th>Status</th><th>Expiry</th></tr></thead><tbody>
        {units.filter(u => u.current_status === 'discarded').map(u => <tr key={u.id}><td>{u.unit_number}</td><td>{u.blood_group}</td><td>{u.component_type.replace(/_/g, ' ')}</td><td>{formatBadge(u.current_status)}</td><td>{u.expiry_date}</td></tr>)}
      </tbody></table>
      {discards.length === 0 && <p>No discarded units yet.</p>}
    </>}

    {tab === 'Monthly Summary' && <>
      <div className="form-grid">
        <label>Month<input type="month" value={monthSelector} onChange={e => setMonthSelector(e.target.value)} /></label>
        <button type="button" onClick={loadMonthlySummary}>Load summary</button>
      </div>
      {monthlySummary && <>
        <div className="cards">
          <div className="card"><h4>Units at month end</h4><p className="metric">{monthlySummary.unitsAvailableAtMonthEnd}</p></div>
          <div className="card"><h4>Expiring soon</h4><p className="metric">{monthlySummary.unitsExpiringSoon}</p></div>
          <div className="card"><h4>Expired</h4><p className="metric">{monthlySummary.unitsExpired}</p></div>
          <div className="card"><h4>Discards</h4><p className="metric">{monthlySummary.discards}</p></div>
          <div className="card"><h4>Donor adverse events</h4><p className="metric">{monthlySummary.donorAdverseEvents}</p></div>
          <div className="card"><h4>Transfusion reactions</h4><p className="metric">{monthlySummary.transfusionReactions}</p></div>
          <div className="card"><h4>NC/CAPA-linked events</h4><p className="metric">{monthlySummary.ncCapaLinkedEvents}</p></div>
        </div>
        <h4>Donations by donor type</h4>
        <table className="data-table"><thead><tr><th>Donor type</th><th>Screened</th><th>Accepted</th><th>Deferred</th><th>Collected</th></tr></thead><tbody>
          {monthlySummary.donationsByDonorType.map((d, i) => <tr key={i}><td>{(d.donor_type || '—').replace(/_/g, ' ')}</td><td>{d.screened || 0}</td><td>{d.accepted || 0}</td><td>{d.deferred || 0}</td><td>{d.collected || 0}</td></tr>)}
        </tbody></table>
        <h4>Transfusions by group/component</h4>
        <table className="data-table"><thead><tr><th>Group</th><th>Component</th><th>Transfused</th></tr></thead><tbody>
          {monthlySummary.transfusions.map((t, i) => <tr key={i}><td>{t.blood_group || '—'}</td><td>{(t.component_type || '—').replace(/_/g, ' ')}</td><td>{t.transfused || 0}</td></tr>)}
        </tbody></table>
        <p><em>Export to printable monthly report will be added in a later phase.</em></p>
      </>}
      {!monthlySummary && <p>Select a month and click load.</p>}
    </>}

    {tab === 'Reports' && <p>Detailed blood bank reports (weekly trend, screening reactivity rate, discard reasons) will be added in a later phase.</p>}
  </div>;
}
