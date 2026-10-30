import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Field, Note, Panel, Pick, Switch, when, type Destination, type SectionProps } from './shared';

/**
 * Parameter mappings — what a result is CALLED at each step of its journey.
 *
 * A result changes name twice between the analyser and the record it ends up
 * in. The machine sends its own mnemonic, which SECHLIMS has to read as a
 * parameter; and when SECHLIMS passes that result on — to LHIMS, or through
 * the Result Filler into a result-entry form — it has to be named again in the
 * receiving system's words.
 *
 * Those two translations used to be configured in different screens by
 * different people, and neither screen said the other existed. They are the
 * same kind of decision and they belong side by side, which is what this tab
 * is: one for each direction.
 *
 * Nothing here can touch a connection. A name is not a socket, so saving a
 * mapping refreshes the running link in place — an analyser mid-transmission
 * notices nothing at all.
 */

const TABS = ['Analyser → SECHLIMS', 'SECHLIMS → LIS'] as const;
type Tab = (typeof TABS)[number];

type MappingLink = {
  id: number; name: string; profileKey: string | null; profileLabel: string | null;
  role: string; mode: string; equipmentName: string | null; sectionName: string | null;
  messages: number; analyteMap: Record<string, string>;
  lhimsMapKey: string | null; measureMap: Record<string, number>; carriesOnward: boolean;
};
type Profile = { key: string; label: string; vendor: string; discipline: string; analytes: Record<string, string> };
type LhimsMap = { key: string; label: string; vendor: string; measures: Array<{ code: string; measureId: number; label: string | null }> };
type Payload = { links: MappingLink[]; profiles: Profile[]; lhimsMaps: LhimsMap[] };

type SeenCode = {
  code: string; analyte: string; count: number; lastSeen: string;
  unit: string | null; namedBy: 'link' | 'profile' | 'none';
};

const EMPTY: Payload = { links: [], profiles: [], lhimsMaps: [] };

