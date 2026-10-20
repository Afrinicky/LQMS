import { useCallback, useEffect, useState } from 'react';
import { Loader2, PlayCircle, Search, Shuffle } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { TRACE_STAGE_LABELS } from '../../../shared/constants/middleware';
import {
  DeliveryChip, Facts, Field, MessageChip, Note, Panel, Pick, StatusMark, Switch,
  when, type Delivery, type MessageRow, type SectionProps,
} from './shared';

/**
 * Message and Protocol Explorer.
 *
 * The end-to-end record. One message, every stage it passed through, the raw
 * transmission exactly as the analyser sent it, the payload each destination
 * was given, and what each of them said back.
 *
 * The simulator at the bottom plays a transmission through the engine so a
 * routing rule, a mapping and a destination can be proved without waiting for
 * an analyser. It sanitises what is pasted in by default, so a captured
 * production message can be used for testing without its identifiers.
 */
type Trace = {
  message: MessageRow & {
    normalised: { sampleId: string | null; results: Array<{ code: string; analyte: string; value: string; unit: string | null; flag: string | null }> } | null;
    validation: Array<{ severity: string; field: string; detail: string }>;
    instrument_message_id: number | null;
  };
  deliveries: Delivery[];
  trace: Array<{
    id: number; at: string; stage: string; outcome: string; detail: string;
    duration_ms: number | null; destination_name: string | null; actor_name: string | null;
  }>;
  source: { raw_message: string; peer: string | null; received_at: string } | null;
};

