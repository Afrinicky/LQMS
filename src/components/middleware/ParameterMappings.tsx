import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { Field, Note, Panel, Pick, when, type SectionProps } from './shared';

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

export default function MiddlewareParameterMappings({ canConfigure, onError, onNotice }: SectionProps) {
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
      {tab === 'SECHLIMS → LIS' && <ToLis lhimsMaps={data.lhimsMaps} {...shared} />}
    </>
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
  const [rows, setRows] = useState<Array<{ code: string; name: string }>>([]);
  const [draft, setDraft] = useState({ code: '', name: '' });
  const [codes, setCodes] = useState<SeenCode[]>([]);
  const [search, setSearch] = useState('');

  const link = links.find(l => String(l.id) === linkId) ?? null;
  const profile = profiles.find(p => p.key === link?.profileKey) ?? null;

  useEffect(() => {
    setRows(Object.entries(link?.analyteMap ?? {}).map(([code, name]) => ({ code, name })));
    setDraft({ code: '', name: '' });
    setCodes([]);
    if (!link) return;
    void (async () => {
      try {
        const seen = await apiRead<{ codes: SeenCode[] }>(`/middleware/parameter-mappings/${link.id}/codes`, { codes: [] });
        setCodes(seen.codes);
      } catch (e) { onError(errorText(e)); }
    })();
  }, [link, onError]);

  async function save(next: Array<{ code: string; name: string }>) {
    if (!link) return;
    setBusy('analyte'); onError(null);
    try {
      const analyteMap: Record<string, string> = {};
      for (const row of next) if (row.code.trim() && row.name.trim()) analyteMap[row.code.trim()] = row.name.trim();
      await api(`/middleware/parameter-mappings/${link.id}`, { method: 'PUT', body: JSON.stringify({ analyteMap }) });
      onNotice('Saved. The analyser was not disconnected.');
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const unnamed = codes.filter(c => c.namedBy === 'none');
  const known = profile ? Object.entries(profile.analytes) : [];
  const needle = search.trim().toUpperCase();
  const shownKnown = needle ? known.filter(([code, name]) => `${code} ${name}`.toUpperCase().includes(needle)) : known;

  return (
    <>
      <Panel
        title="What this analyser calls each parameter"
        subtitle="Read when a message arrives, before anything is matched to a control or a form."
      >
        <div className="mw-inset mw-grid">
          <ChooseLink links={links} value={linkId} onValue={setLinkId}
            empty="No analyser link is configured yet. Add one under Connection Setup." />
        </div>

        {!link ? <Note>Choose an analyser to see what its codes mean.</Note> : (
          <>
            {profile
              ? <Note tone="ok">{profile.label} — {known.length} parameter(s) already understood without anything being added here.</Note>
              : <Note tone="warn">No model is chosen for this link, so nothing is understood by default. Every code it sends has to be named below, or a model chosen under Connection Setup.</Note>}

            {!rows.length ? <Note>Nothing has needed renaming on this analyser.</Note> : (
              <table className="data-table mw-table">
                <thead><tr><th>The analyser sends</th><th /><th>SECHLIMS reads it as</th><th /></tr></thead>
                <tbody>
                  {rows.map((row, index) => (
                    <tr key={`${row.code}-${index}`}>
                      <td><strong>{row.code}</strong></td>
                      <td className="mw-sub"><ArrowRight size={12} /></td>
                      <td>
                        {canConfigure
                          ? <Field label="" value={row.name}
                              onValue={v => setRows(r => r.map((x, i) => (i === index ? { ...x, name: v } : x)))} />
                          : row.name}
                      </td>
                      <td className="mw-row-actions">
                        {canConfigure && (
                          <button className="btn ghost" title="Remove this name"
                            onClick={() => { const next = rows.filter((_, i) => i !== index); setRows(next); void save(next); }}>
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
                <Field label="The analyser sends" value={draft.code} onValue={v => setDraft(d => ({ ...d, code: v }))} placeholder="WBC-C" />
                <Field label="SECHLIMS reads it as" value={draft.name} onValue={v => setDraft(d => ({ ...d, name: v }))} placeholder="White cell count" />
                <div className="mw-actions">
                  <button className="btn ghost" disabled={busy === 'analyte' || !draft.code.trim() || !draft.name.trim()}
                    onClick={() => { const next = [...rows, draft]; setRows(next); setDraft({ code: '', name: '' }); void save(next); }}>
                    <Plus size={13} /> Add
                  </button>
                  <button className="btn" disabled={busy === 'analyte'} onClick={() => void save(rows)}>
                    {busy === 'analyte' ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save the names
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
              <thead><tr><th>Code</th><th>Read as</th><th>Unit</th><th>Seen</th><th>Named by</th><th /></tr></thead>
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
                    <td className="mw-row-actions">
                      {canConfigure && entry.namedBy !== 'link' && (
                        <button className="btn ghost" onClick={() => setDraft({ code: entry.code, name: entry.analyte })}>
                          Name it
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {link && profile && (
        <Panel
          title="What this model already understands"
          subtitle="Built in, and used wherever this link does not say otherwise."
          actions={<Field label="Find" value={search} onValue={setSearch} placeholder="HGB, NEUT" />}
        >
          {!shownKnown.length ? <Note>No code matches.</Note> : (
            <table className="data-table mw-table">
              <thead><tr><th>The analyser sends</th><th>Read as</th><th>Overridden here</th></tr></thead>
              <tbody>
                {shownKnown.map(([code, name]) => {
                  const override = rows.find(r => r.code.toUpperCase() === code.toUpperCase());
                  return (
                    <tr key={code}>
                      <td><strong>{code}</strong></td>
                      <td>{name}</td>
                      <td>{override ? <span className="mw-chip t-info">{override.name}</span> : <span className="mw-sub">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
function ToLis({ links, lhimsMaps, canConfigure, busy, setBusy, onError, onNotice, reload }: PartProps & { lhimsMaps: LhimsMap[] }) {
  return (
    <>
      <ParameterNames canConfigure={canConfigure} busy={busy} setBusy={setBusy} onError={onError} onNotice={onNotice} />
      <ToLhims links={links} lhimsMaps={lhimsMaps} canConfigure={canConfigure}
        busy={busy} setBusy={setBusy} onError={onError} onNotice={onNotice} reload={reload} />
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
  const [dictionary, setDictionary] = useState<DictionaryEntry[]>([]);
  const [adapters, setAdapters] = useState<FillerAdapter[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ canonical: '', alias: '', adapterId: '', note: '' });

  const load = useCallback(async () => {
    if (!mayRead) return;
    try {
      const data = await apiRead<{ rows: AliasRow[]; dictionary: DictionaryEntry[] }>('/result-filler/aliases', { rows: [], dictionary: [] });
      setRows(data.rows);
      setDictionary(data.dictionary);
      const forms = await apiRead<{ adapters: FillerAdapter[] }>('/result-filler/adapters', { adapters: [] });
      setAdapters(forms.adapters ?? []);
    } catch (e) { onError(errorText(e)); }
  }, [mayRead, onError]);

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
