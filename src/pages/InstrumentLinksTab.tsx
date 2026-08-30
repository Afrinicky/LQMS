import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, Cable, Loader2, Play, Plus, Radio, ShieldCheck,
  Square, TestTube2, Trash2, X,
} from 'lucide-react';
import { api, errorText } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import TextField from '../components/ui/TextField';
import NumberField from '../components/ui/NumberField';
import { Notice } from '../components/ui/Feedback';
import {
  LINK_MODES, LINK_MODE_HINTS, LINK_MODE_LABELS,
  LINK_PROTOCOLS, LINK_PROTOCOL_HINTS, LINK_PROTOCOL_LABELS,
  LINK_ROLES, LINK_ROLE_HINTS, LINK_ROLE_LABELS, LINK_STATE_LABELS,
  DEFAULT_CONTROL_PATTERNS, modeIsPassive,
  type LinkMode, type LinkProtocol, type LinkRole,
} from '../../shared/constants/instruments';
import { LHIMS_TAP_FILENAME, LHIMS_TAP_SETUP_STEPS } from '../../shared/constants/lhims';

/**
 * Analyser links.
 *
 * The screen exists to make one thing impossible to get wrong by accident: the
 * link the LHIMS middleware uses for patient results must be left alone. So
 * that link is recorded here too, and the system stays away from its port and
 * its address — anybody looking at this page can see at a glance which link is
 * which.
 *
 * Three arrangements, all of them additive:
 *
 *   An analyser transmitting nowhere gets its own port here. Both chemistry
 *   analysers and the second haematology analyser are this, and it costs the
 *   existing setup nothing.
 *
 *   The analyser LHIMS owns is copied by FOLLOWING the LHIMS client's own log —
 *   the file it already writes when WRITE_TO_FILE is on. Read-only, no port, no
 *   connection. That is how all four analysers reach SECHLIMS.
 *
 *   And in the other direction, a link can carry its patient results INTO
 *   LHIMS by making the same call the middleware makes, which is how the three
 *   analysers LHIMS never carried can start reaching it.
 */

type Link = {
  id: number; link_code: string; name: string;
  equipment_id: number | null; equipment_name?: string | null; equipment_number?: string | null;
  section_id: number | null; section_name?: string | null;
  profile_key: string | null; role: LinkRole; mode: LinkMode; protocol: LinkProtocol;
  listen_host: string | null; listen_port: number | null;
  remote_host: string | null; remote_port: number | null;
  watch_path: string | null;
  analyte_map: Record<string, string>; control_patterns: string[];
  measure_map: Record<string, number>;
  forward_enabled: number; forward_host: string | null; forward_port: number | null;
  forward_target: string | null;
  lhims_url: string | null; lhims_username: string | null; lhims_password_set: boolean;
  lhims_map_key: string | null;
  tap_path: string | null; tap_offset: number | null;
  auto_start: number; is_active: number;
  state: string; state_detail: string | null; last_error: string | null;
  last_connected_at: string | null; last_message_at: string | null;
  messages_received: number; controls_matched: number;
  message_count: number; control_count: number; forward_pending: number;
  running: boolean; notes: string | null;
};

type Profile = { key: string; label: string; vendor: string; discipline: string; protocol: string; notes: string | null; analyteCount: number };
type LhimsMap = { key: string; label: string; vendor: string; sourceConfig: string; measureCount: number };

const EMPTY = {
  name: '', equipmentId: '', sectionId: '', profileKey: 'sysmex_xn',
  role: 'sechlims_only' as LinkRole, mode: 'server' as LinkMode, protocol: 'astm' as LinkProtocol,
  listenHost: '', listenPort: '', remoteHost: '', remotePort: '', watchPath: '',
  controlPatterns: DEFAULT_CONTROL_PATTERNS.join(', '),
  forwardEnabled: false, forwardHost: '', forwardPort: '',
  forwardTarget: 'lhims_api',
  lhimsUrl: '', lhimsUsername: '', lhimsPassword: '', lhimsMapKey: '',
  tapPath: '',
  autoStart: true, notes: '',
};

