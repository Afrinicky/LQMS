import { useCallback, useEffect, useRef, useState } from 'react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import type {
  MyProfile, MyTasks, MyDeclarations, MyDeclaration, StaffDocument, NotificationRecord, StaffSuggestionsResponse,
} from '../../../shared/types/api';

/**
 * My Profile — the member of staff's own portal.
 *
 * Everything here is the logged-in person's own: their identity and signature,
 * their inbox, the declarations they must sign or have signed, their documents,
 * their authorisations and the tasks routed to them. It reads only self-scoped
 * endpoints, so it shows one person's working file and nothing about anyone
 * else.
 */

// The my-profile staff object comes straight from the staff row (snake_case).
type ProfileStaff = {
  id: number; full_name?: string; employee_no?: string; email?: string; phone?: string;
  section_name?: string | null; designation?: string | null; job_title?: string | null;
  appointment_date?: string | null; personnel_category?: string | null; signature_file_id?: number | null;
};

async function fetchBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the file.');
  return URL.createObjectURL(await r.blob());
}
async function blobAsDataUrl(path: string): Promise<string> {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the image.');
  const blob = await r.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader(); fr.onloadend = () => resolve(String(fr.result)); fr.onerror = reject; fr.readAsDataURL(blob);
  });
}
async function downloadFileById(fileId: number, name: string) {
  const url = await fetchBlobUrl(`/files/${fileId}/download`);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const esc = (s?: string | null) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default function UserPortal({ onLinkStaff }: { onLinkStaff?: (staffId: number) => void }) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [tasks, setTasks] = useState<MyTasks | null>(null);
  const [declarations, setDeclarations] = useState<MyDeclarations>({ signed: [], pending: [] });
  const [documents, setDocuments] = useState<StaffDocument[]>([]);
  const [inbox, setInbox] = useState<NotificationRecord[]>([]);
  const [suggestions, setSuggestions] = useState<StaffSuggestionsResponse | null>(null);
  const [hasSignature, setHasSignature] = useState(false);
  const [sigUrl, setSigUrl] = useState<string | null>(null);
  const [reading, setReading] = useState<MyDeclaration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sigInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    const prof = await api<MyProfile>('/personnel/my-profile').catch(e => { setError(errorText(e)); return null; });
    if (prof) setProfile(prof);
    api<MyTasks>('/personnel/my-tasks').then(setTasks).catch(() => undefined);
    api<MyDeclarations>('/personnel/my-declarations').then(setDeclarations).catch(() => undefined);
    api<StaffDocument[]>('/personnel/my-documents').then(setDocuments).catch(() => undefined);
    api<NotificationRecord[]>('/notifications?mine=true&status=unread').then(setInbox).catch(() => setInbox([]));
    api<{ hasSignature: boolean }>('/signatures/me').then(r => setHasSignature(!!r.hasSignature)).catch(() => setHasSignature(false));
    if (prof && !prof.staff) api<StaffSuggestionsResponse>('/personnel/staff-suggestions').then(setSuggestions).catch(() => undefined);
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let revoke: string | null = null;
    if (hasSignature) fetchBlobUrl('/signatures/me/image').then(u => { revoke = u; setSigUrl(u); }).catch(() => setSigUrl(null));
    else setSigUrl(null);
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [hasSignature]);

  async function linkStaff(staffId: number) {
    setError(null);
    try { await api('/personnel/link-my-staff', { method: 'POST', body: JSON.stringify({ staffId }) }); onLinkStaff?.(staffId); await load(); setNotice('Your account is now linked to your staff record.'); }
    catch (e) { setError(errorText(e)); }
  }

  async function uploadSignature(file: File) {
    setError(null);
    try {
      const form = new FormData(); form.append('file', file);
      const token = getToken();
      const res = await fetch(`${API_BASE}/signatures/me`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
      setHasSignature(true);
      // Force the image to refresh.
      setSigUrl(null); setTimeout(() => fetchBlobUrl('/signatures/me/image').then(setSigUrl).catch(() => undefined), 200);
      setNotice('Signature saved. It will now appear wherever you sign.');
    } catch (e) { setError(errorText(e)); }
    finally { if (sigInput.current) sigInput.current.value = ''; }
  }

  async function markRead(id: number) {
    try { await api(`/notifications/${id}/read`, { method: 'POST', body: JSON.stringify({}) }); setInbox(prev => prev.filter(n => n.id !== id)); }
    catch { /* leave it */ }
  }

  async function printDeclaration(d: MyDeclaration) {
    const staff = profile?.staff as unknown as ProfileStaff | null;
    const name = staff?.full_name || profile?.user.fullName || '';
    const sigImg = staff?.signature_file_id ? await blobAsDataUrl('/signatures/me/image').catch(() => null) : null;
    const sigBlock = sigImg ? `<img class="sigimg" src="${sigImg}" alt="signature" />`
      : d.signed_file_id ? '<span class="muted">signed copy on file</span>'
      : `<span class="signame">${esc(name)}</span>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title>
      <style>
        body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 32px; line-height: 1.5; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
        .body { white-space: pre-wrap; font-size: 13.5px; margin: 16px 0 22px; }
        .ack { border-left: 3px solid #333; padding: 6px 12px; font-style: italic; margin: 18px 0; }
        .signblock { margin-top: 34px; }
        .sigimg { max-height: 46px; max-width: 200px; display: block; }
        .signame { font-family: 'Segoe Script', 'Brush Script MT', cursive; font-size: 20px; }
        .sigline { border-top: 1px solid #333; width: 260px; margin-top: 4px; padding-top: 4px; font-size: 12px; }
        .muted { color: #666; font-style: italic; }
        @media print { body { margin: 12mm; } }
      </style></head><body>
      <div class="meta">${esc(d.form_number || '')}</div>
      <h1>${esc(d.title)}</h1>
      <div class="meta">Version ${esc(d.version || '—')} · effective ${esc(d.effective_date || '—')}${d.issued_by ? ` · issued by ${esc(d.issued_by)}` : ''}</div>
      ${d.body_content ? `<div class="body">${esc(d.body_content)}</div>` : '<p class="muted">The declaration text was supplied as an attached file.</p>'}
      ${d.acknowledgement_statement ? `<div class="ack">${esc(d.acknowledgement_statement)}</div>` : ''}
      <div class="signblock">
        ${sigBlock}
        <div class="sigline">${esc(name)} — signed ${esc(d.signed_at ? String(d.signed_at).slice(0, 19).replace('T', ' ') : '')}</div>
      </div>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { setError('Allow pop-ups to print the declaration.'); return; }
    w.document.write(html); w.document.close();
  }

  const staff = profile?.staff as unknown as ProfileStaff | null;
  const displayName = staff?.full_name || profile?.user.fullName || 'My profile';
  const initials = displayName.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const declTypeLabel = (t: string) => t.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

  return <div style={{ display: 'grid', gap: 14 }}>
    {error && <div className="error">{error}</div>}
    {notice && <div className="notice" style={{ background: '#ecfdf5', color: '#065f46', padding: '8px 12px', borderRadius: 6 }}>{notice}</div>}

    {/* Identity + signature */}
    <div className="card">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--accent, #2563eb)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 20, flexShrink: 0 }}>{initials}</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h3 style={{ margin: 0 }}>{displayName}</h3>
          <p className="muted" style={{ margin: '2px 0 0', fontSize: 12.5 }}>
            {profile?.user && `${(profile.user as { roleName?: string }).roleName || 'User'}`}
            {staff?.employee_no ? ` · Staff ID ${staff.employee_no}` : ''}
            {staff?.section_name ? ` · ${staff.section_name}` : ''}
          </p>
          {staff && <p className="muted" style={{ margin: '2px 0 0', fontSize: 12 }}>
            {[staff.designation || staff.job_title, staff.email, staff.phone].filter(Boolean).join(' · ') || '—'}
          </p>}
          {profile?.positions && profile.positions.length > 0 && <p style={{ margin: '4px 0 0', fontSize: 12.5 }}>{profile.positions.map(p => `${p.title}${p.is_active ? '' : ' (inactive)'}`).join(', ')}</p>}
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>My signature</div>
          {sigUrl ? <img src={sigUrl} alt="my signature" style={{ maxHeight: 46, maxWidth: 170, border: '1px solid #e2e8f0', borderRadius: 6, padding: 4, background: '#fff' }} />
            : <div style={{ fontSize: 12, color: '#94a3b8', border: '1px dashed #cbd5e1', borderRadius: 6, padding: '10px 14px' }}>No signature on file</div>}
          {staff && <div style={{ marginTop: 6 }}>
            <input ref={sigInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) void uploadSignature(f); }} />
            <button type="button" className="secondary" onClick={() => sigInput.current?.click()}>{hasSignature ? 'Replace signature' : 'Upload signature'}</button>
          </div>}
        </div>
      </div>

      {!staff && <div style={{ marginTop: 12 }}>
        <p className="error" style={{ marginTop: 0 }}>Your user account is not linked to a staff record. You need a link before your documents, declarations and tasks appear here.</p>
        {suggestions && suggestions.suggestions.length > 0 && <table className="data-table"><thead><tr><th>Staff</th><th>Email</th><th>Section</th><th /></tr></thead><tbody>
          {suggestions.suggestions.map(s => <tr key={s.id}>
            <td>{s.full_name}{s.employee_no ? ` (${s.employee_no})` : ''}</td><td>{s.email || '—'}</td><td>{s.section_name || '—'}</td>
            <td>{s.already_taken ? <em>linked to another user</em> : <button onClick={() => void linkStaff(s.id)}>Link to me</button>}</td>
          </tr>)}
        </tbody></table>}
        {suggestions && suggestions.suggestions.length === 0 && <p className="muted">No matching staff record found. Ask an administrator to create your staff record and link your account.</p>}
      </div>}
    </div>

    {/* Task summary */}
    {tasks && staff && <div className="cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
      {[
        { label: 'Declarations to sign', value: declarations.pending.length },
        { label: 'Attestations', value: tasks.pendingAttestations.length },
        { label: 'Upcoming training', value: tasks.upcomingTraining.length },
        { label: 'Upcoming competency', value: tasks.upcomingCompetency.length },
        { label: 'Assigned actions', value: tasks.assignedActions.length },
        { label: 'Upcoming duties', value: tasks.upcomingDuties.length },
      ].map(t => <div key={t.label} className="card" style={{ padding: '10px 12px' }}>
        <div style={{ fontSize: 11.5, color: '#64748b' }}>{t.label}</div>
        <div style={{ fontSize: 24, fontWeight: 700 }}>{t.value}</div>
      </div>)}
    </div>}

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
      {/* Inbox */}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>My inbox {inbox.length > 0 && <span className="badge" style={{ background: '#fee2e2', color: '#991b1b' }}>{inbox.length}</span>}</h4>
        {inbox.length === 0 ? <p className="muted">Nothing unread. You're all caught up.</p> :
          <div style={{ maxHeight: '40vh', overflowY: 'auto' }}>
            {inbox.map(n => <div key={n.id} style={{ borderBottom: '1px solid #eef0f4', padding: '8px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{n.title}</strong>
                <span className={`badge ${n.severity}`} style={{ fontSize: 10 }}>{n.severity}</span>
              </div>
              {n.message && <div className="muted" style={{ fontSize: 12 }}>{n.message}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                {n.action_url && <a href={`#${n.action_url}`} onClick={() => { if (n.action_url) window.location.hash = n.action_url; }} style={{ fontSize: 12, color: 'var(--accent, #2563eb)' }}>{n.action_label || 'Open'}</a>}
                <button type="button" className="link-button" style={{ fontSize: 12 }} onClick={() => void markRead(n.id)}>Mark read</button>
              </div>
            </div>)}
          </div>}
      </div>

      {/* Declarations */}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>My declarations</h4>
        {declarations.pending.length > 0 && <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600, marginBottom: 4 }}>Awaiting your signature</div>
          {declarations.pending.map(d => <div key={`p${d.id}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ fontSize: 13 }}>{d.title} <span className="muted" style={{ fontSize: 11 }}>({declTypeLabel(d.form_type)})</span></span>
            <a onClick={() => { window.location.hash = `/organisation?tab=Code%20of%20Conduct&form=${d.id}`; }} style={{ cursor: 'pointer', color: 'var(--accent, #2563eb)', fontSize: 12 }}>Read &amp; sign →</a>
          </div>)}
        </div>}
        <div style={{ fontSize: 12, color: '#166534', fontWeight: 600, marginBottom: 4 }}>Signed</div>
        {declarations.signed.length === 0 ? <p className="muted" style={{ marginTop: 0 }}>You have not signed any declarations yet.</p> :
          <table className="data-table"><thead><tr><th>Declaration</th><th>Signed</th><th /></tr></thead><tbody>
            {declarations.signed.map(d => <tr key={`s${d.id}`}>
              <td>{d.title}<div className="muted" style={{ fontSize: 11 }}>{declTypeLabel(d.form_type)} · v{d.version || '—'}</div></td>
              <td style={{ whiteSpace: 'nowrap' }}>{d.signed_at ? String(d.signed_at).slice(0, 10) : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="link-button" onClick={() => setReading(d)} style={{ marginRight: 8 }}>Open</button>
                <button type="button" className="link-button" onClick={() => void printDeclaration(d)} style={{ marginRight: 8 }}>Print</button>
                {d.signed_file_id && <button type="button" className="link-button" onClick={() => void downloadFileById(d.signed_file_id!, `signed-${d.form_number || d.id}`)}>Signed copy</button>}
              </td>
            </tr>)}
          </tbody></table>}
      </div>

      {/* Documents */}
      <div className="card">
        <h4 style={{ marginTop: 0 }}>My documents</h4>
        {documents.length === 0 ? <p className="muted">No documents on your file yet.</p> :
          <table className="data-table"><thead><tr><th>Type</th><th>Title</th><th>Expiry</th><th /></tr></thead><tbody>
            {documents.map(d => <tr key={d.id}>
              <td>{(d.document_type || '—').replace(/_/g, ' ')}</td>
              <td>{d.title}{d.verification_status && <span className={`badge ${d.verification_status}`} style={{ marginLeft: 6, fontSize: 10 }}>{d.verification_status}</span>}</td>
              <td>{d.expiry_date || '—'}</td>
              <td>{d.file_id ? <button type="button" className="link-button" onClick={() => void downloadFileById(d.file_id!, d.file_name || d.title)}>Download</button> : '—'}</td>
            </tr>)}
          </tbody></table>}
      </div>

      {/* Authorisations */}
      {profile?.authorizations && profile.authorizations.length > 0 && <div className="card">
        <h4 style={{ marginTop: 0 }}>My technical authorisations</h4>
        <table className="data-table"><thead><tr><th>Module</th><th>Level</th><th>Expires</th></tr></thead><tbody>
          {profile.authorizations.map(a => <tr key={a.id}><td>{a.module_key}</td><td>{a.level}</td><td>{a.expires_at || '—'}</td></tr>)}
        </tbody></table>
      </div>}

      {/* Upcoming duties */}
      {tasks && tasks.upcomingDuties.length > 0 && <div className="card">
        <h4 style={{ marginTop: 0 }}>Upcoming duties</h4>
        <table className="data-table"><thead><tr><th>Date</th><th>Shift</th><th>Hours</th><th>Role</th></tr></thead><tbody>
          {tasks.upcomingDuties.map(a => <tr key={a.id}><td>{a.duty_date}</td><td>{a.shift_name || '—'}</td><td>{a.start_time || '—'} – {a.end_time || '—'}</td><td>{a.duty_role || '—'}</td></tr>)}
        </tbody></table>
      </div>}
    </div>

    {/* Read a signed declaration */}
    {reading && <div onClick={() => setReading(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} className="card" style={{ maxWidth: 760, width: '100%', maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <div>
            <span className="hint">{declTypeLabel(reading.form_type)}</span>
            <h3 style={{ margin: '2px 0 0' }}>{reading.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>v{reading.version || '—'} · signed {reading.signed_at ? String(reading.signed_at).slice(0, 10) : '—'}</p>
          </div>
          <button type="button" onClick={() => setReading(null)} style={{ border: 'none', background: 'transparent', fontSize: 22, cursor: 'pointer', color: '#64748b' }}>×</button>
        </div>
        {reading.body_content ? <div style={{ whiteSpace: 'pre-wrap', marginTop: 10, lineHeight: 1.55 }}>{reading.body_content}</div>
          : <p className="muted" style={{ marginTop: 10 }}>This declaration was a form document. {reading.file_id ? <button type="button" className="link-button" onClick={() => reading.file_id && void downloadFileById(reading.file_id, reading.file_name || 'declaration')}>Download the form</button> : ''}</p>}
        {reading.acknowledgement_statement && <p style={{ marginTop: 12, fontStyle: 'italic', borderLeft: '3px solid #94a3b8', paddingLeft: 10, color: '#475569' }}>{reading.acknowledgement_statement}</p>}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => void printDeclaration(reading)}>🖨 Print</button>
          {reading.signed_file_id && <button type="button" className="secondary" onClick={() => reading.signed_file_id && void downloadFileById(reading.signed_file_id, `signed-${reading.form_number || reading.id}`)}>⬇ Signed copy</button>}
        </div>
      </div>
    </div>}
  </div>;
}