export default function MiddlewareExplorer({ reference, links, canDiagnose, canQueue, reload, onError, onNotice }: SectionProps) {
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState({ search: '', status: '', kind: '', linkId: '' });
  const [open, setOpen] = useState<Trace | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sample, setSample] = useState('');
  const [sanitise, setSanitise] = useState(true);
  const [simulateLink, setSimulateLink] = useState('');

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '100' });
    if (filter.search) query.set('search', filter.search);
    if (filter.status) query.set('status', filter.status);
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.linkId) query.set('linkId', filter.linkId);
    const data = await apiRead<{ total: number; rows: MessageRow[] }>(`/middleware/messages?${query}`, { total: 0, rows: [] });
    setRows(data.rows);
    setTotal(data.total);
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  async function openMessage(id: number) {
    setBusy(`m${id}`); onError(null);
    try { setOpen(await api<Trace>(`/middleware/messages/${id}`)); }
    catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function reroute(id: number) {
    setBusy('reroute'); onError(null);
    try {
      const outcome = await api<{ note: string }>(`/middleware/messages/${id}/reroute`, { method: 'POST', body: JSON.stringify({}) });
      onNotice(outcome.note);
      await openMessage(id);
      await load();
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function simulate() {
    if (!sample.trim()) { onError('Paste a transmission to play through the engine.'); return; }
    setBusy('simulate'); onError(null);
    try {
      const outcome = await api<{ note: string; protocol: string }>('/middleware/simulate', {
        method: 'POST',
        body: JSON.stringify({ message: sample, sanitise, linkId: simulateLink || null }),
      });
      onNotice(`${outcome.note} Read as ${outcome.protocol.toUpperCase()}.`);
      await load();
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <>
      <Panel title="Messages" subtitle={`${total} on the record.`}>
        <div className="mw-grid">
          <Field label="Sample, lot or message id" value={filter.search} onValue={v => setFilter(f => ({ ...f, search: v }))} />
          <Pick label="Status" value={filter.status} onValue={v => setFilter(f => ({ ...f, status: v }))}
            options={Object.entries(reference?.messageStatuses ?? {}).map(([key, label]) => ({ key, label: String(label) }))}
            blank="Any status" />
          <Pick label="Kind" value={filter.kind} onValue={v => setFilter(f => ({ ...f, kind: v }))}
            options={[{ key: 'patient', label: 'Patient' }, { key: 'control', label: 'Control' }, { key: 'unknown', label: 'Unreadable' }]}
            blank="Any kind" />
          <Pick label="Analyser" value={filter.linkId} onValue={v => setFilter(f => ({ ...f, linkId: v }))}
            options={links.map(l => ({ key: String(l.id), label: l.name }))} blank="Any analyser" />
        </div>

        {!rows.length ? <Note>No message matches.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Received</th><th>Analyser</th><th>Sample</th><th>Kind</th>
                <th className="num">Results</th><th className="num">Deliveries</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(message => (
                <tr key={message.id} className={open?.message?.id === message.id ? 'is-selected' : undefined}>
                  <td>{when(message.received_at)}</td>
                  <td>{message.link_name ?? '—'}</td>
                  <td className="mono">{message.sample_id ?? '—'}</td>
                  <td>{message.kind}{message.source !== 'bridge' && <span className="mw-sub">{message.source}</span>}</td>
                  <td className="num">{message.result_count}</td>
                  <td className="num">
                    {message.delivered}/{message.deliveries}
                    {message.dead_letters ? <span className="t-crit"> +{message.dead_letters}</span> : null}
                  </td>
                  <td><MessageChip status={message.status} /></td>
                  <td>
                    <button type="button" className="pq-link" disabled={busy === `m${message.id}`} onClick={() => void openMessage(message.id)}>
                      {busy === `m${message.id}` ? <Loader2 size={12} className="pd-spin" /> : <Search size={12} />} Trace
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {open?.message && (
        <Panel
          title={`Message ${open.message.sample_id ?? open.message.message_uid.slice(0, 8)}`}
          subtitle="Ingestion, parsing, validation, mapping, queuing, routing, delivery, acknowledgement and outcome."
          actions={canQueue && (
            <button type="button" className="pq-link" disabled={busy === 'reroute'} onClick={() => void reroute(open.message.id)}>
              {busy === 'reroute' ? <Loader2 size={12} className="pd-spin" /> : <Shuffle size={12} />} Re-route
            </button>
          )}
        >
          <Facts items={[
            { label: 'Message id', value: <span className="mono">{open.message.message_uid}</span> },
            { label: 'Received', value: when(open.message.received_at) },
            { label: 'Analyser', value: open.message.link_name ?? '—' },
            { label: 'Protocol', value: open.message.protocol ? String(open.message.protocol).toUpperCase() : '—' },
            { label: 'Kind', value: open.message.kind },
            { label: 'Run at', value: when(open.message.instrument_run_at) },
            { label: 'Results', value: open.message.result_count },
            { label: 'Status', value: <MessageChip status={open.message.status} /> },
          ]} />

          {open.message.validation.length > 0 && (
            <>
              <h5 className="mw-side-head">Validation</h5>
              <ul className="mw-list is-compact">
                {open.message.validation.map((finding, i) => (
                  <li key={i}>
                    <span className="mw-list-main">
                      <strong>{finding.field}</strong>
                      <span className="mw-sub">{finding.detail}</span>
                    </span>
                    <StatusMark status={finding.severity === 'error' ? 'fail' : 'warn'} />
                  </li>
                ))}
              </ul>
            </>
          )}

          <h5 className="mw-side-head">Trace</h5>
          <table className="data-table mw-table">
            <thead><tr><th>At</th><th>Stage</th><th>Destination</th><th>Detail</th><th className="num">Took</th><th>Outcome</th></tr></thead>
            <tbody>
              {open.trace.map(step => (
                <tr key={step.id} className={`mw-row-${step.outcome === 'error' ? 'fail' : step.outcome === 'warn' ? 'warn' : 'ok'}`}>
                  <td>{String(step.at).slice(11, 19)}</td>
                  <td><strong>{TRACE_STAGE_LABELS[step.stage as keyof typeof TRACE_STAGE_LABELS] ?? step.stage}</strong></td>
                  <td>{step.destination_name ?? '—'}</td>
                  <td>{step.detail}{step.actor_name && <span className="mw-sub">by {step.actor_name}</span>}</td>
                  <td className="num">{step.duration_ms != null ? `${step.duration_ms} ms` : '—'}</td>
                  <td><StatusMark status={step.outcome === 'error' ? 'fail' : step.outcome === 'warn' ? 'warn' : step.outcome === 'info' ? 'info' : 'ok'} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <h5 className="mw-side-head">Deliveries</h5>
          {!open.deliveries.length ? <Note>No destination was queued for this message.</Note> : (
            <table className="data-table mw-table">
              <thead>
                <tr><th>Destination</th><th>State</th><th className="num">Attempt</th><th>Acknowledgement</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {open.deliveries.map(delivery => (
                  <tr key={delivery.id}>
                    <td>
                      <strong>{delivery.destination_name}</strong>
                      <span className="mw-sub">{delivery.transport} · {delivery.payload_format ?? '—'}</span>
                    </td>
                    <td><DeliveryChip state={delivery.state} /></td>
                    <td className="num">{delivery.attempt}/{delivery.max_attempts}</td>
                    <td>
                      {delivery.ack_code ?? '—'}
                      {!delivery.confirmable && <span className="mw-sub t-warn">no acknowledgement policy</span>}
                    </td>
                    <td>
                      {delivery.error ?? delivery.ack_text ?? (delivery.state === 'delivered' ? 'Accepted.' : '—')}
                      {delivery.results_unmapped.length > 0 && (
                        <span className="mw-sub t-warn">withheld, unmapped: {delivery.results_unmapped.join(', ')}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {open.message.normalised?.results?.length ? (
            <>
              <h5 className="mw-side-head">Results, normalised</h5>
              <table className="data-table mw-table">
                <thead><tr><th>Code</th><th>Analyte</th><th>Value</th><th>Unit</th><th>Flag</th></tr></thead>
                <tbody>
                  {open.message.normalised.results.map((result, i) => (
                    <tr key={i}>
                      <td className="mono">{result.code}</td>
                      <td>{result.analyte}</td>
                      <td className="num">{result.value}</td>
                      <td>{result.unit ?? '—'}</td>
                      <td>{result.flag ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {open.source && (
            <details className="mw-reveal">
              <summary>The transmission as it arrived{open.source.peer ? ` from ${open.source.peer}` : ''}</summary>
              <pre className="mw-pre">{open.source.raw_message}</pre>
            </details>
          )}
          {open.deliveries.filter(d => d.payload).map(delivery => (
            <details className="mw-reveal" key={`p${delivery.id}`}>
              <summary>What {delivery.destination_name} was sent</summary>
              <pre className="mw-pre">{delivery.payload}</pre>
            </details>
          ))}
        </Panel>
      )}

      <Panel
        title="Play a transmission through the engine"
        subtitle="Proves a rule, a mapping and a destination without waiting for an analyser."
      >
        {!canDiagnose ? <Note>You do not hold the right to play a message through the engine.</Note> : (
          <>
            <div className="mw-grid">
              <Pick label="As if it came from" value={simulateLink} onValue={setSimulateLink}
                options={links.map(l => ({ key: String(l.id), label: l.name }))} blank="No particular analyser" />
              <Switch label="Sanitise patient fields first" checked={sanitise} onChange={setSanitise}
                hint="Keeps record structure, delimiters, framing, test codes and units; replaces names and identifiers." />
              <Field label="The transmission" value={sample} onValue={setSample} wide area
                placeholder={'H|\\^&|||Sysmex^1|||||||P|1\nP|1\nO|1|SAMPLE001||^^^ALL|R\nR|1|^^^HGB|12.4|g/dL||N\nL|1|N'} />
              <div className="mw-actions">
                <button type="button" className="btn" disabled={busy === 'simulate'} onClick={() => void simulate()}>
                  {busy === 'simulate' ? <Loader2 size={13} className="pd-spin" /> : <PlayCircle size={13} />} Play it
                </button>
              </div>
            </div>
            <Note>
              The message is ingested, validated, routed and queued exactly as a real transmission is, and appears in
              the list above marked as coming from the simulator. It reaches only the destinations your routing rules
              send it to, and never a protected connection.
            </Note>
          </>
        )}
      </Panel>
    </>
  );
}