export default function InstrumentLinksTab() {
  const { can } = usePermissions();
  const canEdit = can('iqc', 'edit');
  const [links, setLinks] = useState<Link[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [lhimsMaps, setLhimsMaps] = useState<LhimsMap[]>([]);
  const [equipment, setEquipment] = useState<Array<{ id: number; name: string; section_id?: number | null }>>([]);
  const [sections, setSections] = useState<Array<{ id: number; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Link | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState<number | 'save' | null>(null);
  const [openMessages, setOpenMessages] = useState<Link | null>(null);
  const [trying, setTrying] = useState<Link | null>(null);

  const load = useCallback(async () => {
    try { setLinks(await api<Link[]>('/instrument-links')); setError(null); }
    catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try {
        const [p, e, s] = await Promise.all([
          api<{ profiles: Profile[]; lhimsMaps: LhimsMap[] }>('/instrument-links/profiles'),
          api<Array<{ id: number; name: string; section_id?: number | null }>>('/equipment'),
          api<Array<{ id: number; name: string }>>('/sections'),
        ]);
        setProfiles(p.profiles); setLhimsMaps(p.lhimsMaps ?? []); setEquipment(e); setSections(s);
      } catch { /* the pickers are a convenience */ }
    })();
  }, []);

  // A link's state changes without anything happening on this page — an
  // analyser connects, a transmission arrives — so the list refreshes itself.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function save() {
    setBusy('save'); setError(null);
    const payload = {
      name: form.name,
      equipmentId: form.equipmentId ? Number(form.equipmentId) : null,
      sectionId: form.sectionId ? Number(form.sectionId) : null,
      profileKey: form.profileKey || null,
      role: form.role, mode: form.mode, protocol: form.protocol,
      listenHost: form.listenHost || null,
      listenPort: form.listenPort ? Number(form.listenPort) : null,
      remoteHost: form.remoteHost || null,
      remotePort: form.remotePort ? Number(form.remotePort) : null,
      watchPath: form.watchPath || null,
      controlPatterns: form.controlPatterns.split(',').map(p => p.trim()).filter(Boolean),
      forwardEnabled: form.forwardEnabled,
      forwardHost: form.forwardHost || null,
      forwardPort: form.forwardPort ? Number(form.forwardPort) : null,
      forwardTarget: form.forwardTarget,
      lhimsUrl: form.lhimsUrl || null,
      lhimsUsername: form.lhimsUsername || null,
      // Left out entirely when untouched, so an edit does not blank a stored
      // password the screen was never shown.
      ...(form.lhimsPassword ? { lhimsPassword: form.lhimsPassword } : {}),
      lhimsMapKey: form.lhimsMapKey || null,
      tapPath: form.tapPath || null,
      autoStart: form.autoStart, notes: form.notes || null,
    };
    try {
      if (editing) await api(`/instrument-links/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/instrument-links', { method: 'POST', body: JSON.stringify(payload) });
      setShowForm(false); setEditing(null); setForm({ ...EMPTY });
      setNotice(editing ? 'The link was updated and restarted.' : 'The link was added.');
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function act(link: Link, action: 'start' | 'stop') {
    setBusy(link.id); setError(null);
    try { await api(`/instrument-links/${link.id}/${action}`, { method: 'POST' }); await load(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  const ours = (links ?? []).filter(l => l.role !== 'lhims_owned');
  const theirs = (links ?? []).filter(l => l.role === 'lhims_owned');

  return (
    <div>
      <div className="card">
        <div className="pp-head">
          <div>
            <h3><Cable size={16} /> Analyser links</h3>
            <p>
              Analysers that send their results to SECHLIMS over the network. Each one gets its own port, so
              several run at once — and a link recorded as belonging to the LHIMS middleware is never opened,
              which is how the transmission that carries patient results today stays exactly as it is.
            </p>
          </div>
          {canEdit && (
            <button type="button" onClick={() => { setEditing(null); setForm({ ...EMPTY }); setShowForm(true); }}>
              <Plus size={13} /> Add a link
            </button>
          )}
        </div>

        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}

        <div className="il-safety">
          <ShieldCheck size={15} />
          <div>
            <strong>Nothing here touches a transmission that already works.</strong>
            <p>
              SECHLIMS never sits in the path of the LHIMS link, never binds its port and never dials an analyser
              it is connected to — it refuses to, and says so. What it takes are the analysers transmitting
              nowhere today: the second haematology analyser, and both chemistry analysers.
              The analyser whose one host port already goes to LHIMS reaches here a different way — by following
              the middleware&rsquo;s own append log, which reads a file rather than touching the connection.
              The order to set all of this up in is written down in <code>docs/ANALYSER_TCPIP_SETUP.md</code>.
            </p>
          </div>
        </div>

        {!links ? <p className="muted">Loading…</p> : (
          <>
            {ours.length === 0 && theirs.length === 0 && (
              <p className="muted">
                No analyser links yet. Add one for an analyser that is not currently transmitting anywhere —
                that is the safe place to start, and it costs the existing arrangement nothing.
              </p>
            )}

            {ours.length > 0 && (
              <ul className="il-list">
                {ours.map(link => (
                  <LinkRow key={link.id} link={link} canEdit={canEdit} busy={busy === link.id}
                    onStart={() => void act(link, 'start')} onStop={() => void act(link, 'stop')}
                    onEdit={() => { setEditing(link); setForm(formFrom(link)); setShowForm(true); }}
                    onMessages={() => setOpenMessages(link)} onTry={() => setTrying(link)} />
                ))}
              </ul>
            )}

            {theirs.length > 0 && (
              <>
                <h4 className="rw-subhead">Links LHIMS owns — recorded so the system stays away from them</h4>
                <ul className="il-list">
                  {theirs.map(link => (
                    <LinkRow key={link.id} link={link} canEdit={canEdit} busy={busy === link.id}
                      onStart={() => void act(link, 'start')} onStop={() => void act(link, 'stop')}
                      onEdit={() => { setEditing(link); setForm(formFrom(link)); setShowForm(true); }}
                      onMessages={() => setOpenMessages(link)} onTry={() => setTrying(link)} />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {showForm && (
        <LinkForm form={form} setForm={setForm} profiles={profiles} lhimsMaps={lhimsMaps}
          equipment={equipment} sections={sections}
          editing={Boolean(editing)} passwordSet={Boolean(editing?.lhims_password_set)} busy={busy === 'save'}
          onSave={() => void save()} onClose={() => { setShowForm(false); setEditing(null); }} />
      )}
      {openMessages && <MessagesDialog link={openMessages} onClose={() => setOpenMessages(null)} />}
      {trying && <TryDialog link={trying} onClose={() => setTrying(null)} />}
    </div>
  );
}

function formFrom(link: Link) {
  return {
    name: link.name,
    equipmentId: link.equipment_id ? String(link.equipment_id) : '',
    sectionId: link.section_id ? String(link.section_id) : '',
    profileKey: link.profile_key ?? '',
    role: link.role, mode: link.mode, protocol: link.protocol,
    listenHost: link.listen_host ?? '', listenPort: link.listen_port ? String(link.listen_port) : '',
    remoteHost: link.remote_host ?? '', remotePort: link.remote_port ? String(link.remote_port) : '',
    watchPath: link.watch_path ?? '',
    controlPatterns: (link.control_patterns ?? []).join(', '),
    forwardEnabled: Boolean(link.forward_enabled),
    forwardHost: link.forward_host ?? '', forwardPort: link.forward_port ? String(link.forward_port) : '',
    forwardTarget: link.forward_target ?? 'lhims_api',
    lhimsUrl: link.lhims_url ?? '', lhimsUsername: link.lhims_username ?? '',
    lhimsPassword: '',
    lhimsMapKey: link.lhims_map_key ?? '',
    tapPath: link.tap_path ?? '',
    autoStart: Boolean(link.auto_start), notes: link.notes ?? '',
  };
}

/* ----------------------------------------------------------------------------
   One link
   ------------------------------------------------------------------------- */
function LinkRow({ link, canEdit, busy, onStart, onStop, onEdit, onMessages, onTry }: {
  link: Link; canEdit: boolean; busy: boolean;
  onStart: () => void; onStop: () => void; onEdit: () => void;
  onMessages: () => void; onTry: () => void;
}) {
  const tone = link.state === 'connected' ? 'ok'
    : link.state === 'listening' || link.state === 'following' ? 'ok'
    : link.state === 'blocked' ? 'lhims'
    : link.state === 'error' ? 'crit' : 'idle';

  return (
    <li className={`il-row t-${tone}`}>
      <span className={`il-rail ${tone}`} />
      <div className="il-main">
        <span className="il-name">
          {link.name}
          <span className={`il-state s-${link.state}`}>
            {link.state === 'connected' && <Radio size={10} />}
            {LINK_STATE_LABELS[link.state as keyof typeof LINK_STATE_LABELS] ?? link.state}
          </span>
          {link.role === 'lhims_owned' && <span className="badge">LHIMS</span>}
          {modeIsPassive(link.mode) && <span className="badge">read-only copy</span>}
          {Boolean(link.forward_enabled) && <span className="badge">carries to LHIMS</span>}
        </span>
        <span className="il-meta">
          {link.equipment_name && <span>{link.equipment_name}</span>}
          {link.section_name && <span>{link.section_name}</span>}
          <span>{LINK_PROTOCOL_LABELS[link.protocol]?.split('(')[0].trim() ?? link.protocol}</span>
          <span>
            {link.mode === 'server' ? `listening on ${link.listen_host || 'every interface'}:${link.listen_port ?? '—'}`
              : link.mode === 'client' ? `dials ${link.remote_host}:${link.remote_port}`
              : link.mode === 'lhims_tap' ? `reads ${link.tap_path}`
              : `watches ${link.watch_path}`}
          </span>
          {link.message_count > 0 && <span>{link.message_count} message{link.message_count === 1 ? '' : 's'}</span>}
          {link.control_count > 0 && <span>{link.control_count} control{link.control_count === 1 ? '' : 's'}</span>}
          {link.last_message_at && <span>last heard {String(link.last_message_at).slice(0, 16).replace('T', ' ')}</span>}
          {link.forward_pending > 0 && <span className="warn">{link.forward_pending} waiting to forward</span>}
        </span>
        {link.state_detail && <p className={`il-detail${link.state === 'error' ? ' is-error' : ''}`}>{link.state_detail}</p>}
      </div>
      <div className="il-side">
        {canEdit && (link.role !== 'lhims_owned' || modeIsPassive(link.mode)) && (
          link.running
            ? <button type="button" className="pq-link" disabled={busy} onClick={onStop}><Square size={12} /> Stop</button>
            : <button type="button" className="pq-link" disabled={busy} onClick={onStart}>
                {busy ? <Loader2 size={12} className="pd-spin" /> : <Play size={12} />} Start
              </button>
        )}
        <button type="button" className="pq-link" onClick={onMessages}>Messages</button>
        <button type="button" className="pq-link" onClick={onTry}><TestTube2 size={12} /> Try one</button>
        {canEdit && <button type="button" className="pq-link" onClick={onEdit}>Settings</button>}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------------------
   Adding or changing a link
   ------------------------------------------------------------------------- */
function LinkForm({ form, setForm, profiles, lhimsMaps, equipment, sections, editing, passwordSet, busy, onSave, onClose }: {
  form: typeof EMPTY; setForm: (fn: (f: typeof EMPTY) => typeof EMPTY) => void;
  profiles: Profile[]; lhimsMaps: LhimsMap[];
  equipment: Array<{ id: number; name: string }>; sections: Array<{ id: number; name: string }>;
  editing: boolean; passwordSet: boolean; busy: boolean; onSave: () => void; onClose: () => void;
}) {
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm(f => ({ ...f, [key]: value }));
  const profile = profiles.find(p => p.key === form.profileKey);

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide" onClick={e => e.stopPropagation()}>
        <header>
          <h4><Cable size={15} /> {editing ? 'Change this link' : 'Add an analyser link'}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        <label><span>What to call it</span>
          <TextField value={form.name} onValue={v => set('name', v)} autoFocus
            placeholder="Haematology 2 — Sysmex XN-330" /></label>

        <div className="iqc-run-meta">
          <label><span>The analyser</span>
            <select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}>
              <option value="">Not linked to a registered instrument</option>
              {equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label><span>Unit</span>
            <select value={form.sectionId} onChange={e => set('sectionId', e.target.value)}>
              <option value="">—</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label><span>Which analyser it is</span>
            <select value={form.profileKey} onChange={e => {
              const next = profiles.find(p => p.key === e.target.value);
              setForm(f => ({ ...f, profileKey: e.target.value, protocol: (next?.protocol as LinkProtocol) ?? f.protocol }));
            }}>
              <option value="">Not listed</option>
              {profiles.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
        </div>
        {profile && (
          <p className="iqc-panel-lead">
            {profile.analyteCount} analyte{profile.analyteCount === 1 ? '' : 's'} already mapped for this instrument,
            taken from the laboratory's own middleware configuration.
            {profile.notes ? ` ${profile.notes}` : ''}
          </p>
        )}

        {/* The safety-critical field. It decides whether the bridge will open
            this link at all, so it is stated in full rather than abbreviated. */}
        <label><span>What this link is for</span>
          <select value={form.role} onChange={e => set('role', e.target.value as LinkRole)}>
            {LINK_ROLES.map(r => <option key={r} value={r}>{LINK_ROLE_LABELS[r]}</option>)}
          </select>
        </label>
        <p className={`il-role-hint${form.role === 'lhims_owned' ? ' is-lhims' : ''}`}>
          {form.role === 'lhims_owned' && <AlertTriangle size={13} />}
          {LINK_ROLE_HINTS[form.role]}
        </p>

        <div className="iqc-run-meta">
          <label><span>How it is reached</span>
            <select value={form.mode} onChange={e => set('mode', e.target.value as LinkMode)}>
              {LINK_MODES.map(m => <option key={m} value={m}>{LINK_MODE_LABELS[m]}</option>)}
            </select>
          </label>
          <label><span>What it speaks</span>
            <select value={form.protocol} onChange={e => set('protocol', e.target.value as LinkProtocol)}>
              {LINK_PROTOCOLS.map(p => <option key={p} value={p}>{LINK_PROTOCOL_LABELS[p]}</option>)}
            </select>
          </label>
        </div>
        <p className="iqc-panel-lead">{LINK_MODE_HINTS[form.mode]} {LINK_PROTOCOL_HINTS[form.protocol]}</p>

        {form.mode === 'server' && (
          <div className="iqc-run-meta">
            <label><span>Port the analyser sends to</span>
              <NumberField min={1} max={65535} value={form.listenPort ? Number(form.listenPort) : null}
                onValue={n => set('listenPort', n ? String(n) : '')} />
            </label>
            <label><span>Bind to (optional)</span>
              <TextField value={form.listenHost} onValue={v => set('listenHost', v)} placeholder="every interface" /></label>
          </div>
        )}
        {form.mode === 'client' && (
          <div className="iqc-run-meta">
            <label><span>Analyser address</span>
              <TextField value={form.remoteHost} onValue={v => set('remoteHost', v)} placeholder="10.10.0.9" /></label>
            <label><span>Port</span>
              <NumberField min={1} max={65535} value={form.remotePort ? Number(form.remotePort) : null}
                onValue={n => set('remotePort', n ? String(n) : '')} />
            </label>
          </div>
        )}
        {form.mode === 'file_drop' && (
          <label><span>Folder to watch</span>
            <TextField value={form.watchPath} onValue={v => set('watchPath', v)} placeholder="C:\\Analyser\\Export" /></label>
        )}
        {form.mode === 'lhims_tap' && (
          <>
            <label><span>Path to the LHIMS client&rsquo;s {LHIMS_TAP_FILENAME}</span>
              <TextField value={form.tapPath} onValue={v => set('tapPath', v)}
                placeholder={`\\\\HAEM-PC\\LHIMS CLIENT\\${LHIMS_TAP_FILENAME}`} /></label>
            <div className="il-tap-steps">
              <strong>To switch the log on, on the PC running the LHIMS client:</strong>
              <ol>{LHIMS_TAP_SETUP_STEPS.map((step, i) => <li key={i}>{step}</li>)}</ol>
              <p>
                SECHLIMS only ever reads this file. It never writes to it, never empties it and never holds it
                open — so the LHIMS transmission carries on exactly as it does now, whether this is running or not.
              </p>
            </div>
          </>
        )}

        <label><span>Sample identifiers that mean &ldquo;this is a control&rdquo;</span>
          <TextField value={form.controlPatterns} onValue={v => set('controlPatterns', v)} />
          <span className="muted" style={{ display: 'block', marginTop: 4, fontSize: 11.5 }}>
            Separated by commas. A message is treated as a control only when its sample identifier actually says
            so — a patient sample numbered SC2024-QC-0031 is not swept into the QC record because three of its
            characters spell QC.
          </span>
        </label>

        <label className="ls-check">
          <input type="checkbox" checked={form.forwardEnabled} disabled={form.role === 'lhims_owned'}
            onChange={e => set('forwardEnabled', e.target.checked)} />
          <span>
            Also carry this analyser&rsquo;s patient results into LHIMS
            <em>
              {' '}— only for an analyser LHIMS is <strong>not</strong> already receiving, and only once this link
              has proved itself. It makes the same call the LHIMS middleware makes, so LHIMS gains the analysers
              its own client could never carry. Control runs are never sent; they belong on the IQC board.
            </em>
          </span>
        </label>
        {form.forwardEnabled && (
          <>
            <label><span>How to deliver</span>
              <select value={form.forwardTarget} onChange={e => set('forwardTarget', e.target.value)}>
                <option value="lhims_api">Post each result to the LHIMS API, as the middleware does</option>
                <option value="tcp">Hand the raw transmission to another program</option>
              </select>
            </label>
            {form.forwardTarget === 'lhims_api' ? (
              <>
                <div className="iqc-run-meta">
                  <label><span>LHIMS address</span>
                    <TextField value={form.lhimsUrl} onValue={v => set('lhimsUrl', v)}
                      placeholder="http://10.10.0.5/lhims/" /></label>
                  <label><span>Username</span>
                    <TextField value={form.lhimsUsername} onValue={v => set('lhimsUsername', v)} /></label>
                  <label><span>Password</span>
                    <input type="password" value={form.lhimsPassword} autoComplete="new-password"
                      placeholder={passwordSet ? 'unchanged' : ''}
                      onChange={e => set('lhimsPassword', e.target.value)} />
                  </label>
                </div>
                <label><span>What LHIMS calls each parameter</span>
                  <select value={form.lhimsMapKey} onChange={e => set('lhimsMapKey', e.target.value)}>
                    <option value="">Choose the analyser&rsquo;s LHIMS map…</option>
                    {lhimsMaps.map(m => (
                      <option key={m.key} value={m.key}>{m.label} — {m.measureCount} parameters</option>
                    ))}
                  </select>
                  <span className="muted" style={{ display: 'block', marginTop: 4, fontSize: 11.5 }}>
                    These are the measure ids from your own LHIMS client configuration files, so a result lands in
                    the same LHIMS field the middleware would have put it in. A parameter with no id is not sent —
                    it is listed for you instead, because LHIMS storing a value under the wrong id is worse than
                    not storing it. Use &ldquo;Try one&rdquo; to see exactly which would go and which would not.
                  </span>
                </label>
              </>
            ) : (
              <div className="iqc-run-meta">
                <label><span>Address</span>
                  <TextField value={form.forwardHost} onValue={v => set('forwardHost', v)} placeholder="10.10.0.5" /></label>
                <label><span>Port</span>
                  <NumberField min={1} max={65535} value={form.forwardPort ? Number(form.forwardPort) : null}
                    onValue={n => set('forwardPort', n ? String(n) : '')} />
                </label>
              </div>
            )}
          </>
        )}

        <label className="ls-check">
          <input type="checkbox" checked={form.autoStart} onChange={e => set('autoStart', e.target.checked)} />
          <span>Start this link automatically when the host starts</span>
        </label>

        <div className="pr-btns">
          <button type="button" disabled={busy || !form.name.trim()} onClick={onSave}>
            {busy ? <Loader2 size={14} className="pd-spin" /> : <Check size={14} />} {editing ? 'Save and restart' : 'Add it'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What the analyser has said
   ------------------------------------------------------------------------- */
function MessagesDialog({ link, onClose }: { link: Link; onClose: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try { setRows(await api<any[]>(`/instrument-links/${link.id}/messages`)); }
      catch { setRows([]); }
    })();
  }, [link.id]);

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{link.name} — what it has sent</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          Everything received, verbatim, whether or not it could be understood — a message nobody could map is
          exactly what is needed in order to map it.
        </p>
        {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? (
          <p className="muted">Nothing yet. Point the analyser at this host and run a sample.</p>
        ) : (
          <ul className="il-messages">
            {rows.map(row => (
              <li key={row.id}>
                <div className="il-msg-head" onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                  <span className={`badge ${row.kind === 'control' ? 'done' : row.kind === 'unknown' ? 'warning' : ''}`}>{row.kind}</span>
                  <strong>{row.sample_id || '(no sample id)'}</strong>
                  <span className="muted">
                    {row.result_count} result{row.result_count === 1 ? '' : 's'}
                    {row.lot_number ? ` · lot ${row.lot_number}` : ''}
                    {' · '}{String(row.received_at).slice(0, 16).replace('T', ' ')}
                    {row.forward_status !== 'not_required' ? ` · forward ${row.forward_status}` : ''}
                  </span>
                </div>
                {expanded === row.id && (
                  <div className="il-msg-body">
                    {row.parsed_values?.length > 0 && (
                      <table className="iqc-sheet">
                        <thead><tr><th>Analyser code</th><th>Read as</th><th>Value</th><th>Unit</th><th>Flag</th></tr></thead>
                        <tbody>
                          {row.parsed_values.map((v: any, i: number) => (
                            <tr key={i}>
                              <td>{v.code}</td>
                              <td className={v.analyte === v.code ? 'u' : ''}>{v.analyte}</td>
                              <td>{v.value}</td><td className="u">{v.unit ?? ''}</td><td className="u">{v.flag ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <pre className="il-raw">{row.raw_message}</pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="pr-btns"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Proving a mapping before trusting it
   ------------------------------------------------------------------------- */
function TryDialog({ link, onClose }: { link: Link; onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide" onClick={e => e.stopPropagation()}>
        <header>
          <h4><TestTube2 size={15} /> Try a transmission on {link.name}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>
        <p className="iqc-modal-lead">
          Paste a transmission this analyser actually produced and see exactly what SECHLIMS would make of it —
          which analytes, and whether it would be treated as a control. Nothing is recorded; this answers a
          question rather than making an entry.
        </p>
        <TextField as="textarea" rows={8} className="iqc-paste" value={text} onValue={setText}
          placeholder={'H|\\^&|||XN-550^1.0|||||||P|1|20260829103000\nO|1|QC2||^^^^FBC|R||20260829102800|||||||||||||||||F\nR|1|^^^HGB|13.4|g/dL||N||F\nL|1|N'} />
        {problem && <Notice kind="error">{problem}</Notice>}
        {result && (
          <div className="il-try-result">
            {result.messages.map((message: any, index: number) => (
              <div key={index}>
                <p>
                  <strong>{message.sampleId || '(no sample id)'}</strong>
                  {' — would be treated as '}
                  <span className={`badge ${message.wouldBeTreatedAs === 'control' ? 'done' : 'warning'}`}>{message.wouldBeTreatedAs}</span>
                  {message.instrument ? ` · ${message.instrument}` : ''}
                </p>
                <table className="iqc-sheet">
                  <thead><tr><th>Analyser code</th><th>Read as</th><th>Value</th><th>Unit</th></tr></thead>
                  <tbody>
                    {message.results.map((r: any, i: number) => (
                      <tr key={i}>
                        <td>{r.code}</td>
                        <td className={r.mapped ? '' : 'u'}>{r.analyte}{!r.mapped && ' (not mapped)'}</td>
                        <td>{r.value}</td><td className="u">{r.unit ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {result.messages.length === 0 && <p className="muted">Nothing in that could be read as {result.protocol}.</p>}
          </div>
        )}
        <div className="pr-btns">
          <button type="button" disabled={busy || !text.trim()} onClick={async () => {
            setBusy(true); setProblem(null);
            try { setResult(await api(`/instrument-links/${link.id}/simulate`, { method: 'POST', body: JSON.stringify({ text }) })); }
            catch (e) { setProblem(errorText(e)); setResult(null); }
            finally { setBusy(false); }
          }}>
            {busy ? <Loader2 size={14} className="pd-spin" /> : <TestTube2 size={14} />} Try it
          </button>
          <button type="button" className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export { Trash2 as RetireLinkIcon };
