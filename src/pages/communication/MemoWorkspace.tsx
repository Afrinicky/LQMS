import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2, ClipboardCheck, FilePlus2, FileText, Lock, Printer, RotateCcw, Send, Share2,
} from 'lucide-react';
import TextField from '../../components/ui/TextField';
import EmptyState from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Feedback';
import { KpiStrip } from '../../components/ui';
import { API_BASE, errorText, getToken } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { COMM_FEATURE, confidentialityIsSensitive, type CommunicationType } from '../../../shared/constants/communications';
import type { CommunicationLogRow } from '../../../shared/types/api';
import ComposeDialog from './ComposeDialog';
import ShareDialog from './ShareDialog';
import CommunicationDetail from './CommunicationDetail';
import {
  badge, channelLabel, loadLog, post, pretty, stamp, statusLabel, typeLabel,
  useCommunicationWorkspace,
} from './communicationData';

/**
 * Memos and notices — the formal end of the hub.
 *
 * A memo is not a message. It carries a number, a TO/FROM block, a signatory,
 * often an approval, and it is frequently carried out of SECH_LIMS on paper or
 * over a channel the system cannot reach. So it gets its own workspace, with
 * the three things a memo actually needs beyond a message:
 *
 *   · a release step — submitted, approved or returned, visible as a queue so
 *     a memo cannot sit unapproved and unnoticed;
 *   · prepared copies — PDF, Word, text, image — produced from the approved
 *     content, never retyped;
 *   · an external-share record for every copy that leaves, so the log can say
 *     what was shared, by whom and through what, without pretending to know
 *     that it was received.
 */

/** The two formal kinds this workspace prepares. Memo opens by default. */
const FORMAL_COMPOSE_TYPES: CommunicationType[] = ['memo', 'notice'];

type View = 'all' | 'awaiting_approval' | 'drafts' | 'sent';

const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'all', label: 'All memos & notices' },
  { key: 'awaiting_approval', label: 'Awaiting approval' },
  { key: 'drafts', label: 'Drafts & returned' },
  { key: 'sent', label: 'Dispatched' },
];

