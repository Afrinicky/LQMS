import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { apiRead } from '../../services/api';
import { DeliveryChip, MessageChip, Note, Panel, when, type Delivery, type MessageRow, type SectionProps } from './shared';

/**
 * Live Transmission Monitoring.
 *
 * Two streams side by side, because they answer different questions: what has
 * ARRIVED from the analysers, and what has LEFT for the destinations. A single
 * merged list reads as one flow and hides the gap between them, which is where
 * every real fault lives.
 *
 * It refreshes itself while it is open and can be paused — a bench watching a
 * run wants the list to stop moving while they read a row.
 */
export default function MiddlewareMonitor({ overview, destinations }: SectionProps) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    if (pausedRef.current) return;
    const [messageData, deliveryData] = await Promise.all([
      apiRead<{ rows: MessageRow[] }>('/middleware/messages?limit=25', { rows: [] }),
      apiRead<{ rows: Delivery[] }>('/middleware/deliveries?limit=25', { rows: [] }),
    ]);
    setMessages(messageData.rows);
    setDeliveries(deliveryData.rows);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <>
      <div className="mw-monitor-bar">
        <span className={`mw-live${overview?.running ? ' on' : ''}`}>
          {overview?.running ? 'Engine running' : 'Engine stopped'}
        </span>
        <span className="mw-sub">
          {overview?.queueDepth ?? 0} waiting · {overview?.deadLetters ?? 0} dead-lettered · {overview?.deliveredToday ?? 0} accepted today
        </span>
        <button type="button" className="pq-link" onClick={() => setPaused(p => !p)}>
          {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
        </button>
      </div>

      <div className="mw-grid-2">
        <Panel title="Arriving" subtitle="What the analysers have sent, as the middleware ingested it.">
          {!messages.length ? <Note>Nothing has arrived yet.</Note> : (
            <ul className="mw-stream">
              {messages.map(message => (
                <li key={message.id} className={`k-${message.kind}`}>
                  <span className="mw-stream-time">{String(message.received_at).slice(11, 19)}</span>
                  <span className="mw-stream-body">
                    <strong className="mono">{message.sample_id || '(no sample id)'}</strong>
                    <span className="mw-sub">
                      {message.link_name ?? 'unknown analyser'} · {message.kind} · {message.result_count} result(s)
                      {message.routes_matched ? ` · ${message.routes_matched} rule(s) matched` : ' · no rule matched'}
                    </span>
                  </span>
                  <MessageChip status={message.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Leaving" subtitle="What was transmitted, and what the destination said about it.">
          {!deliveries.length ? <Note>Nothing has been queued for a destination yet.</Note> : (
            <ul className="mw-stream">
              {deliveries.map(delivery => (
                <li key={delivery.id}>
                  <span className="mw-stream-time">
                    {String(delivery.last_attempt_at ?? delivery.message_received_at).slice(11, 19)}
                  </span>
                  <span className="mw-stream-body">
                    <strong>{delivery.destination_name}</strong>
                    <span className="mw-sub">
                      <span className="mono">{delivery.sample_id || '(no sample id)'}</span>
                      {' · '}attempt {delivery.attempt} of {delivery.max_attempts}
                      {delivery.ack_code ? ` · ack ${delivery.ack_code}` : ''}
                      {delivery.results_sent ? ` · ${delivery.results_sent} result(s)` : ''}
                      {!delivery.confirmable && delivery.state === 'delivered' ? ' · transmitted, acceptance not confirmed' : ''}
                    </span>
                    {delivery.error && <span className="mw-sub t-crit">{delivery.error}</span>}
                  </span>
                  <DeliveryChip state={delivery.state} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Destinations now" subtitle="Where each stands at this moment.">
        {!destinations.length ? <Note>No destination is configured.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr><th>Destination</th><th>State</th><th className="num">Waiting</th><th className="num">Dead</th><th>Last accepted</th><th>Last error</th></tr>
            </thead>
            <tbody>
              {destinations.map(destination => (
                <tr key={destination.id}>
                  <td><strong>{destination.name}</strong></td>
                  <td>{destination.state}</td>
                  <td className="num">{destination.pending}</td>
                  <td className={`num${destination.dead_letters ? ' t-crit' : ''}`}>{destination.dead_letters}</td>
                  <td>{when(destination.last_delivery_at)}</td>
                  <td className="mw-sub">{destination.last_error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
