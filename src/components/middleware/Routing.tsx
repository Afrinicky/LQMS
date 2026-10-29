import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { Field, Note, Panel, Pick, Switch, type Route, type SectionProps } from './shared';

/**
 * Routing Rules and Mappings.
 *
 * A rule narrows: every criterion left blank matches everything, and one that
 * is set must match. Rules are ordered, and every matching rule produces its
 * own delivery — so a result can reach SECHLIMS, a hospital system and a
 * research extract independently, and one of them failing has no effect on the
 * others.
 *
 * The preview uses the same matching function the engine does, so what this
 * screen predicts is what actually happens.
 */
export default function MiddlewareRouting({
  reference, links, destinations, routes, canConfigure, reload, onError, onNotice,
}: SectionProps) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: '', destinationId: '', priority: '100', sourceLinkId: '', messageKind: 'patient',
    testCodes: '', sectionId: '', facility: '', department: '', stopOnMatch: false, notes: '',
  });
  const [preview, setPreview] = useState<{ matches: any[]; note: string } | null>(null);
  const [probe, setProbe] = useState({ linkId: '', kind: 'patient', codes: '' });

  const usable = destinations.filter(d => !d.is_protected);


  async function createRule() {
    setBusy('rule'); onError(null);
    try {
      await api('/middleware/routes', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name,
          destinationId: Number(draft.destinationId),
          priority: Number(draft.priority) || 100,
          sourceLinkId: draft.sourceLinkId || null,
          messageKind: draft.messageKind,
          testCodes: draft.testCodes.trim() ? draft.testCodes.split(',').map(c => c.trim()).filter(Boolean) : [],
          sectionId: draft.sectionId || null,
          facility: draft.facility || null,
          department: draft.department || null,
          stopOnMatch: draft.stopOnMatch,
          notes: draft.notes || null,
        }),
      });
      onNotice('Rule added. Messages matching it are queued for that destination from the next transmission.');
      setAdding(false);
      setDraft({ ...draft, name: '', testCodes: '', notes: '' });
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function toggleRule(route: Route) {
    setBusy(`r${route.id}`); onError(null);
    try {
      await api(`/middleware/routes/${route.id}`, {
        method: 'PUT', body: JSON.stringify({ active: !route.is_active, reason: 'Switched from the routing screen.' }),
      });
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function removeRule(route: Route) {
    setBusy(`r${route.id}`); onError(null);
    try {
      const outcome = await api<{ note: string }>(`/middleware/routes/${route.id}`, {
        method: 'DELETE', body: JSON.stringify({ reason: 'Removed from the routing screen.' }),
      });
      onNotice(outcome.note);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function runPreview() {
    setBusy('preview'); onError(null);
    try {
      setPreview(await api('/middleware/routes/preview', {
        method: 'POST',
        body: JSON.stringify({
          linkId: probe.linkId || null,
          kind: probe.kind,
          codes: probe.codes.trim() ? probe.codes.split(',').map(c => c.trim()).filter(Boolean) : [],
        }),
      }));
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }


  return (
    <>
      <Panel
        title="Routing rules"
        subtitle="Taken in priority order. Every matching rule produces its own delivery."
        actions={canConfigure && (
          <button type="button" className="pq-link" onClick={() => setAdding(a => !a)}>
            <Plus size={12} /> {adding ? 'Cancel' : 'Add a rule'}
          </button>
        )}
      >
        {adding && (
          <div className="mw-grid mw-inset">
            <Field label="Name" value={draft.name} onValue={v => setDraft(d => ({ ...d, name: v }))} wide
              placeholder="Haematology patient results to the hospital system" />
            <Pick label="Destination" value={draft.destinationId} onValue={v => setDraft(d => ({ ...d, destinationId: v }))}
              options={usable.map(d => ({ key: String(d.id), label: `${d.name} (${d.state})` }))} blank="Choose a destination" />
            <Field label="Priority" value={draft.priority} onValue={v => setDraft(d => ({ ...d, priority: v }))} type="number"
              hint="Lower runs first." />
            <Pick label="Source analyser" value={draft.sourceLinkId} onValue={v => setDraft(d => ({ ...d, sourceLinkId: v }))}
              options={links.map(l => ({ key: String(l.id), label: l.name }))} blank="Any analyser" />
            <Pick label="Message kind" value={draft.messageKind} onValue={v => setDraft(d => ({ ...d, messageKind: v }))}
              options={reference?.messageKinds ?? []} />
            <Field label="Test codes" value={draft.testCodes} onValue={v => setDraft(d => ({ ...d, testCodes: v }))} wide
              placeholder="HGB, WBC, PLT" hint="Blank means every test. A message matches when it carries any of these." />
            <Field label="Facility" value={draft.facility} onValue={v => setDraft(d => ({ ...d, facility: v }))} />
            <Field label="Department" value={draft.department} onValue={v => setDraft(d => ({ ...d, department: v }))} />
            <Switch label="Stop at this rule" checked={draft.stopOnMatch} onChange={v => setDraft(d => ({ ...d, stopOnMatch: v }))}
              hint="For a destination meant to take a class of message exclusively." />
            <Field label="Notes" value={draft.notes} onValue={v => setDraft(d => ({ ...d, notes: v }))} wide area />
            <div className="mw-actions">
              <button type="button" className="btn" disabled={busy === 'rule' || !draft.name || !draft.destinationId} onClick={() => void createRule()}>
                {busy === 'rule' ? <Loader2 size={13} className="pd-spin" /> : <Save size={13} />} Add the rule
              </button>
            </div>
          </div>
        )}

        {!routes.length ? (
          <Note tone="warn">
            No routing rule exists, so every message is held in SECHLIMS and transmitted nowhere.
          </Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th className="num">#</th><th>Rule</th><th>Matches</th><th>Destination</th>
                <th className="num">Deliveries</th><th>State</th><th />
              </tr>
            </thead>
            <tbody>
              {routes.map(route => (
                <tr key={route.id} className={route.is_active ? undefined : 'mw-row-off'}>
                  <td className="num">{route.priority}</td>
                  <td>
                    <strong>{route.name}</strong>
                    <span className="mw-sub">{route.route_code}</span>
                  </td>
                  <td>
                    <span className="mw-sub">
                      {route.source_link_name ?? 'any analyser'} · {route.message_kind}
                      {route.test_codes.length ? ` · ${route.test_codes.join(', ')}` : ' · every test'}
                      {route.section_name ? ` · ${route.section_name}` : ''}
                      {route.facility ? ` · ${route.facility}` : ''}
                      {route.stop_on_match ? ' · stops here' : ''}
                    </span>
                  </td>
                  <td>
                    {route.destination_name}
                    <span className={`mw-sub${route.destination_state === 'active' ? '' : ' t-warn'}`}>{route.destination_state}</span>
                  </td>
                  <td className="num">{route.deliveries}</td>
                  <td><span className={`mw-chip t-${route.is_active ? 'ok' : 'idle'}`}>{route.is_active ? 'Active' : 'Off'}</span></td>
                  <td className="mw-row-actions">
                    {canConfigure && (
                      <>
                        <button type="button" className="pq-link" disabled={busy === `r${route.id}`} onClick={() => void toggleRule(route)}>
                          {route.is_active ? 'Switch off' : 'Switch on'}
                        </button>
                        <button type="button" className="pq-link" disabled={busy === `r${route.id}`} onClick={() => void removeRule(route)}>
                          <Trash2 size={12} /> Remove
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Try a message against the rules" subtitle="The same matching the engine uses, so this agrees with what happens.">
        <div className="mw-grid">
          <Pick label="Source analyser" value={probe.linkId} onValue={v => setProbe(p => ({ ...p, linkId: v }))}
            options={links.map(l => ({ key: String(l.id), label: l.name }))} blank="Any analyser" />
          <Pick label="Message kind" value={probe.kind} onValue={v => setProbe(p => ({ ...p, kind: v }))}
            options={(reference?.messageKinds ?? []).filter(k => k.key !== 'any')} />
          <Field label="Test codes it carries" value={probe.codes} onValue={v => setProbe(p => ({ ...p, codes: v }))} wide
            placeholder="HGB, WBC" />
          <div className="mw-actions">
            <button type="button" className="btn" disabled={busy === 'preview'} onClick={() => void runPreview()}>
              {busy === 'preview' ? <Loader2 size={13} className="pd-spin" /> : <ArrowRight size={13} />} Preview
            </button>
          </div>
        </div>
        {preview && (
          <>
            <Note tone={preview.matches.some((m: any) => m.wouldQueue) ? 'ok' : 'warn'}>{preview.note}</Note>
            {preview.matches.length > 0 && (
              <table className="data-table mw-table">
                <thead><tr><th>Rule</th><th>Destination</th><th>Outcome</th></tr></thead>
                <tbody>
                  {preview.matches.map((match: any) => (
                    <tr key={match.routeId}>
                      <td>{match.name}</td>
                      <td>{match.destination}</td>
                      <td>
                        <span className={`mw-chip t-${match.wouldQueue ? 'ok' : 'warn'}`}>
                          {match.wouldQueue ? 'Queued' : 'Not queued'}
                        </span>
                        <span className="mw-sub">{match.reason}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Panel>

      <Panel
        title="What a destination calls each parameter"
        subtitle="Moved, so every parameter mapping is configured in one place."
      >
        <Note>
          A destination&rsquo;s own codes, names, units and conversions are under <strong>Parameter
          Mappings &rarr; SECHLIMS &rarr; LIS</strong>, beside the other two vocabularies a result passes
          through on its way out. A code with no mapping is still withheld and named on the delivery, never
          filed under a guess.
        </Note>
      </Panel>
    </>
  );
}
