import { FormEvent, useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { KpiStrip, ChartCard, DonutChart, BarMeter, BarChart, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Location, Section, Staff, Supplier, EquipmentItem, InventoryItem, MonitoringRecord, SafetyIncident,
  EquipmentMaintenanceRecord, EquipmentBreakdown, MonitoringItem, MonitoringReading,
  InventoryBatch, OperationsSummary
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;

const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Location[]>('/locations').then(setLocations).catch(() => setLocations([]));
  }, []);
  return { staff, sections, locations };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

// ============= EQUIPMENT =============
type EquipmentDetail = EquipmentItem & { maintenance?: EquipmentMaintenanceRecord[]; breakdowns?: EquipmentBreakdown[]; links?: any[] };

export function EquipmentPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [selected, setSelected] = useState<EquipmentDetail | null>(null);
  const [equipForm, setEquipForm] = useState({ name: '', category: '', equipmentType: '', manufacturer: '', model: '', serialNumber: '', locationId: '', sectionId: '', status: 'operational', maintenanceFrequency: '', calibrationFrequency: '', nextMaintenanceDue: '', nextCalibrationDue: '', responsibleStaffId: '', dateReceived: '', calibrationRequired: false, notes: '' });
  const [maintForm, setMaintForm] = useState({ equipmentId: '', maintenanceDate: '', maintenanceType: 'preventive', performedByStaffId: '', findings: '', actionTaken: '', nextDueDate: '', status: 'completed' });
  const [breakdownForm, setBreakdownForm] = useState({ equipmentId: '', breakdownDate: '', reportedByStaffId: '', description: '', serviceImpact: '', immediateAction: '', equipmentStatus: 'out_of_service', repairAction: '', serviceProvider: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [list, ops] = await Promise.all([
        api<EquipmentItem[]>('/equipment'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null)
      ]);
      setEquipment(list);
      if (ops) setSummary(ops);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (isEnabled('equipment')) void load(); }, [isEnabled]);

  if (!isEnabled('equipment')) return <DisabledModule />;

  async function openDetail(id: number) {
    try { setSelected(await api<EquipmentDetail>(`/equipment/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitEquipment(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/equipment', { method: 'POST', body: JSON.stringify(equipForm) });
      setEquipForm({ name: '', category: '', equipmentType: '', manufacturer: '', model: '', serialNumber: '', locationId: '', sectionId: '', status: 'operational', maintenanceFrequency: '', calibrationFrequency: '', nextMaintenanceDue: '', nextCalibrationDue: '', responsibleStaffId: '', dateReceived: '', calibrationRequired: false, notes: '' });
      await load();
      setTab('Equipment Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitMaintenance(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!maintForm.equipmentId) return setError('Select an equipment item');
    try {
      await api(`/equipment/${maintForm.equipmentId}/maintenance`, { method: 'POST', body: JSON.stringify(maintForm) });
      setMaintForm({ equipmentId: '', maintenanceDate: '', maintenanceType: 'preventive', performedByStaffId: '', findings: '', actionTaken: '', nextDueDate: '', status: 'completed' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitBreakdown(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!breakdownForm.equipmentId) return setError('Select an equipment item');
    try {
      await api(`/equipment/${breakdownForm.equipmentId}/breakdown`, { method: 'POST', body: JSON.stringify(breakdownForm) });
      setBreakdownForm({ equipmentId: '', breakdownDate: '', reportedByStaffId: '', description: '', serviceImpact: '', immediateAction: '', equipmentStatus: 'out_of_service', repairAction: '', serviceProvider: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createBreakdownNc(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function createBreakdownCapa(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); }
    catch (e) { setError((e as Error).message); }
  }
  async function returnToService(breakdownId: number) {
    try { await api(`/equipment/breakdowns/${breakdownId}/return-to-service`, { method: 'POST', body: JSON.stringify({ equipmentStatus: 'operational' }) }); if (selected) await openDetail(selected.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <PageHeader eyebrow="Operations" title="Equipment Management" subtitle="Asset register, maintenance, calibration, and breakdown tracking." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBar(tab, ['Dashboard', 'Equipment Register', 'New Equipment', 'Maintenance Records', 'Breakdowns', 'Reports placeholder'], setTab)}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Equipment items', value: summary?.equipmentTotal ?? equipment.length },
      { label: 'Maintenance due', value: summary?.equipmentMaintenanceDue },
      { label: 'Calibration due', value: summary?.equipmentCalibrationDue },
      { label: 'Out of service', value: summary?.equipmentOutOfService, tone: 'danger' },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Fleet availability" subtitle="Operational vs out-of-service equipment">
        <DonutChart centerLabel="Assets" data={[
          { label: 'In service', value: Math.max(0, (summary?.equipmentTotal ?? equipment.length) - (summary?.equipmentOutOfService ?? 0)), color: CHART_COLORS[1] },
          { label: 'Out of service', value: summary?.equipmentOutOfService ?? 0, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Service schedule" subtitle="Equipment approaching or past due">
        <BarMeter data={[
          { label: 'Maintenance due', value: summary?.equipmentMaintenanceDue, color: CHART_COLORS[0] },
          { label: 'Calibration due', value: summary?.equipmentCalibrationDue, color: CHART_COLORS[2] },
          { label: 'Out of service', value: summary?.equipmentOutOfService, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Equipment Register' && <div className="card">
      <h3>Equipment register</h3>
      {loading ? <p>Loading…</p> : equipment.length === 0 ? <p>No equipment items have been recorded yet.</p> :
        <table className="table"><thead><tr><th>No.</th><th>Name</th><th>Category</th><th>Status</th><th>Location</th><th>Maint. due</th><th>Cal. due</th><th></th></tr></thead><tbody>
          {equipment.map(item => <tr key={item.id}>
            <td>{item.equipment_number}</td><td>{item.name}</td><td>{item.category || '—'}</td><td>{formatBadge(item.status)}</td>
            <td>{locations.find(l => l.id === item.location_id)?.name || '—'}</td>
            <td>{item.next_maintenance_due || item.next_service_due || '—'}</td>
            <td>{item.next_calibration_due || item.calibration_due_date || '—'}</td>
            <td><button className="secondary" type="button" onClick={() => openDetail(item.id)}>Open</button></td>
          </tr>)}
        </tbody></table>}
      {selected && <EquipmentDetailPanel item={selected} staff={staff} onClose={() => setSelected(null)} createBreakdownNc={createBreakdownNc} createBreakdownCapa={createBreakdownCapa} returnToService={returnToService} />}
    </div>}

    {tab === 'New Equipment' && <div className="card">
      <h3>New equipment</h3>
      <form className="form" onSubmit={submitEquipment}>
        <label>Name<input value={equipForm.name} onChange={e => setEquipForm({ ...equipForm, name: e.target.value })} required /></label>
        <label>Category<input value={equipForm.category} onChange={e => setEquipForm({ ...equipForm, category: e.target.value })} /></label>
        <label>Equipment type<input value={equipForm.equipmentType} onChange={e => setEquipForm({ ...equipForm, equipmentType: e.target.value })} /></label>
        <label>Manufacturer<input value={equipForm.manufacturer} onChange={e => setEquipForm({ ...equipForm, manufacturer: e.target.value })} /></label>
        <label>Model<input value={equipForm.model} onChange={e => setEquipForm({ ...equipForm, model: e.target.value })} /></label>
        <label>Serial number<input value={equipForm.serialNumber} onChange={e => setEquipForm({ ...equipForm, serialNumber: e.target.value })} /></label>
        <label>Location<select value={equipForm.locationId} onChange={e => setEquipForm({ ...equipForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Section<select value={equipForm.sectionId} onChange={e => setEquipForm({ ...equipForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Responsible staff<select value={equipForm.responsibleStaffId} onChange={e => setEquipForm({ ...equipForm, responsibleStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Status<select value={equipForm.status} onChange={e => setEquipForm({ ...equipForm, status: e.target.value })}>{['active', 'operational', 'out_of_service', 'under_repair', 'restricted_use', 'retired'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Maintenance frequency<input value={equipForm.maintenanceFrequency} onChange={e => setEquipForm({ ...equipForm, maintenanceFrequency: e.target.value })} placeholder="e.g. monthly" /></label>
        <label>Next maintenance due<input type="date" value={equipForm.nextMaintenanceDue} onChange={e => setEquipForm({ ...equipForm, nextMaintenanceDue: e.target.value })} /></label>
        <label>Calibration frequency<input value={equipForm.calibrationFrequency} onChange={e => setEquipForm({ ...equipForm, calibrationFrequency: e.target.value })} /></label>
        <label>Next calibration due<input type="date" value={equipForm.nextCalibrationDue} onChange={e => setEquipForm({ ...equipForm, nextCalibrationDue: e.target.value })} /></label>
        <label>Date received<input type="date" value={equipForm.dateReceived} onChange={e => setEquipForm({ ...equipForm, dateReceived: e.target.value })} /></label>
        <label><input type="checkbox" checked={equipForm.calibrationRequired} onChange={e => setEquipForm({ ...equipForm, calibrationRequired: e.target.checked })} /> Calibration required</label>
        <label>Notes<textarea value={equipForm.notes} onChange={e => setEquipForm({ ...equipForm, notes: e.target.value })} /></label>
        <button type="submit">Save equipment</button>
      </form>
    </div>}

    {tab === 'Maintenance Records' && <div className="card">
      <h3>Add maintenance record</h3>
      <form className="form" onSubmit={submitMaintenance}>
        <label>Equipment<select value={maintForm.equipmentId} onChange={e => setMaintForm({ ...maintForm, equipmentId: e.target.value })} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
        <label>Maintenance date<input type="date" value={maintForm.maintenanceDate} onChange={e => setMaintForm({ ...maintForm, maintenanceDate: e.target.value })} required /></label>
        <label>Maintenance type<select value={maintForm.maintenanceType} onChange={e => setMaintForm({ ...maintForm, maintenanceType: e.target.value })} required>{['preventive', 'corrective', 'calibration', 'verification', 'service'].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Performed by<select value={maintForm.performedByStaffId} onChange={e => setMaintForm({ ...maintForm, performedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Findings<textarea value={maintForm.findings} onChange={e => setMaintForm({ ...maintForm, findings: e.target.value })} /></label>
        <label>Action taken<textarea value={maintForm.actionTaken} onChange={e => setMaintForm({ ...maintForm, actionTaken: e.target.value })} /></label>
        <label>Next due date<input type="date" value={maintForm.nextDueDate} onChange={e => setMaintForm({ ...maintForm, nextDueDate: e.target.value })} /></label>
        <label>Status<select value={maintForm.status} onChange={e => setMaintForm({ ...maintForm, status: e.target.value })}>{['completed', 'pending', 'verified'].map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        <button type="submit">Save maintenance</button>
      </form>
    </div>}

    {tab === 'Breakdowns' && <div className="card">
      <h3>Report breakdown</h3>
      <form className="form" onSubmit={submitBreakdown}>
        <label>Equipment<select value={breakdownForm.equipmentId} onChange={e => setBreakdownForm({ ...breakdownForm, equipmentId: e.target.value })} required><option value="">Select equipment</option>{equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}</select></label>
        <label>Breakdown date<input type="date" value={breakdownForm.breakdownDate} onChange={e => setBreakdownForm({ ...breakdownForm, breakdownDate: e.target.value })} required /></label>
        <label>Reported by<select value={breakdownForm.reportedByStaffId} onChange={e => setBreakdownForm({ ...breakdownForm, reportedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Description<textarea value={breakdownForm.description} onChange={e => setBreakdownForm({ ...breakdownForm, description: e.target.value })} required /></label>
        <label>Service impact<input value={breakdownForm.serviceImpact} onChange={e => setBreakdownForm({ ...breakdownForm, serviceImpact: e.target.value })} /></label>
        <label>Immediate action<textarea value={breakdownForm.immediateAction} onChange={e => setBreakdownForm({ ...breakdownForm, immediateAction: e.target.value })} /></label>
        <label>Equipment status<select value={breakdownForm.equipmentStatus} onChange={e => setBreakdownForm({ ...breakdownForm, equipmentStatus: e.target.value })}>{['out_of_service', 'under_repair', 'restricted_use'].map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Repair action<textarea value={breakdownForm.repairAction} onChange={e => setBreakdownForm({ ...breakdownForm, repairAction: e.target.value })} /></label>
        <label>Service provider<input value={breakdownForm.serviceProvider} onChange={e => setBreakdownForm({ ...breakdownForm, serviceProvider: e.target.value })} /></label>
        <button type="submit">Report breakdown</button>
      </form>
    </div>}

    {tab === 'Reports placeholder' && <div className="card"><p>Reporting and exports for equipment will be added in a later phase.</p></div>}
  </div>;
}

function EquipmentDetailPanel({ item, staff, onClose, createBreakdownNc, createBreakdownCapa, returnToService }: { item: EquipmentDetail; staff: Staff[]; onClose: () => void; createBreakdownNc: (id: number) => void; createBreakdownCapa: (id: number) => void; returnToService: (id: number) => void }) {
  return <div className="card" style={{ marginTop: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <h3>{item.equipment_number} — {item.name}</h3>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
    <p>Status: {formatBadge(item.status)} | Responsible: {staffName(staff, item.responsible_staff_id || item.assigned_to_staff_id)} | Next maintenance: {item.next_maintenance_due || item.next_service_due || '—'} | Next calibration: {item.next_calibration_due || item.calibration_due_date || '—'}</p>
    <h4>Maintenance history</h4>
    {!item.maintenance?.length ? <p>No maintenance recorded.</p> : <table className="table"><thead><tr><th>Date</th><th>Type</th><th>Performed by</th><th>Findings</th><th>Next due</th><th>Status</th></tr></thead><tbody>
      {item.maintenance.map(m => <tr key={m.id}><td>{m.maintenance_date}</td><td>{m.maintenance_type}</td><td>{staffName(staff, m.performed_by_staff_id)}</td><td>{m.findings || '—'}</td><td>{m.next_due_date || '—'}</td><td>{formatBadge(m.status)}</td></tr>)}
    </tbody></table>}
    <h4>Breakdowns</h4>
    {!item.breakdowns?.length ? <p>No breakdowns recorded.</p> : <table className="table"><thead><tr><th>Date</th><th>Description</th><th>Status</th><th>NC</th><th>CAPA</th><th>Actions</th></tr></thead><tbody>
      {item.breakdowns.map(b => <tr key={b.id}><td>{b.breakdown_date}</td><td>{b.description}</td><td>{formatBadge(b.status)}</td><td>{b.nc_id || '—'}</td><td>{b.capa_id || '—'}</td>
        <td>
          {!b.nc_id && <button type="button" className="secondary" onClick={() => createBreakdownNc(b.id)}>Create NC</button>}{' '}
          {!b.capa_id && <button type="button" className="secondary" onClick={() => createBreakdownCapa(b.id)}>Create CAPA</button>}{' '}
          {b.status !== 'returned_to_service' && b.status !== 'closed' && <button type="button" className="secondary" onClick={() => returnToService(b.id)}>Return to service</button>}
        </td></tr>)}
    </tbody></table>}
    <h4>Linked records</h4>
    {!item.links?.length ? <p>No linked records.</p> : <ul>{item.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` (${l.notes})` : ''}</li>)}</ul>}
  </div>;
}

// ============= INVENTORY =============
type InventoryItemDetail = InventoryItem & { batches?: InventoryBatch[]; movements?: any[] };

export function InventoryPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [selected, setSelected] = useState<InventoryItemDetail | null>(null);
  const [itemForm, setItemForm] = useState({ name: '', category: '', supplierId: '', locationId: '', sectionId: '', quantity: 0, unit: '', minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available' });
  const [batchForm, setBatchForm] = useState({ itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0, dateReceived: '', expiryDate: '', storageLocationId: '' });
  const [movementForm, setMovementForm] = useState({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '' });
  const [supplierForm, setSupplierForm] = useState({ name: '', contactPerson: '', phone: '', email: '', address: '', itemCategory: '', evaluationRequired: false });
  const [evalForm, setEvalForm] = useState({ supplierId: '', evaluationDate: '', rating: '', findings: '', actionRequired: '', nextEvaluationDate: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [its, bts, sups, ops] = await Promise.all([
        api<InventoryItem[]>('/supplier-inventory/items'),
        api<InventoryBatch[]>('/supplier-inventory/batches'),
        api<Supplier[]>('/supplier-inventory/suppliers'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null)
      ]);
      setItems(its); setBatches(bts); setSuppliers(sups);
      if (ops) setSummary(ops);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (isEnabled('supplier_inventory')) void load(); }, [isEnabled]);

  if (!isEnabled('supplier_inventory')) return <DisabledModule />;

  async function openDetail(id: number) {
    try { setSelected(await api<InventoryItemDetail>(`/supplier-inventory/items/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitItem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/supplier-inventory/items', { method: 'POST', body: JSON.stringify(itemForm) });
      setItemForm({ name: '', category: '', supplierId: '', locationId: '', sectionId: '', quantity: 0, unit: '', minimumStock: 0, reorderLevel: 0, expiryDate: '', storageRequirement: '', status: 'available' });
      await load(); setTab('Item Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitBatch(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!batchForm.itemId) return setError('Select an item');
    try {
      await api(`/supplier-inventory/items/${batchForm.itemId}/batches`, { method: 'POST', body: JSON.stringify(batchForm) });
      setBatchForm({ itemId: '', batchNumber: '', lotNumber: '', supplierId: '', quantityReceived: 0, quantityAvailable: 0, dateReceived: '', expiryDate: '', storageLocationId: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitMovement(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!movementForm.batchId) return setError('Select a batch');
    try {
      await api(`/supplier-inventory/batches/${movementForm.batchId}/movement`, { method: 'POST', body: JSON.stringify(movementForm) });
      setMovementForm({ batchId: '', movementType: 'issue', quantity: 0, movementDate: '', issuedToSectionId: '', receivedByStaffId: '', reason: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitSupplier(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/supplier-inventory/suppliers', { method: 'POST', body: JSON.stringify(supplierForm) });
      setSupplierForm({ name: '', contactPerson: '', phone: '', email: '', address: '', itemCategory: '', evaluationRequired: false });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitEvaluation(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!evalForm.supplierId) return setError('Select a supplier');
    try {
      await api(`/supplier-inventory/suppliers/${evalForm.supplierId}/evaluation`, { method: 'POST', body: JSON.stringify(evalForm) });
      setEvalForm({ supplierId: '', evaluationDate: '', rating: '', findings: '', actionRequired: '', nextEvaluationDate: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function acceptBatch(batchId: number, status: string) {
    try { await api(`/supplier-inventory/batches/${batchId}/acceptance`, { method: 'POST', body: JSON.stringify({ acceptanceStatus: status }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function createBatchNc(batchId: number) {
    try { await api(`/supplier-inventory/batches/${batchId}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <PageHeader eyebrow="Operations" title="Supplier &amp; Inventory" subtitle="Reagents, supplies, stock levels, batches, and vendor records." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBar(tab, ['Dashboard', 'Item Register', 'New Item', 'Batches/Lots', 'Stock Movements', 'Suppliers', 'Reports placeholder'], setTab)}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Inventory items', value: items.length },
      { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, tone: 'warning' },
      { label: 'Expiring soon', value: summary?.inventoryExpiringSoon },
      { label: 'Expired', value: summary?.inventoryExpired, tone: 'danger' },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Stock health" subtitle="Items by supply risk">
        <DonutChart centerLabel="Items" data={[
          { label: 'Healthy', value: Math.max(0, items.length - (summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length) - (summary?.inventoryExpired ?? 0)), color: CHART_COLORS[1] },
          { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, color: CHART_COLORS[2] },
          { label: 'Expired', value: summary?.inventoryExpired ?? 0, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Replenishment signals" subtitle="Stock requiring action">
        <BarMeter data={[
          { label: 'Low stock', value: summary?.inventoryLowStock ?? items.filter(i => i.low_stock).length, color: CHART_COLORS[2] },
          { label: 'Expiring soon', value: summary?.inventoryExpiringSoon, color: CHART_COLORS[0] },
          { label: 'Expired', value: summary?.inventoryExpired, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Item Register' && <div className="card">
      <h3>Items</h3>
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No items yet.</p> :
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Qty</th><th>Unit</th><th>Min</th><th>Reorder</th><th>Expiry</th><th></th></tr></thead><tbody>
          {items.map(i => <tr key={i.id}><td>{i.item_code}</td><td>{i.name}</td><td>{i.category || '—'}</td>
            <td>{i.quantity}{i.low_stock && <span className="badge" style={{ marginLeft: 6, background: '#fff7df', color: '#6b4b05' }}>low</span>}</td>
            <td>{i.unit || '—'}</td><td>{i.minimum_stock || 0}</td><td>{i.reorder_level || 0}</td>
            <td>{i.expiry_date || '—'} {i.expiry_status && i.expiry_status !== 'valid' && <span className="badge" style={{ background: i.expiry_status === 'expired' ? '#fde2e2' : '#fff7df', color: i.expiry_status === 'expired' ? 'var(--danger)' : '#6b4b05' }}>{i.expiry_status.replace('_', ' ')}</span>}</td>
            <td><button type="button" className="secondary" onClick={() => openDetail(i.id)}>Open</button></td>
          </tr>)}
        </tbody></table>}
      {selected && <InventoryDetailPanel item={selected} staff={staff} onClose={() => setSelected(null)} acceptBatch={acceptBatch} createBatchNc={createBatchNc} />}
    </div>}

    {tab === 'New Item' && <div className="card">
      <h3>New inventory item</h3>
      <form className="form" onSubmit={submitItem}>
        <label>Name<input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} required /></label>
        <label>Category<input value={itemForm.category} onChange={e => setItemForm({ ...itemForm, category: e.target.value })} required /></label>
        <label>Unit of measure<input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} required /></label>
        <label>Supplier<select value={itemForm.supplierId} onChange={e => setItemForm({ ...itemForm, supplierId: e.target.value })}><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={itemForm.locationId} onChange={e => setItemForm({ ...itemForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Section<select value={itemForm.sectionId} onChange={e => setItemForm({ ...itemForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Minimum stock<input type="number" value={itemForm.minimumStock} onChange={e => setItemForm({ ...itemForm, minimumStock: Number(e.target.value) })} /></label>
        <label>Reorder level<input type="number" value={itemForm.reorderLevel} onChange={e => setItemForm({ ...itemForm, reorderLevel: Number(e.target.value) })} /></label>
        <label>Storage requirement<input value={itemForm.storageRequirement} onChange={e => setItemForm({ ...itemForm, storageRequirement: e.target.value })} placeholder="e.g. 2-8°C" /></label>
        <label>Status<select value={itemForm.status} onChange={e => setItemForm({ ...itemForm, status: e.target.value })}><option value="available">Available</option><option value="reserved">Reserved</option><option value="unavailable">Unavailable</option></select></label>
        <button type="submit">Save item</button>
      </form>
    </div>}

    {tab === 'Batches/Lots' && <div>
      <div className="card">
        <h3>Add batch / lot</h3>
        <form className="form" onSubmit={submitBatch}>
          <label>Item<select value={batchForm.itemId} onChange={e => setBatchForm({ ...batchForm, itemId: e.target.value })} required><option value="">Select item</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.name}</option>)}</select></label>
          <label>Batch number<input value={batchForm.batchNumber} onChange={e => setBatchForm({ ...batchForm, batchNumber: e.target.value })} /></label>
          <label>Lot number<input value={batchForm.lotNumber} onChange={e => setBatchForm({ ...batchForm, lotNumber: e.target.value })} /></label>
          <label>Supplier<select value={batchForm.supplierId} onChange={e => setBatchForm({ ...batchForm, supplierId: e.target.value })}><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Quantity received<input type="number" value={batchForm.quantityReceived} onChange={e => setBatchForm({ ...batchForm, quantityReceived: Number(e.target.value), quantityAvailable: Number(e.target.value) })} required /></label>
          <label>Quantity available<input type="number" value={batchForm.quantityAvailable} onChange={e => setBatchForm({ ...batchForm, quantityAvailable: Number(e.target.value) })} required /></label>
          <label>Date received<input type="date" value={batchForm.dateReceived} onChange={e => setBatchForm({ ...batchForm, dateReceived: e.target.value })} required /></label>
          <label>Expiry date<input type="date" value={batchForm.expiryDate} onChange={e => setBatchForm({ ...batchForm, expiryDate: e.target.value })} /></label>
          <label>Storage location<select value={batchForm.storageLocationId} onChange={e => setBatchForm({ ...batchForm, storageLocationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <button type="submit">Save batch</button>
        </form>
      </div>
      <div className="card">
        <h3>Batches (FEFO order)</h3>
        {batches.length === 0 ? <p>No batches recorded.</p> :
          <table className="table"><thead><tr><th>Item</th><th>Batch</th><th>Lot</th><th>Available</th><th>Expiry</th><th>Acceptance</th><th>Actions</th></tr></thead><tbody>
            {batches.map(b => <tr key={b.id}><td>{b.item_name || b.item_id}</td><td>{b.batch_number || '—'}</td><td>{b.lot_number || '—'}</td>
              <td>{b.quantity_available} {b.unit_of_measure || ''}</td>
              <td>{b.expiry_date || '—'} {b.expiry_status && b.expiry_status !== 'valid' && <span className="badge" style={{ background: b.expiry_status === 'expired' ? '#fde2e2' : '#fff7df', color: b.expiry_status === 'expired' ? 'var(--danger)' : '#6b4b05' }}>{b.expiry_status.replace('_', ' ')}</span>}</td>
              <td>{formatBadge(b.acceptance_status)}</td>
              <td>
                {b.acceptance_status === 'pending' && <>
                  <button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'accepted')}>Accept</button>{' '}
                  <button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'rejected')}>Reject</button>{' '}
                </>}
                <button type="button" className="secondary" onClick={() => createBatchNc(b.id)}>Create NC</button>
              </td>
            </tr>)}
          </tbody></table>}
      </div>
    </div>}

    {tab === 'Stock Movements' && <div className="card">
      <h3>Record stock movement</h3>
      <form className="form" onSubmit={submitMovement}>
        <label>Batch<select value={movementForm.batchId} onChange={e => setMovementForm({ ...movementForm, batchId: e.target.value })} required><option value="">Select batch</option>{batches.map(b => <option key={b.id} value={b.id}>{b.item_name} — {b.batch_number || `Batch #${b.id}`} (avail {b.quantity_available})</option>)}</select></label>
        <label>Movement type<select value={movementForm.movementType} onChange={e => setMovementForm({ ...movementForm, movementType: e.target.value })}>{['issue', 'consume', 'discard', 'waste', 'transfer_out', 'receive', 'return', 'adjust_in', 'transfer_in'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></label>
        <label>Quantity<input type="number" value={movementForm.quantity} onChange={e => setMovementForm({ ...movementForm, quantity: Number(e.target.value) })} required min={0.0001} step="any" /></label>
        <label>Movement date<input type="date" value={movementForm.movementDate} onChange={e => setMovementForm({ ...movementForm, movementDate: e.target.value })} /></label>
        <label>Issued to section<select value={movementForm.issuedToSectionId} onChange={e => setMovementForm({ ...movementForm, issuedToSectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Received by<select value={movementForm.receivedByStaffId} onChange={e => setMovementForm({ ...movementForm, receivedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Reason<input value={movementForm.reason} onChange={e => setMovementForm({ ...movementForm, reason: e.target.value })} /></label>
        <button type="submit">Record movement</button>
      </form>
    </div>}

    {tab === 'Suppliers' && <div>
      <div className="card">
        <h3>New supplier</h3>
        <form className="form" onSubmit={submitSupplier}>
          <label>Name<input value={supplierForm.name} onChange={e => setSupplierForm({ ...supplierForm, name: e.target.value })} required /></label>
          <label>Contact person<input value={supplierForm.contactPerson} onChange={e => setSupplierForm({ ...supplierForm, contactPerson: e.target.value })} /></label>
          <label>Phone<input value={supplierForm.phone} onChange={e => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></label>
          <label>Email<input value={supplierForm.email} onChange={e => setSupplierForm({ ...supplierForm, email: e.target.value })} /></label>
          <label>Address<input value={supplierForm.address} onChange={e => setSupplierForm({ ...supplierForm, address: e.target.value })} /></label>
          <label>Item category<input value={supplierForm.itemCategory} onChange={e => setSupplierForm({ ...supplierForm, itemCategory: e.target.value })} /></label>
          <label><input type="checkbox" checked={supplierForm.evaluationRequired} onChange={e => setSupplierForm({ ...supplierForm, evaluationRequired: e.target.checked })} /> Evaluation required</label>
          <button type="submit">Save supplier</button>
        </form>
      </div>
      <div className="card">
        <h3>Supplier evaluation</h3>
        <form className="form" onSubmit={submitEvaluation}>
          <label>Supplier<select value={evalForm.supplierId} onChange={e => setEvalForm({ ...evalForm, supplierId: e.target.value })} required><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Evaluation date<input type="date" value={evalForm.evaluationDate} onChange={e => setEvalForm({ ...evalForm, evaluationDate: e.target.value })} /></label>
          <label>Rating<input value={evalForm.rating} onChange={e => setEvalForm({ ...evalForm, rating: e.target.value })} placeholder="e.g. satisfactory" /></label>
          <label>Findings<textarea value={evalForm.findings} onChange={e => setEvalForm({ ...evalForm, findings: e.target.value })} /></label>
          <label>Action required<textarea value={evalForm.actionRequired} onChange={e => setEvalForm({ ...evalForm, actionRequired: e.target.value })} /></label>
          <label>Next evaluation date<input type="date" value={evalForm.nextEvaluationDate} onChange={e => setEvalForm({ ...evalForm, nextEvaluationDate: e.target.value })} /></label>
          <button type="submit">Record evaluation</button>
        </form>
      </div>
      <div className="card">
        <h3>Suppliers</h3>
        {suppliers.length === 0 ? <p>No suppliers.</p> :
          <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Contact</th><th>Last eval</th><th>Next eval</th><th>Status</th></tr></thead><tbody>
            {suppliers.map(s => <tr key={s.id}><td>{s.supplier_code}</td><td>{s.name}</td><td>{s.contact_person || s.contact || '—'}</td><td>{s.last_evaluation_date || '—'}</td><td>{s.next_evaluation_due || '—'}</td><td>{formatBadge(s.status)}</td></tr>)}
          </tbody></table>}
      </div>
    </div>}

    {tab === 'Reports placeholder' && <div className="card"><p>Reports for inventory will be added in a later phase.</p></div>}
  </div>;
}

function InventoryDetailPanel({ item, staff, onClose, acceptBatch, createBatchNc }: { item: InventoryItemDetail; staff: Staff[]; onClose: () => void; acceptBatch: (id: number, status: string) => void; createBatchNc: (id: number) => void }) {
  return <div className="card" style={{ marginTop: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <h3>{item.item_code} — {item.name}</h3>
      <button type="button" className="secondary" onClick={onClose}>Close</button>
    </div>
    <p>Quantity: {item.quantity} {item.unit} | Minimum: {item.minimum_stock} | Reorder: {item.reorder_level} | Expiry: {item.expiry_date || '—'}</p>
    <h4>Batches (FEFO)</h4>
    {!item.batches?.length ? <p>No batches.</p> : <table className="table"><thead><tr><th>Batch</th><th>Lot</th><th>Available</th><th>Expiry</th><th>Acceptance</th><th>Actions</th></tr></thead><tbody>
      {item.batches.map(b => <tr key={b.id}><td>{b.batch_number || '—'}</td><td>{b.lot_number || '—'}</td><td>{b.quantity_available}</td><td>{b.expiry_date || '—'}</td><td>{formatBadge(b.acceptance_status)}</td>
        <td>
          {b.acceptance_status === 'pending' && <><button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'accepted')}>Accept</button>{' '}<button type="button" className="secondary" onClick={() => acceptBatch(b.id, 'rejected')}>Reject</button>{' '}</>}
          <button type="button" className="secondary" onClick={() => createBatchNc(b.id)}>Create NC</button>
        </td></tr>)}
    </tbody></table>}
    <h4>Recent movements</h4>
    {!item.movements?.length ? <p>No movements.</p> : <table className="table"><thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Reason</th><th>Received by</th></tr></thead><tbody>
      {item.movements.map((m: any) => <tr key={m.id}><td>{m.movement_date}</td><td>{m.movement_type}</td><td>{m.quantity}</td><td>{m.reason || '—'}</td><td>{staffName(staff, m.received_by_staff_id)}</td></tr>)}
    </tbody></table>}
  </div>;
}

// ============= MONITORING =============
export function MonitoringPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [items, setItems] = useState<MonitoringItem[]>([]);
  const [readings, setReadings] = useState<MonitoringReading[]>([]);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [legacyRecords, setLegacyRecords] = useState<MonitoringRecord[]>([]);
  const [itemForm, setItemForm] = useState({ name: '', monitoringType: '', parameter: '', unit: '', sectionId: '', locationId: '', lowerLimit: '', upperLimit: '', warningLowerLimit: '', warningUpperLimit: '', criticalLowerLimit: '', criticalUpperLimit: '', frequency: '', responsibleStaffId: '', ncTriggerEnabled: false });
  const [readingForm, setReadingForm] = useState({ itemId: '', readingDate: '', readingTime: '', value: '', comment: '', immediateAction: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [its, rds, ops, legacy] = await Promise.all([
        api<MonitoringItem[]>('/monitoring/items'),
        api<MonitoringReading[]>('/monitoring/readings'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null),
        api<MonitoringRecord[]>('/monitoring').catch(() => [])
      ]);
      setItems(its); setReadings(rds); setLegacyRecords(legacy);
      if (ops) setSummary(ops);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (isEnabled('monitoring')) void load(); }, [isEnabled]);

  if (!isEnabled('monitoring')) return <DisabledModule />;

  const excursions = useMemo(() => readings.filter(r => r.status !== 'normal'), [readings]);

  async function submitItem(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/monitoring/items', { method: 'POST', body: JSON.stringify(itemForm) });
      setItemForm({ name: '', monitoringType: '', parameter: '', unit: '', sectionId: '', locationId: '', lowerLimit: '', upperLimit: '', warningLowerLimit: '', warningUpperLimit: '', criticalLowerLimit: '', criticalUpperLimit: '', frequency: '', responsibleStaffId: '', ncTriggerEnabled: false });
      await load(); setTab('Monitoring Items');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitReading(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!readingForm.itemId) return setError('Select a monitoring item');
    try {
      await api(`/monitoring/items/${readingForm.itemId}/readings`, { method: 'POST', body: JSON.stringify(readingForm) });
      setReadingForm({ itemId: '', readingDate: '', readingTime: '', value: '', comment: '', immediateAction: '' });
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function createNcForReading(id: number) {
    try { await api(`/monitoring/readings/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function createCapaForReading(id: number) {
    try { await api(`/monitoring/readings/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function reviewReading(id: number) {
    try { await api(`/monitoring/readings/${id}/review`, { method: 'POST', body: JSON.stringify({}) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  return <div>
    <PageHeader eyebrow="Operations" title="Environmental Monitoring" subtitle="Temperature and environment readings, excursions, and trends." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBar(tab, ['Dashboard', 'Monitoring Items', 'New Monitoring Item', 'Enter Reading', 'Excursions', 'Monthly Charts placeholder'], setTab)}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Monitoring items', value: items.length },
      { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, tone: 'warning' },
      { label: 'Critical / out-of-range', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, tone: 'danger' },
      { label: 'Legacy records', value: legacyRecords.length },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Environmental status" subtitle="Latest reading status mix">
        <DonutChart centerLabel="Status" data={[
          { label: 'In range', value: Math.max(0, readings.filter(r => r.status === 'ok' || r.status === 'normal').length), color: CHART_COLORS[1] },
          { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, color: CHART_COLORS[2] },
          { label: 'Critical', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
      <ChartCard title="Excursion load" subtitle="Out-of-range signals to review">
        <BarMeter data={[
          { label: 'Warnings', value: summary?.monitoringWarnings ?? readings.filter(r => r.status === 'warning').length, color: CHART_COLORS[2] },
          { label: 'Critical', value: summary?.monitoringCritical ?? excursions.filter(r => r.status !== 'warning').length, color: CHART_COLORS[3] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Monitoring Items' && <div className="card">
      <h3>Monitoring items</h3>
      {loading ? <p>Loading…</p> : items.length === 0 ? <p>No monitoring items configured.</p> :
        <table className="table"><thead><tr><th>Code</th><th>Name</th><th>Parameter</th><th>Unit</th><th>Limits</th><th>Frequency</th><th>NC trigger</th></tr></thead><tbody>
          {items.map(i => <tr key={i.id}><td>{i.item_code}</td><td>{i.name}</td><td>{i.parameter}</td><td>{i.unit || '—'}</td>
            <td>{i.lower_limit ?? '—'} … {i.upper_limit ?? '—'}{i.warning_lower_limit !== undefined && i.warning_lower_limit !== null ? <span style={{ color: 'var(--warning)' }}> (warn {i.warning_lower_limit}…{i.warning_upper_limit})</span> : null}</td>
            <td>{i.frequency || '—'}</td><td>{i.nc_trigger_enabled ? 'yes' : 'no'}</td></tr>)}
        </tbody></table>}
    </div>}

    {tab === 'New Monitoring Item' && <div className="card">
      <h3>New monitoring item</h3>
      <form className="form" onSubmit={submitItem}>
        <label>Name<input value={itemForm.name} onChange={e => setItemForm({ ...itemForm, name: e.target.value })} required /></label>
        <label>Monitoring type<input value={itemForm.monitoringType} onChange={e => setItemForm({ ...itemForm, monitoringType: e.target.value })} placeholder="e.g. fridge, freezer, room temp" /></label>
        <label>Parameter<input value={itemForm.parameter} onChange={e => setItemForm({ ...itemForm, parameter: e.target.value })} required placeholder="e.g. temperature" /></label>
        <label>Unit<input value={itemForm.unit} onChange={e => setItemForm({ ...itemForm, unit: e.target.value })} required placeholder="°C" /></label>
        <label>Section<select value={itemForm.sectionId} onChange={e => setItemForm({ ...itemForm, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Location<select value={itemForm.locationId} onChange={e => setItemForm({ ...itemForm, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Lower limit<input type="number" step="any" value={itemForm.lowerLimit} onChange={e => setItemForm({ ...itemForm, lowerLimit: e.target.value })} required /></label>
        <label>Upper limit<input type="number" step="any" value={itemForm.upperLimit} onChange={e => setItemForm({ ...itemForm, upperLimit: e.target.value })} required /></label>
        <label>Warning lower<input type="number" step="any" value={itemForm.warningLowerLimit} onChange={e => setItemForm({ ...itemForm, warningLowerLimit: e.target.value })} /></label>
        <label>Warning upper<input type="number" step="any" value={itemForm.warningUpperLimit} onChange={e => setItemForm({ ...itemForm, warningUpperLimit: e.target.value })} /></label>
        <label>Critical lower<input type="number" step="any" value={itemForm.criticalLowerLimit} onChange={e => setItemForm({ ...itemForm, criticalLowerLimit: e.target.value })} /></label>
        <label>Critical upper<input type="number" step="any" value={itemForm.criticalUpperLimit} onChange={e => setItemForm({ ...itemForm, criticalUpperLimit: e.target.value })} /></label>
        <label>Frequency<input value={itemForm.frequency} onChange={e => setItemForm({ ...itemForm, frequency: e.target.value })} placeholder="e.g. daily" /></label>
        <label>Responsible staff<select value={itemForm.responsibleStaffId} onChange={e => setItemForm({ ...itemForm, responsibleStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label><input type="checkbox" checked={itemForm.ncTriggerEnabled} onChange={e => setItemForm({ ...itemForm, ncTriggerEnabled: e.target.checked })} /> Enable NC trigger button on critical/out-of-range</label>
        <button type="submit">Save monitoring item</button>
      </form>
    </div>}

    {tab === 'Enter Reading' && <div className="card">
      <h3>Enter reading</h3>
      <form className="form" onSubmit={submitReading}>
        <label>Monitoring item<select value={readingForm.itemId} onChange={e => setReadingForm({ ...readingForm, itemId: e.target.value })} required><option value="">Select item</option>{items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.name} ({i.lower_limit}…{i.upper_limit} {i.unit})</option>)}</select></label>
        <label>Reading date<input type="date" value={readingForm.readingDate} onChange={e => setReadingForm({ ...readingForm, readingDate: e.target.value })} required /></label>
        <label>Reading time<input type="time" value={readingForm.readingTime} onChange={e => setReadingForm({ ...readingForm, readingTime: e.target.value })} /></label>
        <label>Value<input type="number" step="any" value={readingForm.value} onChange={e => setReadingForm({ ...readingForm, value: e.target.value })} required /></label>
        <label>Comment<textarea value={readingForm.comment} onChange={e => setReadingForm({ ...readingForm, comment: e.target.value })} placeholder="Required for abnormal readings" /></label>
        <label>Immediate action<textarea value={readingForm.immediateAction} onChange={e => setReadingForm({ ...readingForm, immediateAction: e.target.value })} placeholder="Required for abnormal readings" /></label>
        <button type="submit">Save reading</button>
      </form>
    </div>}

    {tab === 'Excursions' && <div className="card">
      <h3>Excursions</h3>
      {excursions.length === 0 ? <p>No excursions recorded.</p> :
        <table className="table"><thead><tr><th>Date</th><th>Item</th><th>Value</th><th>Status</th><th>Comment</th><th>Actions</th></tr></thead><tbody>
          {excursions.map(r => <tr key={r.id}><td>{r.reading_date}</td><td>{r.item_name || items.find(i => i.id === r.monitoring_item_id)?.name}</td><td>{r.value} {r.item_unit}</td><td>{formatBadge(r.status)}</td><td>{r.comment || '—'}</td>
            <td>
              {!r.reviewed_at && <button type="button" className="secondary" onClick={() => reviewReading(r.id)}>Review</button>}{' '}
              {!r.nc_id && (r.status === 'critical' || r.status === 'out_of_range') && <button type="button" className="secondary" onClick={() => createNcForReading(r.id)}>Create NC</button>}{' '}
              {!r.capa_id && <button type="button" className="secondary" onClick={() => createCapaForReading(r.id)}>Create CAPA</button>}
            </td></tr>)}
        </tbody></table>}
    </div>}

    {tab === 'Monthly Charts placeholder' && <div className="card"><p>Monthly trend charts will be added in a later phase.</p></div>}
  </div>;
}

// ============= SAFETY =============
export function SafetyPage() {
  const { isEnabled } = useModules();
  const { staff, sections, locations } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [incidents, setIncidents] = useState<SafetyIncident[]>([]);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [selected, setSelected] = useState<(SafetyIncident & { links?: any[] }) | null>(null);
  const [form, setForm] = useState({ incidentDate: '', incidentType: '', title: '', description: '', category: '', severity: '', sectionId: '', locationId: '', reportedByStaffId: '', immediateAction: '', personsInvolved: '', reportedTo: '', status: 'open' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [list, ops] = await Promise.all([
        api<SafetyIncident[]>('/facilities-safety/incidents'),
        api<OperationsSummary>('/dashboard/operations-summary').catch(() => null)
      ]);
      setIncidents(list);
      if (ops) setSummary(ops);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (isEnabled('facilities_safety')) void load(); }, [isEnabled]);

  if (!isEnabled('facilities_safety')) return <DisabledModule />;

  async function openDetail(id: number) {
    try { setSelected(await api<SafetyIncident & { links?: any[] }>(`/facilities-safety/incidents/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      await api('/facilities-safety/incidents', { method: 'POST', body: JSON.stringify(form) });
      setForm({ incidentDate: '', incidentType: '', title: '', description: '', category: '', severity: '', sectionId: '', locationId: '', reportedByStaffId: '', immediateAction: '', personsInvolved: '', reportedTo: '', status: 'open' });
      await load(); setTab('Safety Incidents');
    } catch (e) { setError((e as Error).message); }
  }

  async function createNc(id: number) { try { await api(`/facilities-safety/incidents/${id}/create-nc`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function createCapa(id: number) { try { await api(`/facilities-safety/incidents/${id}/create-capa`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }
  async function closeIncident(id: number) { try { await api(`/facilities-safety/incidents/${id}/close`, { method: 'POST', body: JSON.stringify({}) }); if (selected) await openDetail(selected.id); await load(); } catch (e) { setError((e as Error).message); } }

  return <div>
    <PageHeader eyebrow="Operations" title="Facilities &amp; Safety" subtitle="Safety incidents, inspections, and facility checks." />
    {error && <div className="card" style={{ color: 'var(--danger)' }}>{error}</div>}
    {tabBar(tab, ['Dashboard', 'Safety Incidents', 'New Incident', 'Safety Actions placeholder', 'Reports placeholder'], setTab)}

    {tab === 'Dashboard' && <><KpiStrip items={[
      { label: 'Incidents', value: incidents.length },
      { label: 'Open', value: summary?.openSafetyIncidents ?? incidents.filter(i => i.status !== 'closed').length },
      { label: 'Action required', value: incidents.filter(i => i.status === 'action_required').length, tone: 'warning' },
      { label: 'Closed', value: incidents.filter(i => i.status === 'closed').length, tone: 'success' },
    ]} />
    <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Incident status" subtitle="Safety incidents by resolution state">
        <DonutChart centerLabel="Incidents" data={[
          { label: 'Action required', value: incidents.filter(i => i.status === 'action_required').length, color: CHART_COLORS[3] },
          { label: 'Open (other)', value: incidents.filter(i => i.status !== 'closed' && i.status !== 'action_required').length, color: CHART_COLORS[0] },
          { label: 'Closed', value: incidents.filter(i => i.status === 'closed').length, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
      <ChartCard title="Open vs closed" subtitle="Overall resolution progress">
        <BarChart data={[
          { label: 'Open', value: summary?.openSafetyIncidents ?? incidents.filter(i => i.status !== 'closed').length, color: CHART_COLORS[2] },
          { label: 'Action req.', value: incidents.filter(i => i.status === 'action_required').length, color: CHART_COLORS[3] },
          { label: 'Closed', value: incidents.filter(i => i.status === 'closed').length, color: CHART_COLORS[1] },
        ]} />
      </ChartCard>
    </div></>}

    {tab === 'Safety Incidents' && <div className="card">
      <h3>Incident register</h3>
      {loading ? <p>Loading…</p> : incidents.length === 0 ? <p>No incidents recorded.</p> :
        <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Title</th><th>Severity</th><th>Status</th><th></th></tr></thead><tbody>
          {incidents.map(i => <tr key={i.id}><td>{i.incident_number}</td><td>{i.incident_date}</td><td>{i.title || (i.description || '').slice(0, 80)}</td><td>{i.severity || '—'}</td><td>{formatBadge(i.status)}</td><td><button type="button" className="secondary" onClick={() => openDetail(i.id)}>Open</button></td></tr>)}
        </tbody></table>}
      {selected && <SafetyDetailPanel item={selected} staff={staff} onClose={() => setSelected(null)} createNc={createNc} createCapa={createCapa} closeIncident={closeIncident} />}
    </div>}

    {tab === 'New Incident' && <div className="card">
      <h3>Report safety incident</h3>
      <form className="form" onSubmit={submit}>
        <label>Incident date<input type="date" value={form.incidentDate} onChange={e => setForm({ ...form, incidentDate: e.target.value })} required /></label>
        <label>Incident type<input value={form.incidentType} onChange={e => setForm({ ...form, incidentType: e.target.value })} placeholder="e.g. spill, exposure, injury" /></label>
        <label>Title<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /></label>
        <label>Description<textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></label>
        <label>Severity<select value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })} required><option value="">Select severity</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Category<input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
        <label>Location<select value={form.locationId} onChange={e => setForm({ ...form, locationId: e.target.value })}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>Section<select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value })}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Reported by<select value={form.reportedByStaffId} onChange={e => setForm({ ...form, reportedByStaffId: e.target.value })}><option value="">Select staff</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Immediate action<textarea value={form.immediateAction} onChange={e => setForm({ ...form, immediateAction: e.target.value })} /></label>
        <label>Persons involved<input value={form.personsInvolved} onChange={e => setForm({ ...form, personsInvolved: e.target.value })} /></label>
        <label>Reported to<input value={form.reportedTo} onChange={e => setForm({ ...form, reportedTo: e.target.value })} /></label>
        <button type="submit">Report incident</button>
      </form>
    </div>}

    {tab === 'Safety Actions placeholder' && <div className="card"><p>Safety actions tracker will be added in a later phase.</p></div>}
    {tab === 'Reports placeholder' && <div className="card"><p>Safety reports will be added in a later phase.</p></div>}
  </div>;
}

function SafetyDetailPanel({ item, staff, onClose, createNc, createCapa, closeIncident }: { item: SafetyIncident & { links?: any[] }; staff: Staff[]; onClose: () => void; createNc: (id: number) => void; createCapa: (id: number) => void; closeIncident: (id: number) => void }) {
  return <div className="card" style={{ marginTop: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <h3>{item.incident_number} — {item.title || (item.description || '').slice(0, 80)}</h3>
      <button type="button" className="secondary" onClick={onClose}>Close panel</button>
    </div>
    <p>Status: {formatBadge(item.status)} | Severity: {item.severity || '—'} | Reported by: {staffName(staff, item.reported_by_staff_id)} | Date: {item.incident_date}</p>
    {item.description && <p><strong>Description:</strong> {item.description}</p>}
    {item.immediate_action && <p><strong>Immediate action:</strong> {item.immediate_action}</p>}
    {item.persons_involved && <p><strong>Persons involved:</strong> {item.persons_involved}</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {!item.nc_id && <button type="button" className="secondary" onClick={() => createNc(item.id)}>Create NC</button>}
      {!item.capa_id && <button type="button" className="secondary" onClick={() => createCapa(item.id)}>Create CAPA</button>}
      {item.status !== 'closed' && <button type="button" className="secondary" onClick={() => closeIncident(item.id)}>Close incident</button>}
    </div>
    <h4 style={{ marginTop: 16 }}>Linked records</h4>
    {!item.links?.length ? <p>No linked records.</p> : <ul>{item.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` (${l.notes})` : ''}</li>)}</ul>}
  </div>;
}
