import { useCallback, useEffect, useState } from 'react';
import { Ban, Loader2, RotateCcw, Send, Waves } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { deliveryIsReplayable } from '../../../shared/constants/middleware';
import {
  DeliveryChip, Facts, Note, Panel, ago, when, type Delivery, type SectionProps,
} from './shared';

/**
 * Pending Queues and Failed Deliveries.
 *
 * The queue is in the database, not in the process, so this screen is the real
 * state of the world: a host that was switched off mid-delivery comes back with
 * the same rows, and an in-flight delivery that did not survive the restart is
 * put back rather than lost.
 *
 * A dead letter is not a lost result. It is a delivery that stopped, with the
 * reason the destination gave, and a replay attempts the SAME delivery again
 * under its original idempotency key — so the far end can recognise the repeat
 * rather than file a second result.
 */
export default function MiddlewareQueues({ canQueue, reload, onError, onNotice }: SectionProps) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [summary, setSummary] = useState<Array<{ state: string; n: number }>>([]);
  const [byDestination, setByDestination] = useState<Array<{ id: number; name: string; destination_state: string; pending: number; dead_letters: number; delivered: number }>>([]);
  const [view, setView] = useState<'pending' | 'dead' | 'all'>('pending');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const state = view === 'pending' ? 'queued,retrying,in_flight'
      : view === 'dead' ? 'dead_letter,cancelled' : '';
    const query = new URLSearchParams({ limit: '200' });
    if (state) query.set('state', state);
    const data = await apiRead<{ rows: Delivery[]; summary: any[]; byDestination: any[] }>(
      `/middleware/deliveries?${query}`, { rows: [], summary: [], byDestination: [] });
    setRows(data.rows);
    setSummary(data.summary);
    setByDestination(data.byDestination);
  }, [view]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function act(delivery: Delivery, action: 'replay' | 'send-now' | 'cancel') {
    if (action === 'cancel') {
      const reason = window.prompt('Why is this delivery being cancelled? It is a clinical result that will not be sent.');
      if (!reason?.trim()) return;
      setBusy(`d${delivery.id}`); onError(null);
      try {
        const outcome = await api<{ note: string }>(`/middleware/deliveries/${delivery.id}/cancel`, {
          method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
        });
        onNotice(outcome.note);
      } catch (e) { onError(errorText(e)); }
      finally { setBusy(null); await load(); await reload(); }
      return;
    }
    setBusy(`d${delivery.id}`); onError(null);
    try {
      const outcome = await api<{ note: string }>(`/middleware/deliveries/${delivery.id}/${action}`, {
        method: 'POST', body: JSON.stringify({ reason: 'From the queue screen.' }),
      });
      onNotice(outcome.note);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); await load(); await reload(); }
  }

  async function drain() {
    setBusy('drain'); onError(null);
    try {
      const outcome = await api<{ note: string }>('/middleware/queue/drain', { method: 'POST', body: JSON.stringify({}) });
      onNotice(outcome.note);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); await load(); await reload(); }
  }

  async function recover() {
    setBusy('recover'); onError(null);
    try {
      const outcome = await api<{ note: string }>('/middleware/queue/recover', { method: 'POST', body: JSON.stringify({}) });
      onNotice(outcome.note);
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); await load(); await reload(); }
  }

  const count = (state: string) => Number(summary.find(s => s.state === state)?.n ?? 0);

  return (
    <>
      <Panel
        title="Queue"
        subtitle="Persistent and restart-safe. The queue lives in the database, not in the process."
        actions={canQueue && (
          <>
            <button type="button" className="pq-link" disabled={busy === 'drain'} onClick={() => void drain()}>
              {busy === 'drain' ? <Loader2 size={12} className="pd-spin" /> : <Waves size={12} />} Run a sweep
            </button>
            <button type="button" className="pq-link" disabled={busy === 'recover'} onClick={() => void recover()}>
              <RotateCcw size={12} /> Reclaim stuck deliveries
            </button>
          </>
        )}
      >
        <Facts items={[
          { label: 'Queued', value: count('queued') },
          { label: 'Retrying', value: count('retrying') },
          { label: 'In flight', value: count('in_flight') },
          { label: 'Delivered', value: count('delivered') },
          { label: 'Dead-lettered', value: count('dead_letter') },
          { label: 'Cancelled', value: count('cancelled') },
        ]} />
        {count('dead_letter') > 0 && (
          <Note tone="crit">
            {count('dead_letter')} delivery(ies) have stopped. Each carries the reason the destination gave. Fix the
            cause before replaying — replaying into a destination that is still refusing only grows the queue.
          </Note>
        )}
      </Panel>

      <Panel title="By destination">
        {!byDestination.length ? <Note>No destination is configured.</Note> : (
          <table className="data-table mw-table">
            <thead><tr><th>Destination</th><th>State</th><th className="num">Waiting</th><th className="num">Dead</th><th className="num">Delivered</th></tr></thead>
            <tbody>
              {byDestination.map(entry => (
                <tr key={entry.id}>
                  <td><strong>{entry.name}</strong></td>
                  <td>{entry.destination_state}</td>
                  <td className={`num${Number(entry.pending) > 50 ? ' t-warn' : ''}`}>{entry.pending ?? 0}</td>
                  <td className={`num${Number(entry.dead_letters) ? ' t-crit' : ''}`}>{entry.dead_letters ?? 0}</td>
                  <td className="num">{entry.delivered ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Deliveries"
        subtitle="One row per message per destination. Each has its own attempts, acknowledgement and outcome."
        actions={
          <div className="tabs is-inline">
            {(['pending', 'dead', 'all'] as const).map(name => (
              <button key={name} type="button" className={view === name ? 'active' : ''} onClick={() => setView(name)}>
                {name === 'pending' ? 'Waiting' : name === 'dead' ? 'Dead letters' : 'All'}
              </button>
            ))}
          </div>
        }
      >
        {!rows.length ? (
          <Note>{view === 'dead' ? 'Nothing has been dead-lettered.' : 'Nothing is waiting.'}</Note>
        ) : (
          <table className="data-table mw-table">
            <thead>
              <tr>
                <th>Sample</th><th>Destination</th><th>State</th><th className="num">Attempt</th>
                <th>Next</th><th>Reason</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map(delivery => (
                <tr key={delivery.id} className={delivery.state === 'dead_letter' ? 'mw-row-fail' : undefined}>
                  <td>
                    <strong className="mono">{delivery.sample_id ?? '—'}</strong>
                    <span className="mw-sub">
                      {delivery.link_name ?? 'unknown analyser'} · {delivery.kind} · {when(delivery.message_received_at)}
                    </span>
                  </td>
                  <td>
                    {delivery.destination_name}
                    <span className="mw-sub">{delivery.transport}</span>
                  </td>
                  <td>
                    <DeliveryChip state={delivery.state} />
                    {delivery.replay_count > 0 && (
                      <span className="mw-sub">
                        replayed {delivery.replay_count}× {delivery.replayed_by_name ? `by ${delivery.replayed_by_name}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="num">{delivery.attempt}/{delivery.max_attempts}</td>
                  <td>
                    {delivery.state === 'retrying' || delivery.state === 'queued'
                      ? ago(delivery.next_attempt_at)
                      : delivery.delivered_at ? when(delivery.delivered_at) : '—'}
                  </td>
                  <td className="mw-sub">
                    {delivery.dead_letter_reason ?? delivery.error ?? (delivery.state === 'delivered' ? 'Accepted.' : '—')}
                    {delivery.results_unmapped.length > 0 && (
                      <span className="mw-sub t-warn">withheld, unmapped: {delivery.results_unmapped.join(', ')}</span>
                    )}
                  </td>
                  <td className="mw-row-actions">
                    {canQueue && (
                      <>
                        {deliveryIsReplayable(delivery.state) && (
                          <button type="button" className="pq-link" disabled={busy === `d${delivery.id}`} onClick={() => void act(delivery, 'replay')}>
                            {busy === `d${delivery.id}` ? <Loader2 size={12} className="pd-spin" /> : <RotateCcw size={12} />} Replay
                          </button>
                        )}
                        {(delivery.state === 'queued' || delivery.state === 'retrying') && (
                          <>
                            <button type="button" className="pq-link" disabled={busy === `d${delivery.id}`} onClick={() => void act(delivery, 'send-now')}>
                              <Send size={12} /> Send now
                            </button>
                            <button type="button" className="pq-link" disabled={busy === `d${delivery.id}`} onClick={() => void act(delivery, 'cancel')}>
                              <Ban size={12} /> Cancel
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="What the engine guarantees, and what it does not">
        <Facts items={[
          { label: 'At least once', value: 'A delivery is attempted until it is accepted or the attempt cap is reached. Nothing is dropped silently.' },
          { label: 'Idempotency', value: 'Each delivery carries a key unique to its destination. A retry or a replay is the same delivery, not a second result.' },
          { label: 'Not exactly once', value: 'A destination that acknowledges a message and then loses it, or stores one and fails to acknowledge, is outside this engine’s control. Duplicates are detectable here and reconcilable there.' },
          { label: 'Restart safety', value: 'A delivery in flight when the host stopped is put back in the queue, because an unsent result is worse than a duplicate that can be seen.' },
          { label: 'Independence', value: 'One destination failing never marks another’s delivery successful, and never discards the message.' },
        ]} />
      </Panel>
    </>
  );
}
