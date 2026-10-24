import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Copy, Download, Loader2, MonitorSmartphone, Plus, RefreshCw, ShieldCheck, Trash2,
} from 'lucide-react';
import { api, apiRead, errorText, API_BASE, getToken } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  DEVICE_STATE_LABELS, DEVICE_STATE_TONES, FILL_STATE_LABELS, FILL_STATE_TONES,
  VERIFY_STATUS_TONES, type DeviceState, type FillState,
} from '../../../shared/constants/resultFiller';
import { Facts, Field, Note, Panel, Pick, Switch, when, type SectionProps } from './shared';

/**
 * The Result Filler extension, configured and administered from inside the
 * module that owns the transmissions it fills from.
 *
 * Five sections, in the order the work is done: see what the extension is
 * doing, give a bench computer a browser to do it in, tell it which forms
 * exist, tell it which box takes which parameter, and read what it filled.
 *
 * The one thing every screen here is built to keep visible is that this is a
 * FILLING tool. Nothing on these screens saves, authorises or releases a
 * result, and nothing here can make the extension do so.
 */

const TABS = ['Install', 'Browsers', 'Forms', 'Parameter names', 'Field mappings', 'Activity'] as const;
type Tab = (typeof TABS)[number];

type Adapter = {
  id: number; adapterCode: string; name: string; platform: string; description: string | null;
  urlPattern: string; urlMatchMode: string; formSelector: string | null;
  identifiers: Array<{ kind: string; selectorKind: string; selector: string; primary?: boolean }>;
  normaliser: string; overwritePolicy: string; lookbackHours: number; messageKind: string;
  matchByLabel: boolean; rowContainer: string | null; rowLabelCell: number; rowValueCell: number;
  autoDetect: boolean; serviceTitle: string | null;
  isBuiltin: boolean; isActive: boolean; notes: string | null;
  fieldCount?: number; fillCount?: number;
};

type FieldRow = {
  id?: number; source_code: string; analyte: string | null; selector_kind: string; selector: string;
  unit: string | null; decimals: number | null; factor: number | null; offset_value: number | null;
  value_map: string | null; is_required: number; note: string | null;
};

type Device = {
  id: number; device_code: string; label: string; location: string | null; state: DeviceState;
  browser: string | null; enrolled_at: string | null; last_seen_at: string | null; fills: number;
  note: string | null; pairing_code: string | null; pairing_expires_at: string | null;
  section_name: string | null; created_by_name: string | null; revoke_reason: string | null;
};

type Fill = {
  id: number; fill_uid: string; adapter_name: string | null; platform: string | null;
  device_label: string | null; user_name: string | null; identifier: string | null;
  verify_status: string | null; identifier_agreement: string | null; state: FillState;
  fields_offered: number; fields_filled: number; fields_skipped: number; fields_overwritten: number;
  issued_at: string; reported_at: string | null; page_title: string | null; page_url: string | null;
  sample_id: string | null; unmatched: Array<{ analyte?: string; code?: string }>; detail: string[];
};

type Reference = {
  platforms: Array<{ key: string; label: string }>;
  urlMatchModes: Array<{ key: string; label: string }>;
  identifierKinds: Array<{ key: string; label: string }>;
  normalisers: Array<{ key: string; label: string }>;
  overwritePolicies: Array<{ key: string; label: string }>;
  selectorKinds: Array<{ key: string; label: string; hint: string }>;
  verifyStatuses: Record<string, string>;
  fillStates: Record<string, string>;
  defaultLookbackHours: number;
};

type Overview = {
  adapters: number; adaptersActive: number; devices: number; devicesPending: number;
  fillsToday: number; fieldsToday: number; failures: number; lastFillAt: string | null;
};

const blankAdapter = (): Adapter => ({
  id: 0, adapterCode: '', name: '', platform: 'lis', description: '',
  urlPattern: '', urlMatchMode: 'glob', formSelector: '',
  identifiers: [{ kind: 'sample', selectorKind: 'css', selector: '', primary: true }],
  normaliser: 'alnum', overwritePolicy: 'confirm', lookbackHours: 72, messageKind: 'patient',
  matchByLabel: true, rowContainer: '', rowLabelCell: 1, rowValueCell: 0,
  autoDetect: true, serviceTitle: null,
  isBuiltin: false, isActive: true, notes: '',
});

