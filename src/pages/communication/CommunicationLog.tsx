import { useCallback, useEffect, useState } from 'react';
import { Download, Inbox, Lock, PlusCircle, Search, ShieldAlert } from 'lucide-react';
import TextField from '../../components/ui/TextField';
import EmptyState from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Feedback';
import { KpiStrip } from '../../components/ui';
import { API_BASE, errorText, getToken } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  CHANNEL_LABELS, COMMUNICATION_CHANNELS, COMMUNICATION_DIRECTIONS, COMMUNICATION_STATUSES,
  COMMUNICATION_TYPES, COMMUNICATION_TYPE_LABELS, COMM_FEATURE, confidentialityIsSensitive,
} from '../../../shared/constants/communications';
import type { CommunicationLogRow, CommunicationSummary } from '../../../shared/types/api';
import CommunicationDetail from './CommunicationDetail';
import InboundDialog from './InboundDialog';
import {
  badge, channelLabel, directionLabel, loadLog, pretty, stamp, statusLabel, typeLabel,
  useCommunicationWorkspace,
} from './communicationData';

/**
 * The Communication Log — the authoritative register.
 *
 * Every communication the laboratory has sent or received, whichever module
 * raised it and whatever channel carried it, in one table with one set of
 * filters. This is the screen an assessor is shown and the screen a head of
 * department uses to answer "was the laboratory told, and when?", so it holds
 * the full set of columns the record is accountable for rather than a tidy
 * subset: the number, type, direction, channel, sender, audience, date,
 * dispatch method, status, read and acknowledgement counts, attachments and
 * the related record.
 *
 * Two filters earn their place beside the obvious ones. "Shared externally"
 * finds every communication that left SECH_LIMS through a channel it cannot
 * confirm — the population a confidentiality review actually cares about. And
 * "acknowledgement required" finds the ones somebody still owes an answer to.
 */

const BLANK_FILTERS = {
  search: '', type: '', direction: '', channel: '', status: '',
  from: '', to: '', externalOnly: false, requiresAcknowledgement: false,
};