export default function MemoWorkspace() {
  const { can } = usePermissions();
  const { summary, templates, staff, error, setError, reload } = useCommunicationWorkspace(true);
  const [rows, setRows] = useState<CommunicationLogRow[]>([]);
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  const [composing, setComposing] = useState(false);
  const [sharing, setSharing] = useState<CommunicationLogRow | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mayPrepare = can(COMM_FEATURE.memos, 'create');
  const mayApprove = can(COMM_FEATURE.memos, 'approve');
  const mayShare = can(COMM_FEATURE.memos, 'export');
  const mayPrint = can(COMM_FEATURE.memos, 'print');
  const mayWithdraw = can(COMM_FEATURE.memos, 'void_archive');

  const load = useCallback(async () => {
    try {
      // Memos and notices are two queries rather than one so the register's
      // own type filter stays a single value, which is what every other
      // register in SECH_LIMS does.
      const [memos, notices] = await Promise.all([
        loadLog({ type: 'memo', limit: '400' }),
        loadLog({ type: 'notice', limit: '400' }),
      ]);
      setRows([...memos, ...notices].sort((a, b) =>
        String(b.sent_at ?? b.created_at).localeCompare(String(a.sent_at ?? a.created_at))));
    } catch (e) { setError(errorText(e)); }
  }, [setError]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (view === 'awaiting_approval' && r.status !== 'pending_approval') return false;
      if (view === 'drafts' && !['draft', 'rejected', 'approved'].includes(r.status)) return false;
      if (view === 'sent' && r.status !== 'sent') return false;
      if (!q) return true;
      return `${r.communication_number} ${r.subject} ${r.sender_name ?? ''} ${r.recipients_summary ?? ''}`.toLowerCase().includes(q);
    });
  }, [rows, view, search]);

  async function act(id: number, action: 'submit-approval' | 'approve' | 'reject' | 'send' | 'void', body: unknown = {}) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await post(`/communications/${id}/${action}`, body);
      setNotice({
        'submit-approval': 'Sent for approval.',
        approve: 'Approved and dispatched.',
        reject: 'Returned to the author.',
        send: 'Dispatched.',
        void: 'Withdrawn. The record is kept.',
      }[action]);
      await load(); await reload();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function openPrint(id: number) {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/communications/${id}/print`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('The printable copy could not be prepared.');
      const html = await res.text();
      const win = window.open('', '_blank');
      if (!win) throw new Error('Allow pop-ups for SECH_LIMS so the printable copy can open.');
      win.document.write(html);
      win.document.close();
      await load();
    } catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="comm-memos">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      {summary && <KpiStrip items={[
        { label: 'Awaiting approval', value: summary.awaitingApproval, tone: summary.awaitingApproval > 0 ? 'warning' : undefined, onClick: () => setView('awaiting_approval') },
        { label: 'My drafts', value: summary.draftsMine, onClick: () => setView('drafts') },
        { label: 'Dispatched this month', value: summary.sentThisMonth, onClick: () => setView('sent') },
        { label: 'Prepared / shared externally', value: summary.externalSharesThisMonth },
      ]} />}

      <div className="cm-toolbar">
        <div className="pp-filters" role="tablist" aria-label="Memo views">
          {VIEWS.map(v => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key}
              className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>{v.label}</button>
          ))}
        </div>
        <div className="cm-toolbar-right">
          <TextField value={search} onValue={setSearch} placeholder="Search memos and notices…" aria-label="Search memos" />
          {mayPrepare && (
            <button type="button" onClick={() => setComposing(true)}><FilePlus2 size={14} /> Prepare a memo</button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<FileText size={26} />} title="No memos or notices here"
          message={rows.length === 0
            ? 'Prepare one with “Prepare a memo”. It is numbered, approved where required, dispatched to the audience you choose, and recorded in the Communication Log.'
            : 'Nothing matches this view.'} />
      ) : (
        <table className="data-table">
          <thead><tr>
            <th>Number</th><th>Type</th><th>Subject</th><th>Audience</th><th>From</th>
            <th>Date</th><th>Channel</th><th>Read / ack</th><th>Status</th><th>Actions</th>
          </tr></thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.id}>
                <td>
                  <button type="button" className="link" onClick={() => setDetailId(r.id)}>{r.communication_number}</button>
                  {confidentialityIsSensitive(r.confidentiality) && <span title={pretty(r.confidentiality)}><Lock size={11} /></span>}
                </td>
                <td>{typeLabel(r.communication_type)}</td>
                <td>{r.subject}</td>
                <td title={r.recipients_summary ?? ''}>{(r.recipients_summary ?? '—').split(',').slice(0, 2).join('; ')}{(r.recipients_summary ?? '').split(',').length > 2 ? '…' : ''}</td>
                <td>{r.memo_from_text || r.sender_name || '—'}</td>
                <td>{stamp(r.sent_at ?? r.created_at)}</td>
                <td>{channelLabel(r.channel)}</td>
                <td>
                  {r.read_count ?? 0}/{r.recipient_count ?? 0}
                  {r.requires_acknowledgement === 1 && <> · {r.acknowledged_count ?? 0} ack</>}
                </td>
                <td>{badge(statusLabel(r.status))}</td>
                <td className="cm-row-actions">
                  {r.status === 'draft' && mayPrepare && (
                    <button type="button" disabled={busy} title="Send it for approval"
                      onClick={() => void act(r.id, 'submit-approval')}><ClipboardCheck size={12} /> Approval</button>
                  )}
                  {(r.status === 'draft' || r.status === 'approved') && mayPrepare && (
                    <button type="button" disabled={busy} title="Dispatch it now"
                      onClick={() => void act(r.id, 'send')}><Send size={12} /> Dispatch</button>
                  )}
                  {r.status === 'pending_approval' && mayApprove && <>
                    <button type="button" disabled={busy} title="Approve and dispatch"
                      onClick={() => void act(r.id, 'approve')}><CheckCircle2 size={12} /> Approve</button>
                    <button type="button" disabled={busy} title="Return it to the author"
                      onClick={() => {
                        const notes = window.prompt('Why is it being returned? The author sees this.');
                        if (notes && notes.trim()) void act(r.id, 'reject', { notes });
                      }}><RotateCcw size={12} /> Return</button>
                  </>}
                  {mayPrint && (
                    <button type="button" title="Print or save as PDF" onClick={() => void openPrint(r.id)}>
                      <Printer size={12} />
                    </button>
                  )}
                  {mayShare && (
                    <button type="button" title="Prepare a copy and record how it was shared"
                      onClick={() => setSharing(r)}><Share2 size={12} /></button>
                  )}
                  {mayWithdraw && r.status !== 'void' && (
                    <button type="button" className="danger" title="Withdraw this communication"
                      onClick={() => {
                        const reason = window.prompt('Why is this communication being withdrawn? It stays on the record.');
                        if (reason && reason.trim()) void act(r.id, 'void', { reason });
                      }}>Withdraw</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ComposeDialog
        open={composing}
        onClose={() => setComposing(false)}
        onSent={() => { void load(); void reload(); }}
        templates={templates}
        staff={staff}
        types={FORMAL_COMPOSE_TYPES}
      />
      <ShareDialog communication={sharing} onClose={() => setSharing(null)} onShared={() => void load()} />
      <CommunicationDetail id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
