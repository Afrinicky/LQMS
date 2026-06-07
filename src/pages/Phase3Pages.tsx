import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useModules } from '../hooks/useModules';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type { Location, Section, Staff, Supplier, EquipmentItem, InventoryItem, MonitoringRecord, SafetyIncident } from '../../shared/types/api';

function formatBadge(value?: string) {
  return <span className={`badge ${value?.toLowerCase().replace(/\s+/g, '-') ?? 'unknown'}`}>{value ?? 'Unknown'}</span>;
}

export function EquipmentPage() {
  const { isEnabled } = useModules();
  const [equipment, setEquipment] = useState<EquipmentItem[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [formState, setFormState] = useState({ name: '', category: '', manufacturer: '', model: '', serialNumber: '', locationId: '', sectionId: '', status: 'operational' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEnabled('equipment')) return;
    setLoading(true);
    void Promise.all([
      api<EquipmentItem[]>('/equipment'),
      api<Section[]>('/sections'),
      api<Location[]>('/locations'),
      api<Staff[]>('/staff')
    ]).then(([equipmentData, sectionData, locationData, staffData]) => {
      setEquipment(equipmentData);
      setSections(sectionData);
      setLocations(locationData);
      setStaff(staffData);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [isEnabled]);

  const summary = useMemo(() => ({ total: equipment.length, operational: equipment.filter(e => e.status === 'operational').length, serviceDue: equipment.filter(e => e.next_service_due && new Date(e.next_service_due) <= new Date()).length }), [equipment]);

  if (!isEnabled('equipment')) return <DisabledModule />;

  const createEquipment = async (event: FormEvent) => {
    event.preventDefault();
    await api('/equipment', { method: 'POST', body: JSON.stringify({ ...formState, locationId: formState.locationId || null, sectionId: formState.sectionId || null }) });
    setFormState({ name: '', category: '', manufacturer: '', model: '', serialNumber: '', locationId: '', sectionId: '', status: 'operational' });
    setLoading(true);
    setEquipment(await api<EquipmentItem[]>('/equipment'));
    setLoading(false);
  };

  return <div>
    <h2>Equipment Management</h2>
    <div className="grid cols-4">
      <div className="card metric"><span>Items</span><br/><strong>{summary.total}</strong></div>
      <div className="card metric"><span>Operational</span><br/><strong>{summary.operational}</strong></div>
      <div className="card metric"><span>Service due</span><br/><strong>{summary.serviceDue}</strong></div>
      <div className="card metric"><span>Locations</span><br/><strong>{locations.length}</strong></div>
    </div>
    <div className="card">
      <h3>New Equipment</h3>
      <form className="form" onSubmit={createEquipment}>
        <label>Name<input value={formState.name} onChange={e => setFormState(prev => ({ ...prev, name: e.target.value }))} required /></label>
        <label>Category<input value={formState.category} onChange={e => setFormState(prev => ({ ...prev, category: e.target.value }))} /></label>
        <label>Manufacturer<input value={formState.manufacturer} onChange={e => setFormState(prev => ({ ...prev, manufacturer: e.target.value }))} /></label>
        <label>Model<input value={formState.model} onChange={e => setFormState(prev => ({ ...prev, model: e.target.value }))} /></label>
        <label>Serial number<input value={formState.serialNumber} onChange={e => setFormState(prev => ({ ...prev, serialNumber: e.target.value }))} /></label>
        <label>Location<select value={formState.locationId} onChange={e => setFormState(prev => ({ ...prev, locationId: e.target.value }))}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}</select></label>
        <label>Section<select value={formState.sectionId} onChange={e => setFormState(prev => ({ ...prev, sectionId: e.target.value }))}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
        <label>Status<select value={formState.status} onChange={e => setFormState(prev => ({ ...prev, status: e.target.value }))}><option value="operational">Operational</option><option value="maintenance">Maintenance</option><option value="out-of-service">Out of service</option></select></label>
        <button type="submit" disabled={loading}>Add equipment</button>
      </form>
    </div>
    <div className="card">
      <h3>Equipment inventory</h3>
      {loading ? <p>Loading equipment…</p> : equipment.length === 0 ? <p>No equipment items have been recorded yet.</p> : <table className="table"><thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Status</th><th>Location</th><th>Assigned</th></tr></thead><tbody>{equipment.map(item => <tr key={item.id}><td>{item.equipment_number}</td><td>{item.name}</td><td>{item.category || '—'}</td><td>{formatBadge(item.status)}</td><td>{locations.find(l => l.id === item.location_id)?.name || '—'}</td><td>{staff.find(s => s.id === item.assigned_to_staff_id)?.fullName || '—'}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}

export function InventoryPage() {
  const { isEnabled } = useModules();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [formState, setFormState] = useState({ name: '', category: '', supplierId: '', locationId: '', quantity: 0, unit: '', status: 'available', reorderLevel: 0, expiryDate: '' });
  const [supplierState, setSupplierState] = useState({ name: '', contact: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEnabled('supplier_inventory')) return;
    setLoading(true);
    void Promise.all([
      api<InventoryItem[]>('/supplier-inventory'),
      api<Supplier[]>('/supplier-inventory/suppliers'),
      api<Location[]>('/locations')
    ]).then(([itemData, supplierData, locationData]) => {
      setItems(itemData);
      setSuppliers(supplierData);
      setLocations(locationData);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [isEnabled]);

  const summary = useMemo(() => ({ total: items.length, outOfStock: items.filter(i => i.quantity === 0).length, suppliers: suppliers.length }), [items, suppliers]);

  if (!isEnabled('supplier_inventory')) return <DisabledModule />;

  const createSupplier = async (event: FormEvent) => {
    event.preventDefault();
    await api('/supplier-inventory/suppliers', { method: 'POST', body: JSON.stringify(supplierState) });
    setSupplierState({ name: '', contact: '' });
    setSuppliers(await api<Supplier[]>('/supplier-inventory/suppliers'));
  };

  const createItem = async (event: FormEvent) => {
    event.preventDefault();
    await api('/supplier-inventory', { method: 'POST', body: JSON.stringify({ ...formState, supplierId: formState.supplierId || null, locationId: formState.locationId || null }) });
    setFormState({ name: '', category: '', supplierId: '', locationId: '', quantity: 0, unit: '', status: 'available', reorderLevel: 0, expiryDate: '' });
    setItems(await api<InventoryItem[]>('/supplier-inventory'));
  };

  return <div>
    <h2>Supplier & Inventory</h2>
    <div className="grid cols-4">
      <div className="card metric"><span>Inventory items</span><br/><strong>{summary.total}</strong></div>
      <div className="card metric"><span>Suppliers</span><br/><strong>{summary.suppliers}</strong></div>
      <div className="card metric"><span>Out of stock</span><br/><strong>{summary.outOfStock}</strong></div>
      <div className="card metric"><span>Locations</span><br/><strong>{locations.length}</strong></div>
    </div>
    <div className="card">
      <h3>New supplier</h3>
      <form className="form" onSubmit={createSupplier}>
        <label>Name<input value={supplierState.name} onChange={e => setSupplierState(prev => ({ ...prev, name: e.target.value }))} required /></label>
        <label>Contact<input value={supplierState.contact} onChange={e => setSupplierState(prev => ({ ...prev, contact: e.target.value }))} /></label>
        <button type="submit">Add supplier</button>
      </form>
    </div>
    <div className="card">
      <h3>New inventory item</h3>
      <form className="form" onSubmit={createItem}>
        <label>Name<input value={formState.name} onChange={e => setFormState(prev => ({ ...prev, name: e.target.value }))} required /></label>
        <label>Category<input value={formState.category} onChange={e => setFormState(prev => ({ ...prev, category: e.target.value }))} /></label>
        <label>Supplier<select value={formState.supplierId} onChange={e => setFormState(prev => ({ ...prev, supplierId: e.target.value }))}><option value="">Select supplier</option>{suppliers.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
        <label>Location<select value={formState.locationId} onChange={e => setFormState(prev => ({ ...prev, locationId: e.target.value }))}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}</select></label>
        <label>Quantity<input type="number" value={formState.quantity} onChange={e => setFormState(prev => ({ ...prev, quantity: Number(e.target.value) }))} /></label>
        <label>Unit<input value={formState.unit} onChange={e => setFormState(prev => ({ ...prev, unit: e.target.value }))} /></label>
        <label>Status<select value={formState.status} onChange={e => setFormState(prev => ({ ...prev, status: e.target.value }))}><option value="available">Available</option><option value="reserved">Reserved</option><option value="unavailable">Unavailable</option></select></label>
        <button type="submit">Add inventory item</button>
      </form>
    </div>
    <div className="card">
      <h3>Inventory list</h3>
      {loading ? <p>Loading inventory…</p> : items.length === 0 ? <p>No inventory items have been recorded yet.</p> : <table className="table"><thead><tr><th>No.</th><th>Name</th><th>Supplier</th><th>Qty</th><th>Status</th><th>Location</th></tr></thead><tbody>{items.map(item => <tr key={item.id}><td>{item.item_code}</td><td>{item.name}</td><td>{item.supplier_name || '—'}</td><td>{item.quantity}</td><td>{formatBadge(item.status)}</td><td>{locations.find(l => l.id === item.location_id)?.name || '—'}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}

export function MonitoringPage() {
  const { isEnabled } = useModules();
  const [records, setRecords] = useState<MonitoringRecord[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [formState, setFormState] = useState({ parameter: '', targetRange: '', actualValue: '', unit: '', sampleDate: '', locationId: '', sectionId: '', status: 'reported' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEnabled('monitoring')) return;
    setLoading(true);
    void Promise.all([api<MonitoringRecord[]>('/monitoring'), api<Location[]>('/locations'), api<Section[]>('/sections')])
      .then(([recordData, locationData, sectionData]) => {
        setRecords(recordData);
        setLocations(locationData);
        setSections(sectionData);
      }).catch(() => {}).finally(() => setLoading(false));
  }, [isEnabled]);

  if (!isEnabled('monitoring')) return <DisabledModule />;

  const createRecord = async (event: FormEvent) => {
    event.preventDefault();
    await api('/monitoring', { method: 'POST', body: JSON.stringify({ ...formState, locationId: formState.locationId || null, sectionId: formState.sectionId || null, sampleDate: formState.sampleDate || new Date().toISOString() }) });
    setFormState({ parameter: '', targetRange: '', actualValue: '', unit: '', sampleDate: '', locationId: '', sectionId: '', status: 'reported' });
    setRecords(await api<MonitoringRecord[]>('/monitoring'));
  };

  return <div>
    <h2>Environmental Monitoring</h2>
    <div className="grid cols-4">
      <div className="card metric"><span>Records</span><br/><strong>{records.length}</strong></div>
      <div className="card metric"><span>Reports</span><br/><strong>{records.filter(r => r.status === 'reported').length}</strong></div>
      <div className="card metric"><span>Reviewed</span><br/><strong>{records.filter(r => r.status === 'closed').length}</strong></div>
      <div className="card metric"><span>Sections</span><br/><strong>{sections.length}</strong></div>
    </div>
    <div className="card">
      <h3>New monitoring record</h3>
      <form className="form" onSubmit={createRecord}>
        <label>Parameter<input value={formState.parameter} onChange={e => setFormState(prev => ({ ...prev, parameter: e.target.value }))} required /></label>
        <label>Target range<input value={formState.targetRange} onChange={e => setFormState(prev => ({ ...prev, targetRange: e.target.value }))} /></label>
        <label>Actual value<input value={formState.actualValue} onChange={e => setFormState(prev => ({ ...prev, actualValue: e.target.value }))} /></label>
        <label>Unit<input value={formState.unit} onChange={e => setFormState(prev => ({ ...prev, unit: e.target.value }))} /></label>
        <label>Sample date<input type="datetime-local" value={formState.sampleDate} onChange={e => setFormState(prev => ({ ...prev, sampleDate: e.target.value }))} /></label>
        <label>Location<select value={formState.locationId} onChange={e => setFormState(prev => ({ ...prev, locationId: e.target.value }))}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}</select></label>
        <label>Section<select value={formState.sectionId} onChange={e => setFormState(prev => ({ ...prev, sectionId: e.target.value }))}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
        <label>Status<select value={formState.status} onChange={e => setFormState(prev => ({ ...prev, status: e.target.value }))}><option value="reported">Reported</option><option value="reviewed">Reviewed</option><option value="closed">Closed</option></select></label>
        <button type="submit">Record monitoring</button>
      </form>
    </div>
    <div className="card">
      <h3>Monitoring history</h3>
      {loading ? <p>Loading monitoring records…</p> : records.length === 0 ? <p>No monitoring entries yet.</p> : <table className="table"><thead><tr><th>No.</th><th>Parameter</th><th>Value</th><th>Target</th><th>Location</th><th>Status</th></tr></thead><tbody>{records.map(record => <tr key={record.id}><td>{record.monitoring_number}</td><td>{record.parameter}</td><td>{record.actual_value || '—'}</td><td>{record.target_range || '—'}</td><td>{locations.find(l => l.id === record.location_id)?.name || '—'}</td><td>{formatBadge(record.status)}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}

export function SafetyPage() {
  const { isEnabled } = useModules();
  const [incidents, setIncidents] = useState<SafetyIncident[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [formState, setFormState] = useState({ incidentDate: '', description: '', category: '', severity: '', status: 'open', reportedTo: '', locationId: '', sectionId: '', reportedByStaffId: '' });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isEnabled('facilities_safety')) return;
    setLoading(true);
    void Promise.all([api<SafetyIncident[]>('/facilities-safety'), api<Section[]>('/sections'), api<Location[]>('/locations')])
      .then(([incidentData, sectionData, locationData]) => {
        setIncidents(incidentData);
        setSections(sectionData);
        setLocations(locationData);
      }).catch(() => {}).finally(() => setLoading(false));
  }, [isEnabled]);

  if (!isEnabled('facilities_safety')) return <DisabledModule />;

  const summary = useMemo(() => ({ total: incidents.length, open: incidents.filter(i => i.status === 'open').length, closed: incidents.filter(i => i.status === 'closed').length }), [incidents]);

  const createIncident = async (event: FormEvent) => {
    event.preventDefault();
    await api('/facilities-safety', { method: 'POST', body: JSON.stringify({ ...formState, locationId: formState.locationId || null, sectionId: formState.sectionId || null, incidentDate: formState.incidentDate || new Date().toISOString() }) });
    setFormState({ incidentDate: '', description: '', category: '', severity: '', status: 'open', reportedTo: '', locationId: '', sectionId: '', reportedByStaffId: '' });
    setIncidents(await api<SafetyIncident[]>('/facilities-safety'));
  };

  return <div>
    <h2>Facilities & Safety</h2>
    <div className="grid cols-4">
      <div className="card metric"><span>Incidents</span><br/><strong>{summary.total}</strong></div>
      <div className="card metric"><span>Open</span><br/><strong>{summary.open}</strong></div>
      <div className="card metric"><span>Closed</span><br/><strong>{summary.closed}</strong></div>
      <div className="card metric"><span>Sections</span><br/><strong>{sections.length}</strong></div>
    </div>
    <div className="card">
      <h3>New safety incident</h3>
      <form className="form" onSubmit={createIncident}>
        <label>Description<textarea value={formState.description} onChange={e => setFormState(prev => ({ ...prev, description: e.target.value }))} required /></label>
        <label>Category<input value={formState.category} onChange={e => setFormState(prev => ({ ...prev, category: e.target.value }))} /></label>
        <label>Severity<select value={formState.severity} onChange={e => setFormState(prev => ({ ...prev, severity: e.target.value }))}><option value="">Select severity</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Location<select value={formState.locationId} onChange={e => setFormState(prev => ({ ...prev, locationId: e.target.value }))}><option value="">Select location</option>{locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}</select></label>
        <label>Section<select value={formState.sectionId} onChange={e => setFormState(prev => ({ ...prev, sectionId: e.target.value }))}><option value="">Select section</option>{sections.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}</select></label>
        <label>Report to<input value={formState.reportedTo} onChange={e => setFormState(prev => ({ ...prev, reportedTo: e.target.value }))} /></label>
        <button type="submit">Report incident</button>
      </form>
    </div>
    <div className="card">
      <h3>Incident log</h3>
      {loading ? <p>Loading incidents…</p> : incidents.length === 0 ? <p>No safety incidents have been recorded yet.</p> : <table className="table"><thead><tr><th>No.</th><th>Date</th><th>Severity</th><th>Status</th><th>Location</th><th>Description</th></tr></thead><tbody>{incidents.map(item => <tr key={item.id}><td>{item.incident_number}</td><td>{item.incident_date}</td><td>{item.severity || '—'}</td><td>{formatBadge(item.status)}</td><td>{locations.find(l => l.id === item.location_id)?.name || '—'}</td><td>{item.description.slice(0, 60)}{item.description.length > 60 ? '...' : ''}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}