export default function MiddlewareParameterMappings({ destinations, canConfigure, onError, onNotice }: SectionProps) {
  const [tab, setTab] = useState<Tab>('Analyser → SECHLIMS');
  const [data, setData] = useState<Payload>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await apiRead<Payload>('/middleware/parameter-mappings', EMPTY)); }
    catch (e) { onError(errorText(e)); }
  }, [onError]);

  useEffect(() => { void load(); }, [load]);

  const shared = { links: data.links, canConfigure, busy, setBusy, onError, onNotice, reload: load };

  return (
    <>
      <div className="tabs is-inline rf-subtabs">
        {TABS.map(name => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>

      {tab === 'Analyser → SECHLIMS' && <FromAnalyser profiles={data.profiles} {...shared} />}
      {tab === 'SECHLIMS → LIS' && <ToLis lhimsMaps={data.lhimsMaps} destinations={destinations} {...shared} />}
    </>
  );
}


/* ============================================================================
   The names a parameter goes by, edited where they sit
   ----------------------------------------------------------------------------
   One component for both directions, so a name an analyser sends and a name a
   form asks for are worked on the same way. Press a name to change its
   characters, press the bin inside the editor to take it out of use, press
   "Add names" to put several in at once separated by commas.

   Nothing opens a dialog. A parameter's names are a small thing and editing
   one should be a small act, done where the name already is, with the row
   never moving under the hand that is working on it.
   ========================================================================= */
type NameTone = 'builtin' | 'added' | 'out';
export type EditableName = { key: string; text: string; tone: NameTone; note?: string };

function NameList({ names, canEdit, busy, onEdit, onRemove, onRestore, onAdd, addLabel, addHint, addPlaceholder }: {
  names: EditableName[];
  canEdit: boolean;
  busy: boolean;
  onEdit: (name: EditableName, next: string) => Promise<void>;
  onRemove: (name: EditableName) => Promise<void>;
  onRestore: (name: EditableName) => Promise<void>;
  onAdd: (values: string[]) => Promise<void>;
  addLabel?: string;
  addHint?: string;
  addPlaceholder?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState('');

  const open = (name: EditableName) => { setAdding(false); setEditing(name.key); setDraft(name.text); };
  const close = () => { setEditing(null); setDraft(''); };

  /** One name per comma, trimmed, with the blanks and the repeats dropped. */
  const split = (raw: string) => [...new Set(raw.split(',').map(v => v.trim()).filter(Boolean))];

  return (
    <ul className="pm-names">
      {names.map(name => {
        if (editing === name.key) {
          return (
            <li key={name.key}>
              <div className="pm-editor">
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && draft.trim()) { void onEdit(name, draft.trim()).then(close); }
                    if (e.key === 'Escape') close();
                  }} />
                <div className="pm-editor-row">
                  <button className="btn" disabled={busy || !draft.trim() || draft.trim() === name.text}
                    onClick={() => void onEdit(name, draft.trim()).then(close)}>
                    {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save
                  </button>
                  <button className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
                  <button className="btn ghost pm-danger" disabled={busy} title="Take this name out of use"
                    onClick={() => void onRemove(name).then(close)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </li>
          );
        }
        return (
          <li key={name.key}>
            <span className={`pm-name${name.tone === 'added' ? ' is-added' : ''}${name.tone === 'out' ? ' is-out' : ''}`}>
              <button className="pm-text" disabled={!canEdit || name.tone === 'out'} title={name.note ?? 'Press to change or remove'}
                onClick={() => open(name)}>
                {name.text}
              </button>
              {name.tone === 'out' && canEdit && (
                <button className="pm-undo" disabled={busy} onClick={() => void onRestore(name)}>put back</button>
              )}
            </span>
          </li>
        );
      })}

      {canEdit && (
        <li>
          {adding ? (
            <div className="pm-editor">
              <input autoFocus value={fresh} onChange={e => setFresh(e.target.value)}
                placeholder={addPlaceholder ?? 'WBC, W.B.C, WHITE COUNT'}
                onKeyDown={e => {
                  if (e.key === 'Enter' && split(fresh).length) { void onAdd(split(fresh)).then(() => { setFresh(''); setAdding(false); }); }
                  if (e.key === 'Escape') { setFresh(''); setAdding(false); }
                }} />
              <span className="pm-editor-note">{addHint ?? 'Separate several with commas. Each becomes another name for this parameter.'}</span>
              <div className="pm-editor-row">
                <button className="btn" disabled={busy || !split(fresh).length}
                  onClick={() => void onAdd(split(fresh)).then(() => { setFresh(''); setAdding(false); })}>
                  {busy ? <Loader2 size={12} className="spin" /> : <Check size={12} />} Save
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => { setFresh(''); setAdding(false); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="pm-add" disabled={busy} onClick={() => { setEditing(null); setAdding(true); }}>
              <Plus size={11} /> {addLabel ?? 'Add names'}
            </button>
          )}
        </li>
      )}
    </ul>
  );
}

type PartProps = {
  links: MappingLink[];
  canConfigure: boolean;
  busy: string | null;
  setBusy: (value: string | null) => void;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  reload: () => Promise<void>;
};

/** The analyser picker both halves start from. */
function ChooseLink({ links, value, onValue, empty }: {
  links: MappingLink[]; value: string; onValue: (v: string) => void; empty: string;
}) {
  if (!links.length) return <Note>{empty}</Note>;
  return (
    <Pick
      label="Analyser" value={value} onValue={onValue} wide
      options={links.map(l => ({
        key: String(l.id),
        label: `${l.name}${l.sectionName ? ` · ${l.sectionName}` : ''}${l.profileLabel ? ` · ${l.profileLabel}` : ''}`,
      }))}
      blank="Choose the analyser"
    />
  );
}

/* ============================================================================
   Analyser → SECHLIMS
   ----------------------------------------------------------------------------
   What the machine's own mnemonic means. Most analysers need nothing here: the
   model's profile already names what it sends. This is for the machine that
   disagrees with the book, and for the parameter nobody has named yet.
   ========================================================================= */
function FromAnalyser({ links, profiles, canConfigure, busy, setBusy, onError, onNotice, reload }: PartProps & { profiles: Profile[] }) {
  const [linkId, setLinkId] = useState('');
  const [codes, setCodes] = useState<SeenCode[]>([]);
  const [search, setSearch] = useState('');
  const [newParameter, setNewParameter] = useState('');

  const link = links.find(l => String(l.id) === linkId) ?? null;
  const profile = profiles.find(p => p.key === link?.profileKey) ?? null;

  useEffect(() => {
    setCodes([]);
    setSearch('');
    if (!link) return;
    void (async () => {
      try {
        const seen = await apiRead<{ codes: SeenCode[] }>(`/middleware/parameter-mappings/${link.id}/codes`, { codes: [] });
        setCodes(seen.codes);
      } catch (e) { onError(errorText(e)); }
    })();
  }, [link, onError]);

  /**
   * What this analyser's codes mean, gathered the way a person thinks of them.
   *
   * Not a list of codes with a name beside each, which is how the database
   * holds it, but one row per PARAMETER with every code that reaches it. A
   * machine that sends HGB and another that sends HB are the same question
   * asked twice, and the answer belongs in one place.
   *
   * A code the link maps to its own spelling is one the laboratory has taken
   * out of use: the model would otherwise have claimed it, and this is how
   * that claim is refused without editing the release.
   */
  const parameters = useMemo(() => {
    const overrides = link?.analyteMap ?? {};
    const byParameter = new Map<string, EditableName[]>();
    const place = (parameter: string, name: EditableName) => {
      const list = byParameter.get(parameter) ?? [];
      list.push(name);
      byParameter.set(parameter, list);
    };
    const overriddenKey = (code: string) =>
      Object.keys(overrides).find(key => key.toUpperCase() === code.toUpperCase()) ?? null;

    for (const [code, parameter] of Object.entries(profile?.analytes ?? {})) {
      const own = overriddenKey(code);
      if (own && overrides[own].toUpperCase() === code.toUpperCase()) {
        place(parameter, { key: `out:${code}`, text: code, tone: 'out', note: parameter });
      } else if (!own) {
        place(parameter, { key: `builtin:${code}`, text: code, tone: 'builtin', note: parameter });
      }
    }
    for (const [code, parameter] of Object.entries(overrides)) {
      if (parameter.toUpperCase() === code.toUpperCase()) continue;   // taken out of use, above
      place(parameter, { key: `added:${code}`, text: code, tone: 'added', note: parameter });
    }
    return [...byParameter.entries()]
      .map(([parameter, names]) => ({ parameter, names }))
      .sort((a, b) => a.parameter.localeCompare(b.parameter));
  }, [link, profile]);

  /** Write a changed map, leaving the connection exactly where it was. */
  async function write(next: Record<string, string>, note: string) {
    if (!link) return;
    setBusy('analyte'); onError(null);
    try {
      await api(`/middleware/parameter-mappings/${link.id}`, { method: 'PUT', body: JSON.stringify({ analyteMap: next }) });
      onNotice(`${note} The analyser was not disconnected.`);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const current = () => ({ ...(link?.analyteMap ?? {}) });
  const dropKey = (map: Record<string, string>, code: string) => {
    for (const key of Object.keys(map)) if (key.toUpperCase() === code.toUpperCase()) delete map[key];
  };

  async function editCode(name: EditableName, next: string) {
    const map = current();
    dropKey(map, name.text);
    // The model still claims the old spelling, so it is taken out of use
    // rather than simply forgotten.
    if (name.key.startsWith('builtin:')) map[name.text] = name.text;
    map[next] = name.note ?? '';
    await write(map, `${name.text} is read as ${next}.`);
  }

  async function removeCode(name: EditableName) {
    const map = current();
    dropKey(map, name.text);
    if (name.key.startsWith('builtin:')) map[name.text] = name.text;
    await write(map, `${name.text} no longer means ${name.note}.`);
  }

  async function restoreCode(name: EditableName) {
    const map = current();
    dropKey(map, name.text);
    await write(map, `${name.text} means ${name.note} again.`);
  }

  async function addCodes(parameter: string, values: string[]) {
    const map = current();
    for (const code of values) { dropKey(map, code); map[code] = parameter; }
    await write(map, `${values.length} code(s) now mean ${parameter}.`);
  }

  const unnamed = codes.filter(c => c.namedBy === 'none');
  const needle = search.trim().toUpperCase();
  const shown = needle
    ? parameters.filter(row => `${row.parameter} ${row.names.map(n => n.text).join(' ')}`.toUpperCase().includes(needle))
    : parameters;

  return (
    <>
      <Panel
        title="What this analyser calls each parameter"
        subtitle="Read when a message arrives, before anything is matched to a control or a form. Press a code to change or remove it."
        actions={link ? <Field label="Find" value={search} onValue={setSearch} placeholder="HGB, Neutrophils" /> : undefined}
      >
        <div className="mw-inset mw-grid">
          <ChooseLink links={links} value={linkId} onValue={setLinkId}
            empty="No analyser link is configured yet. Add one under Connection Setup." />
        </div>

        {!link ? <Note>Choose an analyser to see what its codes mean.</Note> : (
          <>
            {profile
              ? <Note tone="ok">{profile.label} — {Object.keys(profile.analytes).length} codes understood before anything is added here.</Note>
              : <Note tone="warn">No model is chosen for this link, so nothing is understood by default. Every code it sends has to be named here, or a model chosen under Connection Setup.</Note>}

            {!shown.length ? (
              <Note>{needle ? 'No parameter matches.' : 'Nothing is mapped on this analyser yet. Add a parameter below.'}</Note>
            ) : (
              <table className="data-table mw-table">
                <thead><tr><th style={{ width: '22%' }}>Parameter</th><th>The analyser sends</th></tr></thead>
                <tbody>
                  {shown.map(row => (
                    <tr key={row.parameter}>
                      <td>
                        <span className="pm-param">
                          <strong>{row.parameter}</strong>
                          <small>{(() => {
                            const live = row.names.filter(n => n.tone !== 'out').length;
                            return live === 1 ? '1 code' : `${live} codes`;
                          })()}</small>
                        </span>
                      </td>
                      <td>
                        <NameList
                          canEdit={canConfigure}
                          busy={busy === 'analyte'}
                          names={row.names}
                          onEdit={editCode}
                          onRemove={removeCode}
                          onRestore={restoreCode}
                          onAdd={values => addCodes(row.parameter, values)}
                          addLabel="Add codes"
                          addHint="Separate several with commas. Each code the analyser sends will be read as this parameter."
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {canConfigure && (
              <div className="mw-inset mw-grid">
                <Field label="A parameter this analyser sends that is not listed" value={newParameter}
                  onValue={setNewParameter} placeholder="Reticulocyte haemoglobin" wide />
                <div className="mw-actions">
                  <button className="btn ghost" disabled={!newParameter.trim()}
                    onClick={() => {
                      const parameter = newParameter.trim();
                      setNewParameter('');
                      setSearch(parameter);
                      void addCodes(parameter, [parameter]);
                    }}>
                    <Plus size={13} /> Add the parameter
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>

      {link && (
        <Panel
          title="Codes this analyser has actually sent"
          subtitle="From the transmissions on the record, so nobody has to guess what the machine uses."
          actions={unnamed.length ? <span className="mw-chip t-warn">{unnamed.length} unnamed</span> : <span className="mw-chip t-ok">all named</span>}
        >
          {!codes.length ? <Note>Nothing has arrived on this link yet.</Note> : (
            <table className="data-table mw-table">
              <thead><tr><th>Code</th><th>Read as</th><th>Unit</th><th>Seen</th><th>Named by</th></tr></thead>
              <tbody>
                {codes.map(entry => (
                  <tr key={entry.code}>
                    <td><strong>{entry.code}</strong></td>
                    <td>{entry.analyte}</td>
                    <td className="mw-sub">{entry.unit ?? '—'}</td>
                    <td>{entry.count}<span className="mw-sub">{when(entry.lastSeen)}</span></td>
                    <td>
                      {entry.namedBy === 'link' && <span className="mw-chip t-info">this analyser</span>}
                      {entry.namedBy === 'profile' && <span className="mw-chip t-ok">the model</span>}
                      {entry.namedBy === 'none' && <span className="mw-chip t-warn">nothing — its own spelling</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {unnamed.length > 0 && (
            <Note tone="warn">
              Find the parameter each of these belongs to in the table above and add the code to it, or add the
              parameter if this analyser measures something the model does not list.
            </Note>
          )}
        </Panel>
      )}
    </>
  );
}

/* ============================================================================
   SECHLIMS → LIS
   ----------------------------------------------------------------------------
   The other half of the journey: what the receiving system calls the parameter
   SECHLIMS is handing it. Two destinations, two vocabularies — the names the
   Result Filler types into a result-entry form, and the measure ids the LHIMS
   middleware files a result under.
   ========================================================================= */
function ToLis({ links, lhimsMaps, destinations, canConfigure, busy, setBusy, onError, onNotice, reload }:
PartProps & { lhimsMaps: LhimsMap[]; destinations: Destination[] }) {
  return (
    <>
      <ParameterNames canConfigure={canConfigure} busy={busy} setBusy={setBusy} onError={onError} onNotice={onNotice} />
      <ToLhims links={links} lhimsMaps={lhimsMaps} canConfigure={canConfigure}
        busy={busy} setBusy={setBusy} onError={onError} onNotice={onNotice} reload={reload} />
      <ToDestination destinations={destinations} canConfigure={canConfigure}
        busy={busy} setBusy={setBusy} onError={onError} onNotice={onNotice} />
    </>
  );
}

/* ---------------------------------------------------------------- aliases */
type AliasRow = {
  id: number; canonical: string; alias: string; adapter_id: number | null;
  adapter_name: string | null; note: string | null; created_by_name: string | null; created_at: string;
};
type DictionaryEntry = { canonical: string; discipline: string; aliases: string[] };
type FillerAdapter = { id: number; name: string };

/**
 * The names a result-entry form uses.
 *
 * Taught once here and understood everywhere, with no reinstall on any bench.
 * The Result Filler reads exactly this register; moving the screen into this
 * tab changed where it is edited and nothing about what it does.
 */
function ParameterNames({ canConfigure, busy, setBusy, onError, onNotice }: {
  canConfigure: boolean; busy: string | null; setBusy: (v: string | null) => void;
  onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  const { can } = usePermissions();
  const mayRead = can('analyser_middleware.result_filler', 'view');
  const mayEdit = canConfigure && can('analyser_middleware.result_filler', 'edit');

  const [rows, setRows] = useState<AliasRow[]>([]);
  const [withdrawn, setWithdrawn] = useState<AliasRow[]>([]);
  const [dictionary, setDictionary] = useState<DictionaryEntry[]>([]);
  const [adapters, setAdapters] = useState<FillerAdapter[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ canonical: '', alias: '', adapterId: '', note: '', newParameter: '' });

  const load = useCallback(async () => {
    if (!mayRead) return;
    try {
      const data = await apiRead<{ rows: AliasRow[]; withdrawn: AliasRow[]; dictionary: DictionaryEntry[] }>(
        '/result-filler/aliases', { rows: [], withdrawn: [], dictionary: [] });
      setRows(data.rows);
      setWithdrawn(data.withdrawn ?? []);
      setDictionary(data.dictionary);
      const forms = await apiRead<{ adapters: FillerAdapter[] }>('/result-filler/adapters', { adapters: [] });
      setAdapters(forms.adapters ?? []);
    } catch (e) { onError(errorText(e)); }
  }, [mayRead, onError]);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    // A parameter typed in wins over one chosen from the list, so a laboratory
    // can name something the built-in list has never heard of.
    const canonical = form.newParameter.trim() || form.canonical.trim();
    if (!canonical || !form.alias.trim()) { onError('Give the parameter and the other name for it.'); return; }
    setBusy('alias'); onError(null);
    try {
      await api('/result-filler/aliases', {
        method: 'POST',
        body: JSON.stringify({ canonical, alias: form.alias, adapterId: form.adapterId, note: form.note }),
      });
      onNotice(`“${form.alias}” now means ${canonical}.`);
      setForm({ canonical: '', alias: '', adapterId: '', note: '', newParameter: '' });
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  /**
   * Change the characters of a name.
   *
   * A name this laboratory added is simply renamed. A BUILT-IN name cannot be
   * rewritten in place — it lives in the release, not in this database — so it
   * is withdrawn and the new spelling added, which is also the honest record
   * of what happened: one word stopped being used and another started.
   */
  async function editName(name: EditableName, next: string) {
    const [kind, id] = name.key.split(':');
    setBusy(`n${name.key}`); onError(null);
    try {
      if (kind === 'added') {
        await api(`/result-filler/aliases/${id}`, { method: 'PUT', body: JSON.stringify({ alias: next }) });
      } else {
        await api('/result-filler/aliases', {
          method: 'POST', body: JSON.stringify({ canonical: name.note, alias: name.text, withdraw: true }),
        });
        await api('/result-filler/aliases', {
          method: 'POST', body: JSON.stringify({ canonical: name.note, alias: next }),
        });
      }
      onNotice(`Now read as ${next}.`);
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  /** Take a name out of use: delete one this laboratory added, withdraw a built-in. */
  async function removeName(name: EditableName) {
    const [kind, id] = name.key.split(':');
    setBusy(`n${name.key}`); onError(null);
    try {
      if (kind === 'added') await api(`/result-filler/aliases/${id}`, { method: 'DELETE' });
      else {
        await api('/result-filler/aliases', {
          method: 'POST', body: JSON.stringify({ canonical: name.note, alias: name.text, withdraw: true }),
        });
      }
      onNotice(`\u201c${name.text}\u201d is no longer read as ${name.note}.`);
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  /**
   * Several names at once, which is how a laboratory actually thinks of them.
   *
   * Each is offered on its own so one that is already spoken for does not take
   * the others down with it, and the summary says exactly which went in.
   */
  async function addNames(canonical: string, values: string[]) {
    setBusy(`n${canonical}`); onError(null);
    const added: string[] = [];
    const refused: string[] = [];
    for (const alias of values) {
      try {
        await api('/result-filler/aliases', { method: 'POST', body: JSON.stringify({ canonical, alias }) });
        added.push(alias);
      } catch { refused.push(alias); }
    }
    await load();
    setBusy(null);
    if (added.length && !refused.length) onNotice(`${added.length} name(s) added to ${canonical}.`);
    else if (added.length) onNotice(`${added.join(', ')} added. ${refused.join(', ')} already mean something else.`);
    else onError(`${refused.join(', ')} already mean something else, so nothing was added.`);
  }

  async function restore(row: AliasRow) {
    setBusy(`w${row.id}`); onError(null);
    try {
      await api(`/result-filler/aliases/${row.id}`, { method: 'DELETE' });
      onNotice(`“${row.alias}” is understood as ${row.canonical} again.`);
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

  if (!mayRead) {
    return (
      <Panel title="Names a result-entry form uses" subtitle="What the Result Filler types into a form on the laboratory's behalf.">
        <Note>These names are part of the Result Filler, which you do not have rights to see.</Note>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title="Names this laboratory has taught it"
        subtitle="What a result-entry form may call a parameter. Added here, understood everywhere — no reinstall on any bench."
        actions={<span className="mw-chip t-info">{rows.length} added</span>}
      >
        {mayEdit && (
          <div className="mw-inset mw-grid">
            <Pick label="Parameter" value={form.canonical} onValue={v => setForm(f => ({ ...f, canonical: v, newParameter: '' }))}
              options={dictionary.map(entry => ({ key: entry.canonical, label: `${entry.canonical} (${entry.discipline})` }))}
              blank="Choose the parameter" />
            <Field label="…or one not on the list" value={form.newParameter}
              onValue={v => setForm(f => ({ ...f, newParameter: v, canonical: v ? '' : f.canonical }))}
              placeholder="Procalcitonin" />
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
        subtitle="What an analyser may send, and what a form may ask for. Press × on a name this laboratory uses for something else, and nothing reads it as that parameter any more."
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
                    <NameList
                      canEdit={mayEdit}
                      busy={Boolean(busy && busy.startsWith('n'))}
                      names={[
                        ...entry.aliases.map(alias => {
                          const out = withdrawn.find(w => w.alias.toUpperCase() === alias.toUpperCase());
                          return out
                            ? { key: `out:${out.id}`, text: alias, tone: 'out' as const, note: entry.canonical }
                            : { key: `builtin:${alias}`, text: alias, tone: 'builtin' as const, note: entry.canonical };
                        }),
                        ...rows.filter(row => row.canonical === entry.canonical)
                          .map(row => ({ key: `added:${row.id}`, text: row.alias, tone: 'added' as const, note: entry.canonical })),
                      ]}
                      onEdit={editName}
                      onRemove={removeName}
                      onRestore={name => restore(withdrawn.find(w => `out:${w.id}` === name.key)!)}
                      onAdd={values => addNames(entry.canonical, values)}
                    />
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

/* ------------------------------------------------------------------ LHIMS */
/**
 * What LHIMS files each parameter under.
 *
 * LHIMS stores a result against a numeric measure id, not a name, so a result
 * carried onward has to be translated into those ids. Getting one wrong files
 * a haemoglobin under whatever parameter happened to hold that number, which
 * is why a code with no id is never sent rather than guessed at.
 */
function ToLhims({ links, lhimsMaps, canConfigure, busy, setBusy, onError, onNotice, reload }: PartProps & { lhimsMaps: LhimsMap[] }) {
  const [linkId, setLinkId] = useState('');
  const [mapKey, setMapKey] = useState('');
  const [rows, setRows] = useState<Array<{ name: string; measureId: string }>>([]);
  const [draft, setDraft] = useState({ name: '', measureId: '' });

  const carriers = useMemo(() => links.filter(l => l.carriesOnward), [links]);
  const link = links.find(l => String(l.id) === linkId) ?? null;
  const chosen = lhimsMaps.find(m => m.key === (mapKey || link?.lhimsMapKey)) ?? null;

  useEffect(() => {
    setMapKey(link?.lhimsMapKey ?? '');
    setRows(Object.entries(link?.measureMap ?? {}).map(([name, measureId]) => ({ name, measureId: String(measureId) })));
    setDraft({ name: '', measureId: '' });
  }, [link]);

  async function save(nextRows: Array<{ name: string; measureId: string }>, nextKey: string) {
    if (!link) return;
    setBusy('measures'); onError(null);
    try {
      const measureMap: Record<string, number> = {};
      for (const row of nextRows) {
        const id = Number(row.measureId);
        if (row.name.trim() && Number.isFinite(id) && id > 0) measureMap[row.name.trim()] = id;
      }
      await api(`/middleware/parameter-mappings/${link.id}`, {
        method: 'PUT', body: JSON.stringify({ measureMap, lhimsMapKey: nextKey || null }),
      });
      onNotice('Saved. The analyser was not disconnected.');
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <Panel
      title="What LHIMS calls each parameter"
      subtitle="Only for a link that carries a copy of its results onward; LHIMS files a result against a numeric measure id, not a name."
    >
      {!carriers.length ? (
        <Note>
          No link carries results onward to LHIMS at the moment, so nothing here is in use. A link does so only
          under the role “SECHLIMS receives, and passes a copy on to LHIMS”.
        </Note>
      ) : (
        <div className="mw-inset mw-grid">
          <ChooseLink links={carriers} value={linkId} onValue={setLinkId} empty="" />
          {link && (
            <Pick label="Which LHIMS map" value={mapKey} onValue={v => { setMapKey(v); void save(rows, v); }}
              options={lhimsMaps.map(m => ({ key: m.key, label: `${m.label} (${m.vendor})` }))}
              blank="None — set every id by hand" disabled={!canConfigure} />
          )}
        </div>
      )}

      {link && (
        <>
          {chosen
            ? <Note tone="ok">{chosen.label} — {chosen.measures.length} parameter(s) already carry an id.</Note>
            : <Note tone="warn">No map is chosen, so every parameter needs an id set by hand below. A parameter with no id is not sent to LHIMS.</Note>}

          {!rows.length ? <Note>No id has been set by hand on this link.</Note> : (
            <table className="data-table mw-table">
              <thead><tr><th>SECHLIMS calls it</th><th /><th>LHIMS measure id</th><th /></tr></thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.name}-${index}`}>
                    <td><strong>{row.name}</strong></td>
                    <td className="mw-sub"><ArrowRight size={12} /></td>
                    <td>
                      {canConfigure
                        ? <Field label="" value={row.measureId} type="number"
                            onValue={v => setRows(r => r.map((x, i) => (i === index ? { ...x, measureId: v } : x)))} />
                        : row.measureId}
                    </td>
                    <td className="mw-row-actions">
                      {canConfigure && (
                        <button className="btn ghost" onClick={() => { const next = rows.filter((_, i) => i !== index); setRows(next); void save(next, mapKey); }}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canConfigure && (
            <div className="mw-inset mw-grid">
              <Field label="SECHLIMS calls it" value={draft.name} onValue={v => setDraft(d => ({ ...d, name: v }))} placeholder="Haemoglobin" />
              <Field label="LHIMS measure id" value={draft.measureId} type="number" onValue={v => setDraft(d => ({ ...d, measureId: v }))} placeholder="3" />
              <div className="mw-actions">
                <button className="btn ghost" disabled={busy === 'measures' || !draft.name.trim() || !draft.measureId.trim()}
                  onClick={() => { const next = [...rows, draft]; setRows(next); setDraft({ name: '', measureId: '' }); void save(next, mapKey); }}>
                  <Plus size={13} /> Add
                </button>
                <button className="btn" disabled={busy === 'measures'} onClick={() => void save(rows, mapKey)}>
                  {busy === 'measures' ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save the ids
                </button>
              </div>
            </div>
          )}

          {chosen && (
            <table className="data-table mw-table">
              <thead><tr><th>In the map</th><th>LHIMS measure id</th><th>Overridden here</th></tr></thead>
              <tbody>
                {chosen.measures.map(measure => {
                  const override = rows.find(r => r.name.toUpperCase() === (measure.label ?? measure.code).toUpperCase());
                  return (
                    <tr key={measure.code}>
                      <td><strong>{measure.label ?? measure.code}</strong></td>
                      <td>{measure.measureId}</td>
                      <td>{override ? <span className="mw-chip t-info">{override.measureId}</span> : <span className="mw-sub">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------- a LIS destination */
type DestinationMapping = {
  id: number; destination_id: number; source_code: string;
  target_code: string | null; target_name: string | null; target_unit: string | null;
  factor: number | null; offset_value: number | null; decimals: number | null;
  value_map: Record<string, string>; is_required: number; is_active: number; note: string | null;
};

const BLANK_MAPPING = {
  sourceCode: '', targetCode: '', targetName: '', targetUnit: '',
  factor: '', decimals: '', required: false,
};

/**
 * What a destination calls each parameter, and in what unit.
 *
 * The third vocabulary, and the one with teeth: a destination that stores
 * results against its own test codes gets nothing for a code nobody has
 * mapped. SECHLIMS withholds it and names it on the delivery rather than
 * sending the analyser's word and hoping — a haemoglobin filed under whatever
 * test happened to answer to "HGB" at the far end is not a near miss.
 *
 * It lived beside the routing rules, where it was a register one could add a
 * blank row to and delete a row from. It is editable here: the code, the name,
 * the unit, a linear factor and the decimals, which is what a destination with
 * its own vocabulary actually needs.
 */
function ToDestination({ destinations, canConfigure, busy, setBusy, onError, onNotice }: {
  destinations: Destination[]; canConfigure: boolean; busy: string | null;
  setBusy: (v: string | null) => void; onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  // A protected destination is one SECHLIMS deliberately stays away from.
  const usable = useMemo(() => destinations.filter(d => !d.is_protected), [destinations]);
  const [forId, setForId] = useState('');
  const [rows, setRows] = useState<DestinationMapping[]>([]);
  const [observed, setObserved] = useState<Array<{ code: string; count: number }>>([]);
  const [draft, setDraft] = useState(BLANK_MAPPING);

  const load = useCallback(async (destinationId: string) => {
    if (!destinationId) { setRows([]); setObserved([]); return; }
    try {
      const data = await apiRead<{ mappings: DestinationMapping[]; observedCodes: Array<{ code: string; count: number }> }>(
        `/middleware/destinations/${destinationId}/mappings`, { mappings: [], observedCodes: [] });
      setRows(data.mappings);
      setObserved(data.observedCodes);
    } catch (e) { onError(errorText(e)); }
  }, [onError]);

  useEffect(() => { void load(forId); }, [forId, load]);

  async function save(row: typeof BLANK_MAPPING) {
    if (!forId || !row.sourceCode.trim()) { onError('Name the code the analyser sends.'); return; }
    setBusy(`d${row.sourceCode}`); onError(null);
    try {
      await api(`/middleware/destinations/${forId}/mappings`, {
        method: 'POST',
        body: JSON.stringify({ rows: [{
          sourceCode: row.sourceCode.trim(),
          targetCode: row.targetCode.trim() || null,
          targetName: row.targetName.trim() || null,
          targetUnit: row.targetUnit.trim() || null,
          factor: row.factor.trim() ? Number(row.factor) : null,
          decimals: row.decimals.trim() ? Number(row.decimals) : null,
          required: row.required,
          active: true,
        }] }),
      });
      onNotice(`${row.sourceCode} mapped.`);
      setDraft(BLANK_MAPPING);
      await load(forId);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function remove(id: number) {
    setBusy(`d${id}`); onError(null);
    try { await api(`/middleware/mappings/${id}`, { method: 'DELETE', body: JSON.stringify({}) }); await load(forId); }
    catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const unmapped = observed.filter(entry => !rows.some(r => r.source_code.toUpperCase() === entry.code.toUpperCase()));

  return (
    <Panel
      title="What a connected system calls each parameter"
      subtitle="Per destination. A code with no mapping is withheld and named on the delivery, never filed under a guess."
    >
      {!usable.length ? (
        <Note>No destination is configured. One is added under Destinations before its codes can be mapped.</Note>
      ) : (
        <div className="mw-inset mw-grid">
          <Pick label="Destination" value={forId} onValue={setForId} wide
            options={usable.map(d => ({ key: String(d.id), label: `${d.name}${d.state ? ` · ${d.state}` : ''}` }))}
            blank="Choose a destination" />
        </div>
      )}

      {!forId ? null : (
        <>
          {!rows.length ? (
            <Note>
              No mapping is defined, so every result goes with the analyser&rsquo;s own test code and unit. That is
              correct for a system that already speaks the analyser&rsquo;s codes.
            </Note>
          ) : (
            <table className="data-table mw-table">
              <thead>
                <tr><th>The analyser sends</th><th>It is filed as</th><th>Name</th><th>Unit</th><th>Factor</th><th>Decimals</th><th>Required</th><th /></tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className={row.target_code ? undefined : 'mw-row-warn'}>
                    <td className="mono"><strong>{row.source_code}</strong></td>
                    <td className="mono">{row.target_code ?? <span className="t-warn">not set — withheld</span>}</td>
                    <td>{row.target_name ?? '—'}</td>
                    <td>{row.target_unit ?? '—'}</td>
                    <td className="num">{row.factor ?? '—'}</td>
                    <td className="num">{row.decimals ?? '—'}</td>
                    <td>{row.is_required ? 'Yes' : '—'}</td>
                    <td className="mw-row-actions">
                      {canConfigure && (
                        <>
                          <button className="btn ghost" onClick={() => setDraft({
                            sourceCode: row.source_code,
                            targetCode: row.target_code ?? '',
                            targetName: row.target_name ?? '',
                            targetUnit: row.target_unit ?? '',
                            factor: row.factor == null ? '' : String(row.factor),
                            decimals: row.decimals == null ? '' : String(row.decimals),
                            required: row.is_required === 1,
                          })}>Edit</button>
                          <button className="btn ghost" disabled={busy === `d${row.id}`} onClick={() => void remove(row.id)}>
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canConfigure && (
            <div className="mw-inset mw-grid">
              <Field label="The analyser sends" value={draft.sourceCode} onValue={v => setDraft(d => ({ ...d, sourceCode: v }))} placeholder="HGB" />
              <Field label="File it as" value={draft.targetCode} onValue={v => setDraft(d => ({ ...d, targetCode: v }))} placeholder="the destination's own code" />
              <Field label="Name there" value={draft.targetName} onValue={v => setDraft(d => ({ ...d, targetName: v }))} />
              <Field label="Unit there" value={draft.targetUnit} onValue={v => setDraft(d => ({ ...d, targetUnit: v }))} placeholder="g/dL" />
              <Field label="Multiply by" value={draft.factor} type="number" onValue={v => setDraft(d => ({ ...d, factor: v }))} hint="For a destination that stores a different unit." />
              <Field label="Decimals" value={draft.decimals} type="number" onValue={v => setDraft(d => ({ ...d, decimals: v }))} />
              <Switch label="The destination must receive this one"
                checked={draft.required} onChange={v => setDraft(d => ({ ...d, required: v }))}
                hint="Its absence fails the delivery loudly, rather than quietly." />
              <div className="mw-actions">
                <button className="btn" disabled={busy?.startsWith('d') || !draft.sourceCode.trim()} onClick={() => void save(draft)}>
                  {busy?.startsWith('d') ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save this mapping
                </button>
                {draft.sourceCode && (
                  <button className="btn ghost" onClick={() => setDraft(BLANK_MAPPING)}>Clear</button>
                )}
              </div>
            </div>
          )}

          {unmapped.length > 0 && (
            <>
              <h5 className="mw-side-head">Codes that have arrived and are not mapped</h5>
              <Note tone="warn">
                These go with the analyser&rsquo;s own code, and the receiving system decides what to do with each.
                Press one to start mapping it.
              </Note>
              <ul className="mw-chips">
                {unmapped.slice(0, 40).map(entry => (
                  <li key={entry.code}>
                    <button type="button" className="mw-chip t-info" disabled={!canConfigure}
                      onClick={() => setDraft({ ...BLANK_MAPPING, sourceCode: entry.code })}>
                      {entry.code} <span className="mw-sub">{entry.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