export default function CommunicationLog() {
  const { can } = usePermissions();
  const { summary } = useCommunicationWorkspace(true);
  const [rows, setRows] = useState<CommunicationLogRow[]>([]);
  const [filters, setFilters] = useState({ ...BLANK_FILTERS });
  const [detailId, setDetailId] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const mayExport = can(COMM_FEATURE.log, 'export');
  const mayRecordInbound = can(COMM_FEATURE.messages, 'create');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setRows(await loadLog({
        search: filters.search, type: filters.type, direction: filters.direction,
        channel: filters.channel, status: filters.status, from: filters.from, to: filters.to,
        externalOnly: filters.externalOnly ? 'true' : '',
        requiresAcknowledgement: filters.requiresAcknowledgement ? 'true' : '',
        limit: '400',
      }));
    } catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  async function exportRegister() {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/communications/log/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('The register could not be exported.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `communication-log-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="comm-log">
      {error && <Notice kind="error">{error}</Notice>}

      {summary && <LogKpis summary={summary} />}

      <div className="cm-toolbar cl-filters">
        <div className="cl-filter-row">
          <div className="cm-search">
            <Search size={13} />
            <TextField value={filters.search} onValue={v => setFilters({ ...filters, search: v })}
              placeholder="Search number, subject or content…" aria-label="Search the communication log" />
          </div>
          <label>Type
            <select value={filters.type} onChange={e => setFilters({ ...filters, type: e.target.value })}>
              <option value="">All</option>
              {COMMUNICATION_TYPES.map(t => <option key={t} value={t}>{COMMUNICATION_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label>Direction
            <select value={filters.direction} onChange={e => setFilters({ ...filters, direction: e.target.value })}>
              <option value="">All</option>
              {COMMUNICATION_DIRECTIONS.map(d => <option key={d} value={d}>{directionLabel(d)}</option>)}
            </select>
          </label>
          <label>Channel
            <select value={filters.channel} onChange={e => setFilters({ ...filters, channel: e.target.value })}>
              <option value="">All</option>
              {COMMUNICATION_CHANNELS.map(c => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </select>
          </label>
          <label>Status
            <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All</option>
              {COMMUNICATION_STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </label>
          <label>From<input type="date" value={filters.from} onChange={e => setFilters({ ...filters, from: e.target.value })} /></label>
          <label>To<input type="date" value={filters.to} onChange={e => setFilters({ ...filters, to: e.target.value })} /></label>
        </div>
        <div className="cl-filter-row">
          <label className="cc-check">
            <input type="checkbox" checked={filters.externalOnly}
              onChange={e => setFilters({ ...filters, externalOnly: e.target.checked })} />
            <span>Prepared or shared externally only</span>
          </label>
          <label className="cc-check">
            <input type="checkbox" checked={filters.requiresAcknowledgement}
              onChange={e => setFilters({ ...filters, requiresAcknowledgement: e.target.checked })} />
            <span>Acknowledgement required</span>
          </label>
          <button type="button" className="ghost" onClick={() => setFilters({ ...BLANK_FILTERS })}>Clear filters</button>
          {mayRecordInbound && (
            <button type="button" onClick={() => setRecording(true)} title="Record a communication received from outside SECH_LIMS">
              <PlusCircle size={14} /> Record an inbound communication
            </button>
          )}
          {mayExport && (
            <button type="button" onClick={() => void exportRegister()}><Download size={14} /> Export the register</button>
          )}
        </div>
      </div>

      {loading && rows.length === 0 && <p className="cc-hint">Reading the register…</p>}

      {!loading && rows.length === 0 ? (
        <EmptyState icon={<Inbox size={26} />} title="Nothing in the register for this view"
          message="Every message, memo, notice, alert and system notification appears here once it has been raised through the Communication Service." />
      ) : (
        <div className="cl-table-wrap">
          <table className="data-table compact">
            <thead><tr>
              <th>Number</th><th>Type</th><th>Direction</th><th>Channel</th><th>Subject</th>
              <th>Sender</th><th>Recipient / audience</th><th>Date &amp; time</th>
              <th>Dispatch</th><th>Read / ack</th><th>Att.</th><th>Replies</th>
              <th>Related record</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>
                    <button type="button" className="link" onClick={() => setDetailId(r.id)}>{r.communication_number}</button>
                    {confidentialityIsSensitive(r.confidentiality) && <span title={pretty(r.confidentiality)}><Lock size={10} /></span>}
                  </td>
                  <td>{typeLabel(r.communication_type)}</td>
                  <td>{directionLabel(r.direction)}</td>
                  <td>{channelLabel(r.channel)}</td>
                  <td>{r.subject}</td>
                  <td>{r.sender_name || '—'}</td>
                  <td title={r.recipients_summary ?? ''}>
                    {(r.recipients_summary ?? '—').split(',').slice(0, 2).join('; ')}
                    {(r.recipients_summary ?? '').split(',').length > 2 && ` +${(r.recipients_summary ?? '').split(',').length - 2}`}
                  </td>
                  <td>{stamp(r.sent_at ?? r.created_at)}</td>
                  <td title={r.dispatch_summary ?? ''}>
                    {r.dispatch_summary
                      ? <>{r.dispatch_summary.split(',').length} dispatch{r.dispatch_summary.split(',').length === 1 ? '' : 'es'}
                        {/system\)/.test(r.dispatch_summary) ? '' : ' '}
                        {!/system\)/.test(r.dispatch_summary) && <span title="Prepared or shared externally — no delivery confirmation is claimed."><ShieldAlert size={11} /></span>}</>
                      : '—'}
                  </td>
                  <td>{r.read_count ?? 0}/{r.recipient_count ?? 0}
                    {r.requires_acknowledgement === 1 && <> · {r.acknowledged_count ?? 0}</>}</td>
                  <td>{r.attachment_count ?? 0}</td>
                  <td>{r.reply_count ?? 0}</td>
                  <td>{r.source_module ? `${pretty(r.source_module)}${r.source_record_id ? ` #${r.source_record_id}` : ''}` : '—'}</td>
                  <td>{badge(statusLabel(r.status))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CommunicationDetail id={detailId} onClose={() => setDetailId(null)} />
      <InboundDialog open={recording} onClose={() => setRecording(false)} onRecorded={() => void load()} />
    </div>
  );
}

function LogKpis({ summary }: { summary: CommunicationSummary }) {
  const total = summary.byDirection.reduce((sum, d) => sum + d.c, 0);
  return <KpiStrip items={[
    { label: 'Communications on record', value: total },
    { label: 'Sent this month', value: summary.sentThisMonth },
    { label: 'Received this month', value: summary.inboundThisMonth },
    { label: 'Prepared / shared externally', value: summary.externalSharesThisMonth },
    { label: 'Awaiting approval', value: summary.awaitingApproval },
  ]} />;
}