export default function ResultFiller({ onError, onNotice }: SectionProps) {
  const { can } = usePermissions();
  const mayEdit = can('analyser_middleware.result_filler', 'edit');
  const mayRemove = can('analyser_middleware.result_filler', 'void_archive');

  const [tab, setTab] = useState<Tab>('Install');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [summary, adapterRows, deviceRows] = await Promise.all([
      apiRead<Overview | null>('/result-filler/overview', null),
      apiRead<Adapter[]>('/result-filler/adapters', []),
      apiRead<Device[]>('/result-filler/devices', []),
    ]);
    if (summary) setOverview(summary);
    setAdapters(adapterRows);
    setDevices(deviceRows);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void (async () => {
      try { setReference(await api<Reference>('/result-filler/reference')); } catch { /* pickers degrade */ }
    })();
  }, []);

  const shared = { reference, mayEdit, mayRemove, busy, setBusy, onError, onNotice, reload: load };

  return (
    <>
      <div className="tabs is-inline rf-subtabs">
        {TABS.map(name => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>

      {tab === 'Install' && <Install overview={overview} adapters={adapters} devices={devices} {...shared} />}
      {tab === 'Browsers' && <Browsers devices={devices} {...shared} />}
      {tab === 'Forms' && <Forms adapters={adapters} {...shared} />}
      {tab === 'Parameter names' && <ParameterNames adapters={adapters} {...shared} />}
      {tab === 'Field mappings' && <Mappings adapters={adapters} {...shared} />}
      {tab === 'Activity' && <Activity adapters={adapters} {...shared} />}
    </>
  );
}

type SharedProps = {
  reference: Reference | null;
  mayEdit: boolean;
  mayRemove: boolean;
  busy: string | null;
  setBusy: (key: string | null) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  reload: () => Promise<void>;
};

/* ============================================================================
   Install
   ========================================================================= */
function Install({ overview, adapters, devices, onError, onNotice, setBusy, busy }: SharedProps & {
  overview: Overview | null; adapters: Adapter[]; devices: Device[];
}) {
  const [host, setHost] = useState(() => window.location.origin);

  async function download() {
    setBusy('package'); onError(null);
    try {
      const token = getToken();
      const response = await fetch(`${API_BASE}/result-filler/package?host=${encodeURIComponent(host)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'sechlims-result-filler.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      onNotice('The extension package was downloaded, already pointed at this host.');
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const live = adapters.filter(a => a.isActive).length;
  const enrolled = devices.filter(d => d.state === 'enrolled').length;

  return (
    <>
      <div className="rf-kpis">
        <div><b>{live}</b><span>Forms supported</span></div>
        <div><b>{enrolled}</b><span>Browsers enrolled</span></div>
        <div><b>{overview?.fillsToday ?? 0}</b><span>Forms filled today</span></div>
        <div><b>{overview?.fieldsToday ?? 0}</b><span>Fields filled today</span></div>
      </div>

      <Panel
        title="Install on a bench computer"
        subtitle="Four steps, once per computer."
        actions={<Field label="Address staff open SECHLIMS at" value={host} onValue={setHost} />}
      >
        <ol className="rf-steps">
          <li>
            <strong>Download the package</strong>
            <span>It arrives already pointed at the address above.</span>
            <button className="btn" onClick={() => void download()} disabled={busy === 'package'}>
              {busy === 'package' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} Download extension
            </button>
          </li>
          <li>
            <strong>Load it in Chrome or Edge</strong>
            <span>Unzip it somewhere permanent, open <code>chrome://extensions</code>, turn on Developer mode, then Load unpacked.</span>
          </li>
          <li>
            <strong>Allow the sites</strong>
            <span>In the extension’s Settings, allow this SECHLIMS site and any other result-entry site. The bubble appears on those sites and nowhere else.</span>
          </li>
          <li>
            <strong>Pair and sign in</strong>
            <span>Issue a pairing code under Browsers, enter it in the extension, then sign in with the usual SECHLIMS account.</span>
          </li>
        </ol>
      </Panel>

      <Panel title="How staff use it" subtitle="Open the form, check the bubble, press one button.">
        <ol className="rf-flow">
          <li><b>Open</b> the patient, sample or control result-entry form.</li>
          <li>The bubble <b>reads the whole page</b> — the barcode printed in a table cell, the patient’s number, and every result box with the name beside it.</li>
          <li>SECHLIMS <b>verifies</b> the identifier against the analyser transmission and matches each reading to the box it belongs in.</li>
          <li>Press <b>Populate results</b>. The fields fill.</li>
          <li><b>Review, save and authorise</b> exactly as before.</li>
        </ol>
        <Note tone="warn">
          The extension fills fields. It does not save, authorise or release anything, and it never writes to the
          analyser connections or to any transmission.
        </Note>
      </Panel>
    </>
  );
}

/* ============================================================================
   Browsers
   ========================================================================= */
function Browsers({ devices, mayEdit, mayRemove, busy, setBusy, onError, onNotice, reload }: SharedProps & { devices: Device[] }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', location: '', note: '' });
  const [issued, setIssued] = useState<{ label: string; code: string } | null>(null);

  async function create() {
    if (!form.label.trim()) { onError('Name the computer this extension is for.'); return; }
    setBusy('device'); onError(null);
    try {
      const outcome = await api<{ pairingCode: string }>('/result-filler/devices', { method: 'POST', body: JSON.stringify(form) });
      setIssued({ label: form.label, code: outcome.pairingCode });
      setForm({ label: '', location: '', note: '' });
      setAdding(false);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function act(device: Device, action: 'pair' | 'revoke') {
    if (action === 'revoke' && !window.confirm(`Revoke ${device.label}? The extension on that computer stops working immediately.`)) return;
    setBusy(`d${device.id}`); onError(null);
    try {
      const outcome = await api<{ pairingCode?: string }>(`/result-filler/devices/${device.id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      if (outcome.pairingCode) setIssued({ label: device.label, code: outcome.pairingCode });
      else onNotice(`${device.label} was revoked.`);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function remove(device: Device) {
    if (!window.confirm(`Remove ${device.label} from the register?`)) return;
    setBusy(`d${device.id}`); onError(null);
    try { await api(`/result-filler/devices/${device.id}`, { method: 'DELETE' }); await reload(); }
    catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <>
      {issued && (
        <Panel title="Pairing code" subtitle={`For ${issued.label}. It works once, and expires in an hour.`} tone="lock">
          <div className="rf-code">
            <code>{issued.code}</code>
            <button className="btn" onClick={() => { void navigator.clipboard?.writeText(issued.code); onNotice('Pairing code copied.'); }}>
              <Copy size={13} /> Copy
            </button>
            <button className="btn ghost" onClick={() => setIssued(null)}>Done</button>
          </div>
          <Note>Enter it in the extension’s Settings on that computer. Nothing can be filled until a person also signs in.</Note>
        </Panel>
      )}

      <Panel
        title="Enrolled browsers"
        subtitle="A browser may ask SECHLIMS for pending results only once an administrator has enrolled it."
        actions={mayEdit && (
          <button className="btn" onClick={() => setAdding(v => !v)}><Plus size={13} /> Add a browser</button>
        )}
      >
        {adding && (
          <div className="mw-inset mw-grid">
            <Field label="Computer" value={form.label} onValue={v => setForm(f => ({ ...f, label: v }))} placeholder="Haematology bench 1" />
            <Field label="Where it is" value={form.location} onValue={v => setForm(f => ({ ...f, location: v }))} placeholder="Main laboratory" />
            <Field label="Note" value={form.note} onValue={v => setForm(f => ({ ...f, note: v }))} wide />
            <div className="mw-actions">
              <button className="btn" onClick={() => void create()} disabled={busy === 'device'}>
                {busy === 'device' ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />} Issue a pairing code
              </button>
              <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}

        {!devices.length ? <Note>No browser has been enrolled yet.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr><th>Computer</th><th>Browser</th><th>State</th><th>Last seen</th><th className="num">Fills</th><th /></tr>
            </thead>
            <tbody>
              {devices.map(device => (
                <tr key={device.id} className={device.state === 'revoked' ? 'mw-row-off' : undefined}>
                  <td>
                    <strong><MonitorSmartphone size={12} /> {device.label}</strong>
                    <span className="mw-sub">{[device.location, device.section_name].filter(Boolean).join(' · ') || device.device_code}</span>
                  </td>
                  <td>{device.browser ?? '—'}</td>
                  <td>
                    <span className={`mw-chip t-${DEVICE_STATE_TONES[device.state] ?? 'idle'}`}>{DEVICE_STATE_LABELS[device.state] ?? device.state}</span>
                    {device.state === 'pending' && device.pairing_code && <span className="mw-sub">Code issued, not yet used</span>}
                    {device.state === 'revoked' && device.revoke_reason && <span className="mw-sub">{device.revoke_reason}</span>}
                  </td>
                  <td>{when(device.last_seen_at)}</td>
                  <td className="num">{device.fills}</td>
                  <td className="mw-row-actions">
                    {mayEdit && device.state !== 'revoked' && (
                      <>
                        <button className="btn ghost" onClick={() => void act(device, 'pair')} disabled={busy === `d${device.id}`}>New code</button>
                        <button className="btn ghost" onClick={() => void act(device, 'revoke')} disabled={busy === `d${device.id}`}>Revoke</button>
                      </>
                    )}
                    {mayRemove && device.fills === 0 && (
                      <button className="btn ghost" onClick={() => void remove(device)} disabled={busy === `d${device.id}`}><Trash2 size={12} /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/* ============================================================================
   Forms
   ========================================================================= */
function Forms({ adapters, reference, mayEdit, mayRemove, busy, setBusy, onError, onNotice, reload }: SharedProps & { adapters: Adapter[] }) {
  const [editing, setEditing] = useState<Adapter | null>(null);

  async function save() {
    if (!editing) return;
    setBusy('adapter'); onError(null);
    try {
      if (editing.id) await api(`/result-filler/adapters/${editing.id}`, { method: 'PUT', body: JSON.stringify(editing) });
      else await api('/result-filler/adapters', { method: 'POST', body: JSON.stringify(editing) });
      onNotice(`${editing.name} saved.`);
      setEditing(null);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function remove(adapter: Adapter) {
    if (!window.confirm(`Remove ${adapter.name}?`)) return;
    setBusy(`a${adapter.id}`); onError(null);
    try {
      const outcome = await api<{ note?: string }>(`/result-filler/adapters/${adapter.id}`, { method: 'DELETE' });
      if (outcome.note) onNotice(outcome.note);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const set = (patch: Partial<Adapter>) => setEditing(current => (current ? { ...current, ...patch } : current));
  const identifier = editing?.identifiers?.[0] ?? { kind: 'sample', selectorKind: 'css', selector: '', primary: true };

  return (
    <>
      <Panel
        title="Result-entry forms"
        subtitle="Which pages carry a form, how the identifier is read off it, and what the filler may do there."
        actions={mayEdit && <button className="btn" onClick={() => setEditing(blankAdapter())}><Plus size={13} /> Add a form</button>}
      >
        {!adapters.length ? <Note>No form has been configured yet.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr><th>Form</th><th>Pages</th><th>Read by</th><th>Overwrite</th><th className="num">Fields</th><th>State</th><th /></tr>
            </thead>
            <tbody>
              {adapters.map(adapter => (
                <tr key={adapter.id} className={adapter.isActive ? undefined : 'mw-row-off'}>
                  <td>
                    <strong>{adapter.name}</strong>
                    <span className="mw-sub">{adapter.platform} · {adapter.adapterCode}{adapter.isBuiltin ? ' · built in' : ''}</span>
                  </td>
                  <td className="mono">{adapter.urlPattern}</td>
                  <td>
                    {adapter.autoDetect
                      ? <span className="mw-chip t-ok">Reading the page</span>
                      : adapter.identifiers?.[0]?.selector || <span className="t-warn">no identifier set</span>}
                    <span className="mw-sub">{adapter.normaliser} · {adapter.lookbackHours}h window</span>
                  </td>
                  <td>{reference?.overwritePolicies.find(p => p.key === adapter.overwritePolicy)?.label.split('—')[0] ?? adapter.overwritePolicy}</td>
                  <td className="num">{adapter.autoDetect ? `${adapter.fieldCount ?? 0} + detected` : adapter.fieldCount ?? 0}</td>
                  <td><span className={`mw-chip t-${adapter.isActive ? 'ok' : 'idle'}`}>{adapter.isActive ? 'Active' : 'Off'}</span></td>
                  <td className="mw-row-actions">
                    {mayEdit && <button className="btn ghost" onClick={() => setEditing(adapter)}>Edit</button>}
                    {mayRemove && <button className="btn ghost" onClick={() => void remove(adapter)} disabled={busy === `a${adapter.id}`}><Trash2 size={12} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {editing && (
        <Panel title={editing.id ? `Edit ${editing.name}` : 'New form'} subtitle="A form is recognised by its address AND by a marker on the page, so a page that merely looks right is not filled.">
          <div className="mw-grid">
            <Field label="Name" value={editing.name} onValue={v => set({ name: v })} placeholder="LHIMS — full blood count" />
            <Pick label="Platform" value={editing.platform} onValue={v => set({ platform: v })} options={reference?.platforms ?? []} />
            {!editing.id && <Field label="Code" value={editing.adapterCode} onValue={v => set({ adapterCode: v })} placeholder="Left blank, one is allocated" />}
            <Field label="Pages" value={editing.urlPattern} onValue={v => set({ urlPattern: v })} placeholder="*lhims*/result*" />
            <Pick label="Matched by" value={editing.urlMatchMode} onValue={v => set({ urlMatchMode: v })} options={reference?.urlMatchModes ?? []} />
            <Field label="Marker on the page" value={editing.formSelector ?? ''} onValue={v => set({ formSelector: v })}
              placeholder="table.results" hint="A CSS selector that exists only on this form." />

            <Switch label="Read the page rather than being told where its boxes are" checked={editing.autoDetect}
              onChange={v => set({ autoDetect: v })}
              hint="The identifier is taken from whatever labels it — a column header, a caption — and each parameter from the label beside its box. Turn this off only for a form that gives nothing to read." />
            {!editing.autoDetect && (
              <Field label="Identifier field" value={identifier.selector} onValue={v => set({ identifiers: [{ ...identifier, selector: v, primary: true }] })}
                placeholder="specimen_id" />
            )}
            {!editing.autoDetect && (
              <Pick label="Found by" value={identifier.selectorKind} onValue={v => set({ identifiers: [{ ...identifier, selectorKind: v, primary: true }] })}
                options={reference?.selectorKinds ?? []} hint={reference?.selectorKinds.find(s => s.key === identifier.selectorKind)?.hint} />
            )}
            {!editing.autoDetect && (
              <Pick label="Identifier is" value={identifier.kind} onValue={v => set({ identifiers: [{ ...identifier, kind: v, primary: true }] })}
                options={reference?.identifierKinds ?? []} />
            )}

            <Pick label="Identifiers match when" value={editing.normaliser} onValue={v => set({ normaliser: v })} options={reference?.normalisers ?? []} />
            <Pick label="Transmissions" value={editing.messageKind} onValue={v => set({ messageKind: v })}
              options={[{ key: 'patient', label: 'Patient results' }, { key: 'control', label: 'Control runs' }, { key: 'any', label: 'Either' }]} />
            <Field label="Look back (hours)" type="number" value={String(editing.lookbackHours)} onValue={v => set({ lookbackHours: Number(v) || 72 })}
              hint="An identifier reused after this long is a different sample." />
            <Pick label="A box that already has a value" value={editing.overwritePolicy} onValue={v => set({ overwritePolicy: v })}
              options={reference?.overwritePolicies ?? []} wide />

            <Field label="Result grid" value={editing.rowContainer ?? ''} onValue={v => set({ rowContainer: v })}
              placeholder="table.iqc-entry" hint="Where row matching looks. Left blank, the whole page." />
            <Field label="Label column" type="number" value={String(editing.rowLabelCell)} onValue={v => set({ rowLabelCell: Number(v) || 1 })} />
            <Field label="Value column" type="number" value={String(editing.rowValueCell)} onValue={v => set({ rowValueCell: Number(v) || 0 })}
              hint="0 means the last column that holds a field." />
            <Switch label="Also fill by row label, for parameters with no mapping" checked={editing.matchByLabel}
              onChange={v => set({ matchByLabel: v })} />
            <Switch label="Active" checked={editing.isActive} onChange={v => set({ isActive: v })} />
            <Field label="Notes" value={editing.notes ?? ''} onValue={v => set({ notes: v })} area wide />

            <div className="mw-actions">
              <button className="btn" onClick={() => void save()} disabled={busy === 'adapter'}>
                {busy === 'adapter' ? <Loader2 size={13} className="spin" /> : null} Save form
              </button>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}

/* ============================================================================
   Parameter names
   ----------------------------------------------------------------------------
   The filler matches what an analyser sends to what a form asks for through a
   dictionary of the names both of them use. Most of it is built in. The rest is
   local, and belongs to the laboratory rather than to a release.
   ========================================================================= */
type AliasRow = {
  id: number; canonical: string; alias: string; adapter_id: number | null;
  adapter_name: string | null; note: string | null; created_by_name: string | null; created_at: string;
};
type DictionaryEntry = { canonical: string; discipline: string; aliases: string[] };

function ParameterNames({ adapters, mayEdit, busy, setBusy, onError, onNotice }: SharedProps & { adapters: Adapter[] }) {
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [dictionary, setDictionary] = useState<DictionaryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ canonical: '', alias: '', adapterId: '', note: '' });

  const load = useCallback(async () => {
    try {
      const data = await apiRead<{ rows: AliasRow[]; dictionary: DictionaryEntry[] }>('/result-filler/aliases', { rows: [], dictionary: [] });
      setRows(data.rows);
      setDictionary(data.dictionary);
    } catch (e) { onError(errorText(e)); }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!form.canonical.trim() || !form.alias.trim()) { onError('Give the parameter and the other name for it.'); return; }
    setBusy('alias'); onError(null);
    try {
      await api('/result-filler/aliases', { method: 'POST', body: JSON.stringify(form) });
      onNotice(`“${form.alias}” now means ${form.canonical}.`);
      setForm({ canonical: '', alias: '', adapterId: '', note: '' });
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function remove(row: AliasRow) {
    setBusy(`x${row.id}`); onError(null);
    try { await api(`/result-filler/aliases/${row.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const needle = search.trim().toUpperCase();
  const shown = needle
    ? dictionary.filter(entry => entry.canonical.toUpperCase().includes(needle)
      || entry.aliases.some(alias => alias.toUpperCase().includes(needle)))
    : dictionary;

  return (
    <>
      <Panel
        title="Names this laboratory has taught it"
        subtitle="Added here, understood everywhere — no reinstall on any bench."
        actions={<span className="mw-chip t-info">{rows.length} added</span>}
      >
        {mayEdit && (
          <div className="mw-inset mw-grid">
            <Pick label="Parameter" value={form.canonical} onValue={v => setForm(f => ({ ...f, canonical: v }))}
              options={dictionary.map(entry => ({ key: entry.canonical, label: `${entry.canonical} (${entry.discipline})` }))}
              blank="Choose the parameter" />
            <Field label="Is also called" value={form.alias} onValue={v => setForm(f => ({ ...f, alias: v }))} placeholder="HB CONC" />
            <Pick label="On which form" value={form.adapterId} onValue={v => setForm(f => ({ ...f, adapterId: v }))}
              options={adapters.map(a => ({ key: String(a.id), label: a.name }))} blank="Every form" />
            <Field label="Note" value={form.note} onValue={v => setForm(f => ({ ...f, note: v }))} />
            <div className="mw-actions">
              <button className="btn" onClick={() => void add()} disabled={busy === 'alias'}>
                {busy === 'alias' ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Teach this name
              </button>
            </div>
          </div>
        )}

        {!rows.length ? <Note>Nothing has needed teaching yet.</Note> : (
          <table className="data-table mw-table">
            <thead><tr><th>Parameter</th><th>Also called</th><th>On</th><th>Added by</th><th /></tr></thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td><strong>{row.canonical}</strong></td>
                  <td>{row.alias}{row.note && <span className="mw-sub">{row.note}</span>}</td>
                  <td>{row.adapter_name ?? 'Every form'}</td>
                  <td>{row.created_by_name ?? '—'}<span className="mw-sub">{when(row.created_at)}</span></td>
                  <td className="mw-row-actions">
                    {mayEdit && <button className="btn ghost" onClick={() => void remove(row)} disabled={busy === `x${row.id}`}><Trash2 size={12} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Names it already knows"
        subtitle="What an analyser may send, and what a form may ask for, for each parameter."
        actions={<Field label="Find" value={search} onValue={setSearch} placeholder="sodium, SGPT, HGB" />}
      >
        {!shown.length ? <Note>No parameter matches.</Note> : (
          <table className="data-table mw-table">
            <thead><tr><th>Parameter</th><th>Also understood as</th><th>Discipline</th></tr></thead>
            <tbody>
              {shown.map(entry => (
                <tr key={entry.canonical}>
                  <td><strong>{entry.canonical}</strong></td>
                  <td>
                    <ul className="mw-chips">
                      {entry.aliases.map(alias => <li key={alias}><span className="mw-chip">{alias}</span></li>)}
                      {rows.filter(row => row.canonical === entry.canonical).map(row => (
                        <li key={row.id}><span className="mw-chip t-info">{row.alias}</span></li>
                      ))}
                      {!entry.aliases.length && !rows.some(row => row.canonical === entry.canonical) && <li className="mw-sub">its own name only</li>}
                    </ul>
                  </td>
                  <td>{entry.discipline}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

/* ============================================================================
   Field mappings
   ========================================================================= */
function Mappings({ adapters, reference, mayEdit, busy, setBusy, onError, onNotice }: SharedProps & { adapters: Adapter[] }) {
  const [adapterId, setAdapterId] = useState('');
  const [rows, setRows] = useState<FieldRow[]>([]);
  const adapter = useMemo(() => adapters.find(a => String(a.id) === adapterId) ?? null, [adapters, adapterId]);

  useEffect(() => {
    if (!adapterId) { setRows([]); return; }
    void (async () => {
      try { setRows(await api<FieldRow[]>(`/result-filler/adapters/${adapterId}/fields`)); }
      catch (e) { onError(errorText(e)); }
    })();
  }, [adapterId, onError]);

  useEffect(() => { if (!adapterId && adapters.length) setAdapterId(String(adapters[0].id)); }, [adapters, adapterId]);

  const set = (index: number, patch: Partial<FieldRow>) =>
    setRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const add = () => setRows(current => [...current, {
    source_code: '', analyte: '', selector_kind: 'row', selector: '', unit: '',
    decimals: null, factor: null, offset_value: null, value_map: null, is_required: 0, note: '',
  }]);

  async function save() {
    if (!adapterId) return;
    setBusy('fields'); onError(null);
    try {
      const outcome = await api<{ fields: number }>(`/result-filler/adapters/${adapterId}/fields`, {
        method: 'PUT', body: JSON.stringify({ fields: rows }),
      });
      onNotice(`${outcome.fields} field mapping(s) saved.`);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <Panel
      title="Field mappings"
      subtitle="What this form calls each analyser parameter, and where that parameter’s box is."
      actions={(
        <>
          <Pick label="Form" value={adapterId} onValue={setAdapterId} options={adapters.map(a => ({ key: String(a.id), label: a.name }))} />
          {mayEdit && adapterId && <button className="btn ghost" onClick={add}><Plus size={13} /> Add</button>}
          {mayEdit && adapterId && (
            <button className="btn" onClick={() => void save()} disabled={busy === 'fields'}>
              {busy === 'fields' ? <Loader2 size={13} className="spin" /> : null} Save mappings
            </button>
          )}
        </>
      )}
    >
      {adapter?.matchByLabel && (
        <Note>
          This form also fills by row label, so a parameter with no mapping below is still filled when a row on the
          page is labelled with its name. Map a parameter here when the form labels it differently, or when the value
          needs converting.
        </Note>
      )}

      {!adapterId ? <Note>Choose a form.</Note> : !rows.length ? <Note>No parameter is mapped explicitly.</Note> : (
        <table className="data-table mw-table rf-fields">
          <thead>
            <tr>
              <th>Analyser sends</th><th>This form calls it</th><th>Found by</th><th>Selector</th>
              <th>Unit</th><th className="num">Decimals</th><th className="num">×</th><th>Required</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                <td><input value={row.source_code} onChange={e => set(index, { source_code: e.target.value })} placeholder="WBC" /></td>
                <td><input value={row.analyte ?? ''} onChange={e => set(index, { analyte: e.target.value })} placeholder="White cells" /></td>
                <td>
                  <select value={row.selector_kind} onChange={e => set(index, { selector_kind: e.target.value })}>
                    {(reference?.selectorKinds ?? []).map(kind => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
                  </select>
                </td>
                <td><input value={row.selector} onChange={e => set(index, { selector: e.target.value })} placeholder="White cells" /></td>
                <td><input value={row.unit ?? ''} onChange={e => set(index, { unit: e.target.value })} placeholder="10^3/uL" /></td>
                <td className="num"><input type="number" value={row.decimals ?? ''} onChange={e => set(index, { decimals: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                <td className="num"><input type="number" step="any" value={row.factor ?? ''} onChange={e => set(index, { factor: e.target.value === '' ? null : Number(e.target.value) })} /></td>
                <td><input type="checkbox" checked={Number(row.is_required) === 1} onChange={e => set(index, { is_required: e.target.checked ? 1 : 0 })} /></td>
                <td><button className="btn ghost" onClick={() => setRows(current => current.filter((_, i) => i !== index))}><Trash2 size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Note tone="warn">
        A required parameter that cannot be found exactly once on the page stops the whole fill — nothing is entered
        and the bench is told which field is missing.
      </Note>
    </Panel>
  );
}

/* ============================================================================
   Activity
   ========================================================================= */
function Activity({ adapters, onError }: SharedProps & { adapters: Adapter[] }) {
  const [rows, setRows] = useState<Fill[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState({ search: '', state: '', adapterId: '' });

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '150' });
    if (filter.search) query.set('search', filter.search);
    if (filter.state) query.set('state', filter.state);
    if (filter.adapterId) query.set('adapterId', filter.adapterId);
    try {
      const data = await apiRead<{ total: number; rows: Fill[] }>(`/result-filler/activity?${query}`, { total: 0, rows: [] });
      setRows(data.rows); setTotal(data.total);
    } catch (e) { onError(errorText(e)); }
  }, [filter, onError]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Panel
      title="What the extension filled"
      subtitle={`${total} fill(s) on the record. Every one names the transmission it came from, the browser and the person.`}
      actions={<button className="btn ghost" onClick={() => void load()}><RefreshCw size={13} /> Refresh</button>}
    >
      <div className="mw-grid">
        <Field label="Sample or page" value={filter.search} onValue={v => setFilter(f => ({ ...f, search: v }))} />
        <Pick label="Outcome" value={filter.state} onValue={v => setFilter(f => ({ ...f, state: v }))}
          options={Object.entries(FILL_STATE_LABELS).map(([key, label]) => ({ key, label }))} blank="Any outcome" />
        <Pick label="Form" value={filter.adapterId} onValue={v => setFilter(f => ({ ...f, adapterId: v }))}
          options={adapters.map(a => ({ key: String(a.id), label: a.name }))} blank="Any form" />
      </div>

      {!rows.length ? <Note>Nothing has been filled yet.</Note> : (
        <table className="data-table mw-table">
          <thead>
            <tr><th>When</th><th>Sample</th><th>Form</th><th>Who</th><th>Browser</th><th className="num">Filled</th><th>Outcome</th></tr>
          </thead>
          <tbody>
            {rows.map(fill => (
              <tr key={fill.id}>
                <td>{when(fill.issued_at)}</td>
                <td>
                  <strong>{fill.identifier ?? '—'}</strong>
                  {fill.verify_status && (
                    <span className={`mw-sub t-${VERIFY_STATUS_TONES[fill.verify_status as keyof typeof VERIFY_STATUS_TONES] === 'crit' ? 'crit' : VERIFY_STATUS_TONES[fill.verify_status as keyof typeof VERIFY_STATUS_TONES] === 'warn' ? 'warn' : ''}`}>
                      {fill.verify_status.replace(/_/g, ' ')}
                    </span>
                  )}
                </td>
                <td>{fill.adapter_name ?? '—'}<span className="mw-sub">{fill.page_title ?? ''}</span></td>
                <td>{fill.user_name ?? '—'}</td>
                <td>{fill.device_label ?? '—'}</td>
                <td className="num">
                  {fill.fields_filled}/{fill.fields_offered}
                  {fill.fields_overwritten > 0 && <span className="mw-sub t-warn">{fill.fields_overwritten} overwritten</span>}
                </td>
                <td>
                  <span className={`mw-chip t-${FILL_STATE_TONES[fill.state] ?? 'idle'}`}>{FILL_STATE_LABELS[fill.state] ?? fill.state}</span>
                  {Array.isArray(fill.detail) && fill.detail.length > 0 && <span className="mw-sub t-warn">{fill.detail[0]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** Kept so the facts helper is used where a device summary is wanted. */
export function DeviceFacts({ device }: { device: Device }) {
  return <Facts items={[
    { label: 'Computer', value: device.label },
    { label: 'Enrolled', value: when(device.enrolled_at) },
    { label: 'Last seen', value: when(device.last_seen_at) },
    { label: 'Fills', value: device.fills },
  ]} />;
}
