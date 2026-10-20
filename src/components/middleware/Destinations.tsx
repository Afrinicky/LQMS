import { useState } from 'react';
import { Check, Loader2, Lock, Pause, Play, Plug, Trash2 } from 'lucide-react';
import { api, errorText } from '../../services/api';
import {
  Facts, Field, Note, Panel, Pick, StateChip, Switch,
  endpointOf, when, type Destination, type SectionProps,
} from './shared';

/**
 * LIS/HIS Destination Management.
 *
 * Every destination independent of every other: its own connection profile,
 * mappings, transformation, acknowledgement policy, retry schedule and delivery
 * state. One failing does not touch another, which is only true because a
 * delivery is a row per destination rather than a status on the message.
 *
 * LHIMS is one platform among several here and is not a default or a
 * requirement. A facility configures the systems it actually runs.
 */
export default function MiddlewareDestinations({
  reference, destinations, canConfigure, canApprove, canDiagnose, reload, onError, onNotice,
}: SectionProps) {
  const [editing, setEditing] = useState<Destination | null>(null);
  const [busy, setBusy] = useState<number | 'save' | null>(null);
  const [test, setTest] = useState<{ id: number; ok: boolean; detail: string; payload: string } | null>(null);

  async function act(destination: Destination, action: 'test' | 'approve' | 'activate' | 'deactivate' | 'retire') {
    setBusy(destination.id); onError(null);
    try {
      if (action === 'test') {
        const outcome = await api<any>(`/middleware/destinations/${destination.id}/test`, { method: 'POST' });
        setTest({ id: destination.id, ok: outcome.ok, detail: outcome.detail, payload: outcome.payload });
        onNotice(outcome.note);
      } else if (action === 'retire') {
        const outcome = await api<{ note: string }>(`/middleware/destinations/${destination.id}`, {
          method: 'DELETE', body: JSON.stringify({ reason: 'Retired from the destinations screen.' }),
        });
        onNotice(outcome.note);
      } else {
        const body = action === 'deactivate' ? { reason: 'Stood down from the destinations screen.' } : {};
        await api(`/middleware/destinations/${destination.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
        onNotice(action === 'approve' ? 'Approved. Activate it when the laboratory is ready.'
          : action === 'activate' ? 'Active. It now carries whatever the routing rules send it.'
          : 'Stood down. Queued deliveries are kept.');
      }
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function save(form: Record<string, unknown>) {
    if (!editing) return;
    setBusy('save'); onError(null);
    try {
      const outcome = await api<{ standDown?: boolean }>(`/middleware/destinations/${editing.id}`, {
        method: 'PUT', body: JSON.stringify(form),
      });
      onNotice(outcome.standDown
        ? 'Saved. Settings changed, so the destination stands down to awaiting approval — nothing carries results on settings nobody has signed for.'
        : 'Saved.');
      setEditing(null);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <>
      <Panel
        title="Destinations"
        subtitle="SECHLIMS, LHIMS and any other compatible information system, each configured independently."
      >
        {!destinations.length ? (
          <Note>
            No destination is configured. Use Connection Setup to add one — it is tested in isolation, approved and
            then activated before it carries anything.
          </Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Destination</th><th>Transport</th><th>Endpoint</th><th>Acknowledgement</th>
                <th>State</th><th className="num">Delivered</th><th className="num">Waiting</th>
                <th className="num">Dead</th><th />
              </tr>
            </thead>
            <tbody>
              {destinations.map(destination => {
                const working = busy === destination.id;
                return (
                  <tr key={destination.id} className={destination.is_protected ? 'mw-row-lock' : undefined}>
                    <td>
                      <strong>{destination.is_protected ? <><Lock size={11} /> {destination.name}</> : destination.name}</strong>
                      <span className="mw-sub">{destination.dest_code} · {destination.platform}</span>
                    </td>
                    <td>{destination.transport}<span className="mw-sub">{destination.payload_format}</span></td>
                    <td className="mono">{endpointOf(destination)}</td>
                    <td>
                      {destination.ack_policy}
                      {!destination.confirmable && <span className="mw-sub t-warn">acceptance not confirmed</span>}
                    </td>
                    <td>
                      <StateChip state={destination.state} protectedConnection={Boolean(destination.is_protected)} />
                      {destination.state_detail && <span className="mw-sub">{destination.state_detail}</span>}
                    </td>
                    <td className="num">{destination.delivered}</td>
                    <td className="num">{destination.pending}</td>
                    <td className={`num${destination.dead_letters ? ' t-crit' : ''}`}>{destination.dead_letters}</td>
                    <td className="mw-row-actions">
                      {destination.is_protected ? (
                        <span className="mw-sub">Read-only</span>
                      ) : (
                        <>
                          {canDiagnose && (
                            <button type="button" className="pq-link" disabled={working} onClick={() => void act(destination, 'test')}>
                              {working ? <Loader2 size={12} className="pd-spin" /> : <Plug size={12} />} Test
                            </button>
                          )}
                          {canApprove && destination.state !== 'active' && destination.last_test_at && !destination.approved_by && (
                            <button type="button" className="pq-link" disabled={working} onClick={() => void act(destination, 'approve')}>
                              <Check size={12} /> Approve
                            </button>
                          )}
                          {canApprove && destination.approved_by && destination.state !== 'active' && (
                            <button type="button" className="pq-link" disabled={working} onClick={() => void act(destination, 'activate')}>
                              <Play size={12} /> Activate
                            </button>
                          )}
                          {canApprove && destination.state === 'active' && (
                            <button type="button" className="pq-link" disabled={working} onClick={() => void act(destination, 'deactivate')}>
                              <Pause size={12} /> Stand down
                            </button>
                          )}
                          {canConfigure && <button type="button" className="pq-link" onClick={() => setEditing(destination)}>Settings</button>}
                          {canConfigure && (
                            <button type="button" className="pq-link" disabled={working} onClick={() => void act(destination, 'retire')}>
                              <Trash2 size={12} /> Retire
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {test && (
          <>
            <Note tone={test.ok ? 'ok' : 'crit'}>{test.detail}</Note>
            <details className="mw-reveal">
              <summary>What was sent</summary>
              <pre className="mw-pre">{test.payload}</pre>
            </details>
          </>
        )}
      </Panel>

      {destinations.some(d => d.state === 'awaiting_approval') && (
        <Panel title="Awaiting approval" subtitle="These carry nothing until approved and activated." tone="warn">
          <ul className="mw-list">
            {destinations.filter(d => d.state === 'awaiting_approval').map(destination => (
              <li key={destination.id}>
                <span className="mw-list-main">
                  <strong>{destination.name}</strong>
                  <span className="mw-sub">
                    {destination.last_test_outcome ?? 'not tested'}
                    {destination.approved_by_name ? ` · approved by ${destination.approved_by_name} ${when(destination.approved_at)}` : ' · not yet approved'}
                  </span>
                </span>
                <StateChip state={destination.state} />
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {editing && (
        <EditDestination
          destination={editing}
          reference={reference}
          busy={busy === 'save'}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  );
}

/* ----------------------------------------------------------------------------
   One destination's settings
   ------------------------------------------------------------------------- */
function EditDestination({ destination, reference, busy, onClose, onSave }: {
  destination: Destination;
  reference: SectionProps['reference'];
  busy: boolean;
  onClose: () => void;
  onSave: (form: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: destination.name,
    platform: destination.platform,
    transport: destination.transport,
    payloadFormat: destination.payload_format,
    host: destination.host ?? '',
    port: destination.port == null ? '' : String(destination.port),
    baseUrl: destination.base_url ?? '',
    exportDir: destination.export_dir ?? '',
    fileTemplate: destination.file_template ?? '',
    username: destination.username ?? '',
    secret: '',
    authScheme: destination.auth_scheme,
    sendingFacility: destination.sending_facility ?? '',
    receivingApplication: destination.receiving_application ?? '',
    receivingFacility: destination.receiving_facility ?? '',
    ackPolicy: destination.ack_policy,
    ackTimeoutMs: String(destination.ack_timeout_ms),
    retryMax: String(destination.retry_max),
    retryBaseMs: String(destination.retry_base_ms),
    autoDeliver: Boolean(destination.auto_deliver),
    useTls: Boolean(destination.use_tls),
    notes: destination.notes ?? '',
    reason: '',
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(f => ({ ...f, [key]: value }));
  const isNetwork = form.transport === 'hl7_mllp' || form.transport === 'astm_tcp';
  const isHttp = form.transport === 'http_json' || form.transport === 'http_lhims';

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide" onClick={e => e.stopPropagation()}>
        <header>
          <h4>{destination.name}</h4>
          <button type="button" className="pq-link" onClick={onClose}>Close</button>
        </header>
        <div className="mw-grid">
          <Field label="Name" value={form.name} onValue={v => set('name', v)} wide />
          <Pick label="Platform" value={form.platform} onValue={v => set('platform', v)} options={reference?.platforms ?? []} />
          <Pick label="Transport" value={form.transport} onValue={v => set('transport', v)} options={reference?.transports ?? []} />
          <Pick label="Message format" value={form.payloadFormat} onValue={v => set('payloadFormat', v)} options={reference?.payloadFormats ?? []} />
          {isNetwork && <Field label="Host" value={form.host} onValue={v => set('host', v)} />}
          {isNetwork && <Field label="Port" value={form.port} onValue={v => set('port', v)} type="number" />}
          {isHttp && <Field label="Endpoint URL" value={form.baseUrl} onValue={v => set('baseUrl', v)} wide />}
          {form.transport === 'file_export' && <Field label="Export folder" value={form.exportDir} onValue={v => set('exportDir', v)} wide />}
          {form.transport === 'file_export' && <Field label="File name pattern" value={form.fileTemplate} onValue={v => set('fileTemplate', v)}
            placeholder="{sample}-{stamp}.{ext}" />}
          <Pick label="Authentication" value={form.authScheme} onValue={v => set('authScheme', v)} options={[
            { key: 'none', label: 'None' }, { key: 'basic', label: 'Basic' },
            { key: 'bearer', label: 'Bearer token' }, { key: 'query', label: 'In the query string' },
          ]} />
          {form.authScheme !== 'none' && <Field label="Username" value={form.username} onValue={v => set('username', v)} />}
          {form.authScheme !== 'none' && (
            <Field label="Credential" value={form.secret} onValue={v => set('secret', v)} type="password"
              hint={destination.secret_set
                ? 'A credential is stored, encrypted. Leave this blank to keep it.'
                : 'No credential is stored for this destination.'} />
          )}
          <Pick label="Acknowledgement" value={form.ackPolicy} onValue={v => set('ackPolicy', v)} options={reference?.ackPolicies ?? []} wide />
          <Field label="Acknowledgement timeout (ms)" value={form.ackTimeoutMs} onValue={v => set('ackTimeoutMs', v)} type="number" />
          <Field label="Attempts before dead-letter" value={form.retryMax} onValue={v => set('retryMax', v)} type="number" />
          <Field label="First retry delay (ms)" value={form.retryBaseMs} onValue={v => set('retryBaseMs', v)} type="number"
            hint="Doubles each attempt, with jitter, to a thirty-minute ceiling." />
          {form.payloadFormat === 'hl7v2' && <Field label="Sending facility" value={form.sendingFacility} onValue={v => set('sendingFacility', v)} />}
          {form.payloadFormat === 'hl7v2' && <Field label="Receiving application" value={form.receivingApplication} onValue={v => set('receivingApplication', v)} />}
          {form.payloadFormat === 'hl7v2' && <Field label="Receiving facility" value={form.receivingFacility} onValue={v => set('receivingFacility', v)} />}
          {isNetwork && <Switch label="Use TLS" checked={form.useTls} onChange={v => set('useTls', v)} />}
          <Switch label="Deliver automatically" checked={form.autoDeliver} onChange={v => set('autoDeliver', v)}
            hint="Off holds every delivery in the queue for a person to send." />
          <Field label="Notes" value={form.notes} onValue={v => set('notes', v)} wide area />
          <Field label="Why this change" value={form.reason} onValue={v => set('reason', v)} wide
            hint="Kept with the configuration version, so the change can be read and undone." />
        </div>
        <Facts items={[
          { label: 'Approved', value: destination.approved_at ? `${when(destination.approved_at)} by ${destination.approved_by_name ?? 'unknown'}` : 'not approved' },
          { label: 'Last test', value: destination.last_test_outcome ?? 'never tested' },
          { label: 'Last accepted delivery', value: when(destination.last_delivery_at) },
        ]} />
        <Note>
          Changing the transport, endpoint, authentication or acknowledgement policy stands an active destination down
          to awaiting approval. Nothing carries clinical results on settings nobody has signed for.
        </Note>
        <div className="pr-btns">
          <button type="button" className="btn" disabled={busy} onClick={() => void onSave(form)}>
            {busy ? <Loader2 size={13} className="pd-spin" /> : null} Save
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
