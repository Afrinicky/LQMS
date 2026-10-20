import { useState } from 'react';
import { ArrowRight, Check, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { api, errorText } from '../../services/api';
import {
  Facts, Field, Note, Panel, Pick, Switch, StateChip,
  endpointOf, when, type SectionProps,
} from './shared';

/**
 * Connection Setup.
 *
 * Five steps, in the order the work is actually done, and the first one is the
 * one that protects the laboratory: write down what the EXISTING transmission
 * looks like before touching anything. Capturing that baseline reads the link's
 * configuration and changes nothing about it, and it is what tells the engine
 * which endpoints it must refuse from then on.
 *
 * After that, a destination is configured, tested in isolation with an
 * obviously synthetic message, approved by a person and only then activated.
 * Each of those is a separate step because each is a separate decision: a
 * destination that has never exchanged a message cannot be approved, and one
 * that has not been approved cannot be activated.
 */
const STEPS = [
  'Baseline the existing transmission',
  'Configure the destination',
  'Test it in isolation',
  'Approve it',
  'Activate it',
];

export default function MiddlewareSetup({
  reference, destinations, links, canConfigure, canApprove, canDiagnose, reload, onError, onNotice, onOpen,
}: SectionProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [test, setTest] = useState<{ ok: boolean; detail: string; payload: string; ackCode: string | null; measuredMs: number } | null>(null);
  const [form, setForm] = useState({
    name: '', platform: 'lis', transport: 'hl7_mllp', payloadFormat: 'hl7v2',
    host: '', port: '', baseUrl: '', username: '', secret: '', authScheme: 'none',
    exportDir: '', receivingApplication: '', receivingFacility: '', sendingFacility: '',
    ackPolicy: 'protocol_ack', ackTimeoutMs: '20000', retryMax: '6', useTls: false, notes: '',
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm(f => ({ ...f, [key]: value }));

  const draft = destinations.find(d => d.id === draftId) ?? null;
  const protectedLink = links.find(l => l.engine_protected) ?? null;
  const isNetwork = form.transport === 'hl7_mllp' || form.transport === 'astm_tcp';
  const isHttp = form.transport === 'http_json' || form.transport === 'http_lhims';

  async function captureBaseline() {
    setBusy(true); onError(null);
    try {
      const outcome = await api<{ note: string }>('/middleware/baselines/capture', {
        method: 'POST',
        body: JSON.stringify({ linkId: protectedLink?.id ?? null }),
      });
      onNotice(outcome.note);
      await reload();
      setStep(1);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function saveDestination() {
    setBusy(true); onError(null);
    try {
      const created = await api<{ id: number; name: string }>('/middleware/destinations', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, platform: form.platform, transport: form.transport,
          payloadFormat: form.payloadFormat,
          host: form.host || null, port: form.port || null, baseUrl: form.baseUrl || null,
          username: form.username || null, secret: form.secret || null, authScheme: form.authScheme,
          exportDir: form.exportDir || null,
          receivingApplication: form.receivingApplication || null,
          receivingFacility: form.receivingFacility || null,
          sendingFacility: form.sendingFacility || null,
          ackPolicy: form.ackPolicy, ackTimeoutMs: Number(form.ackTimeoutMs) || 20_000,
          retryMax: Number(form.retryMax) || 6, useTls: form.useTls, notes: form.notes || null,
        }),
      });
      setDraftId(created.id);
      onNotice(`${created.name} is configured. It carries nothing until it is tested, approved and activated.`);
      await reload();
      setStep(2);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function runTest() {
    if (!draftId) return;
    setBusy(true); onError(null);
    try {
      const outcome = await api<any>(`/middleware/destinations/${draftId}/test`, { method: 'POST' });
      setTest(outcome);
      await reload();
      if (outcome.ok) setStep(3);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function approve() {
    if (!draftId) return;
    setBusy(true); onError(null);
    try {
      await api(`/middleware/destinations/${draftId}/approve`, { method: 'POST', body: JSON.stringify({}) });
      onNotice('Approved. Activate it when the laboratory is ready for it to carry results.');
      await reload();
      setStep(4);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function activate() {
    if (!draftId) return;
    setBusy(true); onError(null);
    try {
      await api(`/middleware/destinations/${draftId}/activate`, { method: 'POST', body: JSON.stringify({}) });
      onNotice('Active. Add a routing rule to send messages to it.');
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <ol className="mw-steps">
        {STEPS.map((label, index) => (
          <li key={label} className={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
            <span className="mw-step-no">{index < step ? <Check size={11} /> : index + 1}</span>
            <button type="button" onClick={() => setStep(index)}>{label}</button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Panel
          title="Baseline the existing transmission"
          subtitle="Read it, record it, change nothing. This is what tells the engine which endpoints to refuse."
          tone="lock"
        >
          {protectedLink ? (
            <>
              <Facts items={[
                { label: 'Link', value: protectedLink.name },
                { label: 'Role', value: 'LHIMS owns this link' },
                { label: 'Protocol', value: String(protectedLink.protocol).toUpperCase() },
                { label: 'Endpoint', value: protectedLink.listen_port ? `${protectedLink.listen_host || 'every interface'}:${protectedLink.listen_port}` : '—' },
                { label: 'State', value: protectedLink.state },
                { label: 'Last heard', value: when(protectedLink.last_message_at) },
              ]} />
              <Note>
                <ShieldCheck size={12} /> Capturing a baseline runs SELECT statements only. The link is not started,
                stopped, reconfigured or probed, and its port is added to the list the engine refuses from then on.
              </Note>
            </>
          ) : (
            <Note tone="warn">
              <Lock size={12} /> No link is recorded as one LHIMS owns, so there is no production transmission to
              baseline. Record the existing analyser link first, marked as LHIMS-owned, so the engine knows to stay
              away from its port.
            </Note>
          )}
          <div className="mw-actions">
            <button type="button" className="btn" disabled={busy || !canConfigure || !protectedLink} onClick={() => void captureBaseline()}>
              {busy ? <Loader2 size={13} className="pd-spin" /> : <Lock size={13} />} Capture the baseline
            </button>
            <button type="button" className="secondary" onClick={() => setStep(1)}>Skip to configuration</button>
          </div>
        </Panel>
      )}

      {step === 1 && (
        <Panel
          title="Configure the destination"
          subtitle="One connection profile per information system. Nothing is transmitted on these settings until they are approved."
        >
          {!canConfigure ? (
            <Note>You do not hold the right to configure a destination.</Note>
          ) : (
            <>
              <div className="mw-grid">
                <Field label="Name" value={form.name} onValue={v => set('name', v)} wide
                  placeholder="Hospital information system — results interface" />
                <Pick label="Platform" value={form.platform} onValue={v => set('platform', v)}
                  options={reference?.platforms ?? []} />
                <Pick label="Transport" value={form.transport} onValue={v => {
                  setForm(f => ({
                    ...f,
                    transport: v,
                    payloadFormat: v === 'astm_tcp' ? 'astm' : v === 'http_lhims' ? 'json' : v === 'hl7_mllp' ? 'hl7v2' : f.payloadFormat,
                    ackPolicy: v === 'file_export' ? 'file_written' : v === 'http_json' || v === 'http_lhims' ? 'http_2xx' : v === 'internal' ? 'none' : 'protocol_ack',
                  }));
                }} options={reference?.transports ?? []}
                  hint={reference?.transports.find(t => t.key === form.transport)?.hint} />
                <Pick label="Message format" value={form.payloadFormat} onValue={v => set('payloadFormat', v)}
                  options={reference?.payloadFormats ?? []} />

                {isNetwork && <Field label="Host" value={form.host} onValue={v => set('host', v)} placeholder="10.0.0.40" />}
                {isNetwork && <Field label="Port" value={form.port} onValue={v => set('port', v)} type="number"
                  hint="A port belonging to a protected connection is refused." />}
                {isHttp && <Field label="Endpoint URL" value={form.baseUrl} onValue={v => set('baseUrl', v)} wide
                  placeholder="https://his.example/api/results" />}
                {form.transport === 'file_export' && <Field label="Export folder" value={form.exportDir} onValue={v => set('exportDir', v)} wide
                  placeholder="\\\\server\\results-in" hint="Files are written to a temporary name and renamed, so a reader never sees a part-written message." />}

                {form.transport !== 'internal' && form.transport !== 'file_export' && (
                  <>
                    <Pick label="Authentication" value={form.authScheme} onValue={v => set('authScheme', v)}
                      options={[
                        { key: 'none', label: 'None' },
                        { key: 'basic', label: 'Basic' },
                        { key: 'bearer', label: 'Bearer token' },
                        { key: 'query', label: 'In the query string' },
                      ]} />
                    {form.authScheme !== 'none' && <Field label="Username" value={form.username} onValue={v => set('username', v)} />}
                    {form.authScheme !== 'none' && <Field label="Credential" value={form.secret} onValue={v => set('secret', v)} type="password"
                      hint="Encrypted at rest and never returned by the API." />}
                  </>
                )}

                <Pick label="Acknowledgement" value={form.ackPolicy} onValue={v => set('ackPolicy', v)}
                  options={reference?.ackPolicies ?? []} wide
                  hint={form.ackPolicy === 'none'
                    ? 'With no acknowledgement a delivery can be shown as transmitted, never as accepted.'
                    : 'A delivery is marked delivered only once the receiving system says so.'} />
                <Field label="Acknowledgement timeout (ms)" value={form.ackTimeoutMs} onValue={v => set('ackTimeoutMs', v)} type="number" />
                <Field label="Attempts before dead-letter" value={form.retryMax} onValue={v => set('retryMax', v)} type="number" />

                {form.payloadFormat === 'hl7v2' && (
                  <>
                    <Field label="Sending facility" value={form.sendingFacility} onValue={v => set('sendingFacility', v)} />
                    <Field label="Receiving application" value={form.receivingApplication} onValue={v => set('receivingApplication', v)} />
                    <Field label="Receiving facility" value={form.receivingFacility} onValue={v => set('receivingFacility', v)} />
                  </>
                )}
                {isNetwork && <Switch label="Use TLS" checked={form.useTls} onChange={v => set('useTls', v)}
                  hint="The certificate is verified. A host with its own authority installs it on this machine." />}
                <Field label="Notes" value={form.notes} onValue={v => set('notes', v)} wide area
                  placeholder="Who administers the receiving system, and anything their interface specification requires." />
              </div>
              <div className="mw-actions">
                <button type="button" className="btn" disabled={busy || !form.name} onClick={() => void saveDestination()}>
                  {busy ? <Loader2 size={13} className="pd-spin" /> : <ArrowRight size={13} />} Save and test
                </button>
              </div>
            </>
          )}
        </Panel>
      )}

      {step === 2 && (
        <Panel
          title="Test it in isolation"
          subtitle="One synthetic control message over the real transport. No patient result is used, and nothing is recorded as a delivery."
        >
          {!draft ? (
            <Note>Configure a destination first, or choose one on the Destinations tab and test it there.</Note>
          ) : (
            <>
              <Facts items={[
                { label: 'Destination', value: draft.name },
                { label: 'Endpoint', value: endpointOf(draft) },
                { label: 'Format', value: draft.payload_format },
                { label: 'Acknowledgement', value: draft.ack_policy },
                { label: 'State', value: <StateChip state={draft.state} /> },
                { label: 'Last tested', value: when(draft.last_test_at) },
              ]} />
              <div className="mw-actions">
                <button type="button" className="btn" disabled={busy || !canDiagnose} onClick={() => void runTest()}>
                  {busy ? <Loader2 size={13} className="pd-spin" /> : <ArrowRight size={13} />} Send a test message
                </button>
              </div>
              {test && (
                <>
                  <Note tone={test.ok ? 'ok' : 'crit'}>
                    {test.detail} {test.ackCode ? `Acknowledgement: ${test.ackCode}.` : ''} {test.measuredMs} ms.
                  </Note>
                  <details className="mw-reveal">
                    <summary>What was sent</summary>
                    <pre className="mw-pre">{test.payload}</pre>
                  </details>
                </>
              )}
            </>
          )}
        </Panel>
      )}

      {step === 3 && (
        <Panel title="Approve it" subtitle="One person signs that the interface is correct. A destination that has never exchanged a message cannot be approved.">
          {!draft ? <Note>Nothing is waiting for approval here.</Note> : (
            <>
              <Facts items={[
                { label: 'Destination', value: draft.name },
                { label: 'Last test', value: draft.last_test_outcome ?? 'not tested' },
                { label: 'Approved by', value: draft.approved_by_name ?? 'not yet approved' },
              ]} />
              <div className="mw-actions">
                <button type="button" className="btn" disabled={busy || !canApprove || !draft.last_test_at} onClick={() => void approve()}>
                  {busy ? <Loader2 size={13} className="pd-spin" /> : <Check size={13} />} Approve
                </button>
              </div>
              {!canApprove && <Note>Approval is held by the posts accountable for the laboratory's data.</Note>}
            </>
          )}
        </Panel>
      )}

      {step === 4 && (
        <Panel title="Activate it" subtitle="The moment it starts carrying results. Separate from approval on purpose.">
          {!draft ? <Note>Nothing is waiting for activation here.</Note> : (
            <>
              <Facts items={[
                { label: 'Destination', value: draft.name },
                { label: 'State', value: <StateChip state={draft.state} /> },
                { label: 'Approved', value: draft.approved_at ? `${when(draft.approved_at)} by ${draft.approved_by_name ?? 'unknown'}` : 'not approved' },
                { label: 'Routing rules', value: draft.routes },
              ]} />
              <div className="mw-actions">
                <button type="button" className="btn" disabled={busy || !canApprove || !draft.approved_by} onClick={() => void activate()}>
                  {busy ? <Loader2 size={13} className="pd-spin" /> : <Check size={13} />} Activate
                </button>
                <button type="button" className="secondary" onClick={() => onOpen?.('Routing & Mappings')}>
                  Add a routing rule
                </button>
              </div>
              <Note>
                Rolling back is verified: every change is recorded with the settings before and after it, and a
                rollback restores the settings and stands the destination down to awaiting approval again, so nothing
                carries results on restored settings nobody has signed for.
              </Note>
            </>
          )}
        </Panel>
      )}

      <Panel title="Steps that need a person or the vendor" subtitle="What this module cannot do for you.">
        <ul className="mw-bullets">
          <li>Setting the analyser's own host address, port and protocol in its service menu.</li>
          <li>Enabling the vendor's host-communication or file-export option, where it is licensed separately.</li>
          <li>Proprietary drivers, serial cabling and any physical configuration at the instrument.</li>
          <li>The target test codes a receiving system uses — these come from its own interface specification.</li>
          <li>Firewall rules between this host and the receiving system.</li>
        </ul>
      </Panel>
    </>
  );
}
