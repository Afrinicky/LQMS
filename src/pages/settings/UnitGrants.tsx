import { FormEvent, useEffect, useState } from 'react';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Notice } from '../../components/ui/Feedback';
import TextField from '../../components/ui/TextField';
import { UNIT_GRANT_LEVEL_LABELS } from '../../../shared/constants/labUnits';
import type { Section, Staff, UnitGrant } from '../../../shared/types/api';

/* ==========================================================================
   Cross-unit working permissions — shown inside Access Control
   ========================================================================== */

/**
 * Permission to work in a unit that is not yours.
 *
 * The one control that reaches past "one person, one clinical unit", so it is
 * deliberate, attributable and listed in full. A grant widens WHERE somebody
 * works and never WHAT they may do: the level is capped at what their own
 * primary role already allows.
 */
export default function UnitGrants() {
  const { can } = usePermissions();
  const [grants, setGrants] = useState<UnitGrant[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [form, setForm] = useState({ staffId: '', sectionId: '', level: 'contribute', expiresAt: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = () => {
    api<UnitGrant[]>('/unit-grants').then(setGrants).catch(e => setError(errorText(e)));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
  };
  useEffect(() => { load(); }, []);

  const chosen = staff.find(s => String(s.id) === form.staffId);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null); setSuccess(null);
    try {
      await api('/unit-grants', {
        method: 'POST',
        body: JSON.stringify({
          staffId: Number(form.staffId), sectionId: Number(form.sectionId), level: form.level,
          expiresAt: form.expiresAt || null, reason: form.reason.trim() || null,
        }),
      });
      setSuccess('Permission granted.');
      setForm({ staffId: '', sectionId: '', level: 'contribute', expiresAt: '', reason: '' });
      load();
    } catch (err) { setError(errorText(err)); }
  }

  async function revoke(grant: UnitGrant) {
    if (!window.confirm(`Withdraw ${grant.staffName}'s permission to work in ${grant.sectionName}?`)) return;
    setError(null); setSuccess(null);
    try { await api(`/unit-grants/${grant.id}`, { method: 'DELETE' }); setSuccess('Permission withdrawn.'); load(); }
    catch (err) { setError(errorText(err)); }
  }

  return (
    <div className="card">
      <h3>Working in another unit</h3>
      {error && <Notice kind="error">{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}

      {can('settings', 'edit') && (
        <form className="form" onSubmit={add}>
          <div className="form-grid">
          <label>Staff member
            <select value={form.staffId} onChange={e => setForm(f => ({ ...f, staffId: e.target.value }))} required>
              <option value="">Select…</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}{s.sectionName ? ` · ${s.sectionName}` : ''}</option>)}
            </select>
          </label>
          <label>Unit
            <select value={form.sectionId} onChange={e => setForm(f => ({ ...f, sectionId: e.target.value }))} required>
              <option value="">Select…</option>
              {sections.filter(s => String(s.id) !== String(chosen?.sectionId ?? '')).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Level
            <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))}>
              {Object.entries(UNIT_GRANT_LEVEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label>Expires<input type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} /></label>
          <label>Reason<TextField value={form.reason} onValue={v => setForm(f => ({ ...f, reason: v }))} /></label>
          </div>
          <button type="submit">Grant permission</button>
        </form>
      )}

      <table className="data-table">
        <thead><tr><th>Staff member</th><th>Own unit</th><th>May also work in</th><th>Level</th><th>Expires</th><th>Granted by</th><th /></tr></thead>
        <tbody>
          {grants.map(g => (
            <tr key={g.id}>
              <td>{g.staffName}</td>
              <td>{g.homeUnitName || <span className="muted">—</span>}</td>
              <td>{g.sectionName}</td>
              <td><span className="badge">{UNIT_GRANT_LEVEL_LABELS[g.level] ?? g.level}</span></td>
              <td>{g.expiresAt || 'No end date'}</td>
              <td>{g.grantedBy || '—'}</td>
              <td>{can('settings', 'edit') && <button type="button" className="tiny secondary" onClick={() => revoke(g)}>Withdraw</button>}</td>
            </tr>
          ))}
          {grants.length === 0 && <tr><td colSpan={7} className="hint">No cross-unit permissions are in force.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
