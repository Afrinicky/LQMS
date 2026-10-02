import { useEffect, useState } from 'react';
import { History, Lock, Paperclip, Send, Users } from 'lucide-react';
import DetailModal from '../../components/ui/DetailModal';
import { Notice } from '../../components/ui/Feedback';
import { api, errorText } from '../../services/api';
import { confidentialityIsSensitive } from '../../../shared/constants/communications';
import type { Communication } from '../../../shared/types/api';
import { badge, channelLabel, deliveryLabel, directionLabel, methodLabel, pretty, stamp, statusLabel, typeLabel } from './communicationData';

/**
 * One communication, in full — the Communication Log's record of it.
 *
 * Four tables, because an assessor asks four separate questions about a single
 * communication and conflating them is how an answer becomes unprovable:
 *
 *   Recipients  who it was addressed to, and what each of them did with it
 *   Dispatches  which channels it travelled by, how, and whether delivery is
 *               claimed at all — the column that keeps the log honest
 *   Attachments what travelled with it
 *   Trail       every event, in order, with who caused it
 */
export default function CommunicationDetail({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [record, setRecord] = useState<Communication | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) { setRecord(null); return; }
    setLoading(true); setError(null);
    api<Communication>(`/communications/${id}`)
      .then(setRecord)
      .catch(e => { setError(errorText(e) || 'That communication could not be opened.'); setRecord(null); })
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <DetailModal open={Boolean(id)} onClose={onClose} width="wide"
      title={record ? `${record.communication_number} — ${record.subject}` : 'Communication'}
      subtitle={record ? `${typeLabel(record.communication_type)} · ${directionLabel(record.direction)} · ${channelLabel(record.channel)}` : undefined}
      header={record ? badge(statusLabel(record.status)) : undefined}>
      {error && <Notice kind="error">{error}</Notice>}
      {loading && !record && <p className="cc-hint">Opening the record…</p>}

      {record && (
        <div className="comm-detail">
          <dl className="cd-facts">
            <div><dt>Thread</dt><dd>{record.thread_number ?? '—'}</dd></div>
            <div><dt>Sender</dt><dd>{record.sender_name || record.sender_external_name || '—'}</dd></div>
            <div><dt>Date &amp; time</dt><dd>{stamp(record.sent_at ?? record.created_at)}</dd></div>
            <div><dt>Priority</dt><dd>{pretty(record.priority)}</dd></div>
            <div><dt>Confidentiality</dt>
              <dd>{confidentialityIsSensitive(record.confidentiality) && <Lock size={11} />} {pretty(record.confidentiality)}</dd></div>
            <div><dt>Acknowledgement</dt>
              <dd>{record.requires_acknowledgement === 1
                ? `Required${record.acknowledgement_due ? ` by ${String(record.acknowledgement_due).slice(0, 10)}` : ''} — ${record.acknowledged_count ?? 0} of ${record.recipient_count ?? record.recipients?.length ?? 0} acknowledged`
                : 'Not required'}</dd></div>
            {record.requires_approval === 1 && (
              <div><dt>Approval</dt><dd>{record.approved_at
                ? `${record.approved_by_name ?? '—'} on ${stamp(record.approved_at)}`
                : 'Not yet approved'}{record.approval_notes ? ` — ${record.approval_notes}` : ''}</dd></div>
            )}
            {record.source_module && (
              <div><dt>Related record</dt>
                <dd>{pretty(record.source_module)}{record.source_record_type ? ` · ${pretty(record.source_record_type)}` : ''}{record.source_record_id ? ` #${record.source_record_id}` : ''}</dd></div>
            )}
            {record.memo_to_text && <div><dt>TO (as printed)</dt><dd>{record.memo_to_text}</dd></div>}
            {record.memo_from_text && <div><dt>FROM (as printed)</dt><dd>{record.memo_from_text}</dd></div>}
            {record.memo_reference && <div><dt>Their reference</dt><dd>{record.memo_reference}</dd></div>}
            {record.signatory_name && <div><dt>Signatory</dt><dd>{record.signatory_name}</dd></div>}
          </dl>

          <section>
            <h4>Content</h4>
            <div className="cd-body">{record.body}</div>
          </section>

          <section>
            <h4><Users size={13} /> Recipients and audience</h4>
            <table className="data-table compact">
              <thead><tr><th>Addressed as</th><th>Recipient</th><th>State</th><th>Delivered</th><th>Read</th><th>Replied</th><th>Acknowledged</th></tr></thead>
              <tbody>
                {(record.recipients ?? []).map(r => (
                  <tr key={r.id}>
                    <td>{r.audience_label}</td>
                    <td>{r.staff_name || r.user_name || r.external_address || '—'}</td>
                    <td>{badge(deliveryLabel(r.delivery_status))}</td>
                    <td>{stamp(r.delivered_at)}</td>
                    <td>{stamp(r.read_at)}</td>
                    <td>{stamp(r.replied_at)}</td>
                    <td>{stamp(r.acknowledged_at)}</td>
                  </tr>
                ))}
                {(record.recipients ?? []).length === 0 && <tr><td colSpan={7}>No recipients recorded.</td></tr>}
              </tbody>
            </table>
          </section>

          <section>
            <h4><Send size={13} /> Dispatch</h4>
            <table className="data-table compact">
              <thead><tr><th>Channel</th><th>Method</th><th>Format</th><th>Shared with</th><th>Their ref</th><th>Delivery claimed</th><th>By</th><th>When</th><th>Notes</th></tr></thead>
              <tbody>
                {(record.dispatches ?? []).map(d => (
                  <tr key={d.id}>
                    <td>{channelLabel(d.channel)}</td>
                    <td>{methodLabel(d.dispatch_method)}</td>
                    <td>{d.share_format ? String(d.share_format).toUpperCase() : '—'}</td>
                    <td>{d.recipient_label ?? '—'}</td>
                    <td>{d.external_reference ?? '—'}</td>
                    <td>{d.delivery_confirmed === null || d.delivery_confirmed === undefined
                      ? <span title="SECH_LIMS does not deliver on this channel, so no delivery or read confirmation is claimed.">Not claimed</span>
                      : d.delivery_confirmed ? 'Yes' : 'No'}</td>
                    <td>{d.dispatched_by_name ?? '—'}</td>
                    <td>{stamp(d.dispatched_at)}</td>
                    <td>
                      {d.notes ?? '—'}
                      {d.sensitive_release_confirmed === 1 && (
                        <div className="cd-release">Release confirmed{d.sensitive_release_justification ? `: ${d.sensitive_release_justification}` : ''}</div>
                      )}
                    </td>
                  </tr>
                ))}
                {(record.dispatches ?? []).length === 0 && <tr><td colSpan={9}>Not yet dispatched.</td></tr>}
              </tbody>
            </table>
          </section>

          {(record.attachments ?? []).length > 0 && (
            <section>
              <h4><Paperclip size={13} /> Attachments</h4>
              <ul className="cd-list">
                {record.attachments!.map(a => (
                  <li key={a.id}>{a.original_name}{a.caption ? ` — ${a.caption}` : ''}
                    {a.size_bytes ? <span className="cc-hint"> ({Math.max(1, Math.round(a.size_bytes / 1024))} KB)</span> : null}</li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4><History size={13} /> Audit trail</h4>
            <table className="data-table compact">
              <thead><tr><th>When</th><th>Event</th><th>By</th><th>Detail</th></tr></thead>
              <tbody>
                {(record.events ?? []).map(e => (
                  <tr key={e.id}>
                    <td>{stamp(e.created_at)}</td>
                    <td>{pretty(e.event_type)}</td>
                    <td>{e.actor_name ?? 'System'}</td>
                    <td>{e.event_note ?? '—'}</td>
                  </tr>
                ))}
                {(record.events ?? []).length === 0 && <tr><td colSpan={4}>No events recorded.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </DetailModal>
  );
}
