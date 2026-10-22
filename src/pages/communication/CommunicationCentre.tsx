import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckCircle2, CornerUpLeft, FileText, Forward, Inbox, Lock, MessageSquarePlus,
  Paperclip, Search, ShieldAlert, Users,
} from 'lucide-react';
import TextField from '../../components/ui/TextField';
import EmptyState from '../../components/ui/EmptyState';
import { Notice } from '../../components/ui/Feedback';
import { KpiStrip } from '../../components/ui';
import { API_BASE, errorText, getToken } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../hooks/useAuth';
import { useCommunications } from '../../hooks/useCommunications';
import { COMM_FEATURE, confidentialityIsSensitive } from '../../../shared/constants/communications';
import type { Communication, CommunicationThread } from '../../../shared/types/api';
import ComposeDialog from './ComposeDialog';
import ForwardDialog from './ForwardDialog';
import {
  channelLabel, deliveryLabel, loadThread, post, pretty, relative, stamp, typeLabel,
  useCommunicationWorkspace,
} from './communicationData';

/**
 * The communication centre — the person's own conversations.
 *
 * Two panes, because a conversation is read in context: the list of threads on
 * the left, the thread itself on the right, and the reply box at the bottom of
 * it where a reply box belongs. It is a chat because that is what two-way
 * communication between colleagues actually is, and it is a record because
 * every bubble in it carries a communication number, a recipient list and a
 * read state that the Communication Log can account for.
 *
 * Opening a conversation marks what is addressed to this person read — that is
 * what opening it means — and the popup, the topbar count and the portal inbox
 * all follow, because they are the same fact held in one place.
 */

type Filter = 'all' | 'unread' | 'formal' | 'mine';

const FILTERS: Array<{ key: Filter; label: string; hint: string }> = [
  { key: 'all', label: 'All', hint: 'Every conversation you are part of' },
  { key: 'unread', label: 'Unread', hint: 'Conversations with something you have not read' },
  { key: 'formal', label: 'Memos & notices', hint: 'Formal communications only' },
  { key: 'mine', label: 'Sent by me', hint: 'Conversations you started' },
];

export default function CommunicationCentre() {
  const { can } = usePermissions();
  const { user } = useAuth();
  const { refresh: refreshPopups } = useCommunications();
  const [params, setParams] = useSearchParams();
  const { summary, threads, templates, staff, error, setError, reload } = useCommunicationWorkspace(true);

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [thread, setThread] = useState<(CommunicationThread & { messages: Communication[] }) | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [forwarding, setForwarding] = useState<Communication | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const mayCompose = can(COMM_FEATURE.messages, 'create');

  // A popup, an alert or the topbar badge links straight to a conversation.
  // The parameter is consumed once so the reader can click away afterwards
  // without being dragged back to it.
  const wanted = params.get('thread');
  const appliedThread = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || appliedThread.current === wanted) return;
    appliedThread.current = wanted;
    const id = Number(wanted);
    if (Number.isFinite(id)) setOpenThreadId(id);
  }, [wanted]);

  const openThread = useCallback(async (id: number) => {
    setLoadingThread(true);
    try {
      const data = await loadThread(id);
      setThread(data);
      // Opening a conversation is reading it. Done after the panel has the
      // content, so the reader never waits on a read receipt.
      await post(`/communications/threads/${id}/read`, {}).catch(() => undefined);
      await refreshPopups();
      void reload();
    } catch (e) { setError(errorText(e)); setThread(null); }
    finally { setLoadingThread(false); }
  }, [refreshPopups, reload, setError]);

  useEffect(() => { if (openThreadId) void openThread(openThreadId); }, [openThreadId, openThread]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [thread?.id, thread?.messages?.length]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter(t => {
      if (filter === 'unread' && !(t.unread_count && t.unread_count > 0)) return false;
      if (filter === 'formal' && !['memo', 'notice'].includes(t.communication_type)) return false;
      if (filter === 'mine' && t.started_by_user_id !== user?.id) return false;
      if (!q) return true;
      return `${t.subject} ${t.thread_number} ${t.last_message_preview ?? ''} ${t.last_sender_name ?? ''}`.toLowerCase().includes(q);
    });
  }, [threads, filter, search, user]);

  async function sendReply() {
    const body = draft.trim();
    if (!body || !thread) return;
    const last = thread.messages[thread.messages.length - 1];
    if (!last) return;
    setBusy(true); setError(null);
    try {
      await post(`/communications/${last.id}/reply`, { body });
      setDraft('');
      await openThread(thread.id);
      await refreshPopups();
    } catch (e) { setError(errorText(e) || 'The reply could not be sent.'); }
    finally { setBusy(false); }
  }

  async function act(communicationId: number, action: 'acknowledge' | 'read') {
    setBusy(true);
    try {
      await post(`/communications/${communicationId}/${action}`, {});
      if (thread) await openThread(thread.id);
      await refreshPopups();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  /**
   * Open an attachment.
   *
   * Fetched with the session token and handed to the browser as a blob:
   * anything it renders opens in a tab, anything it does not is delivered as a
   * named file so the operating system opens it with the right application —
   * the same rule services/files.ts applies to stored documents.
   */
  async function openAttachment(communicationId: number, attachmentId: number, name?: string | null) {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/communications/${communicationId}/attachments/${attachmentId}/raw`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error('The attachment could not be opened.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noreferrer';
      if (!/^(application\/pdf|image\/|text\/)/.test(blob.type)) a.download = name || `attachment-${attachmentId}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="comm-centre">
      {error && <Notice kind="error">{error}</Notice>}

      {summary && <KpiStrip items={[
        { label: 'Unread messages', value: summary.myUnread, tone: summary.myUnread > 0 ? 'warning' : undefined },
        { label: 'My conversations', value: summary.myThreads },
        { label: 'Awaiting my acknowledgement', value: summary.myAwaitingAcknowledgement, tone: summary.myAwaitingAcknowledgement > 0 ? 'warning' : undefined },
        { label: 'Sent this month', value: summary.sentThisMonth },
        { label: 'Received this month', value: summary.inboundThisMonth },
      ]} />}

      <div className="cm-split">
        {/* ---------------- Conversation list ---------------- */}
        <aside className="cm-list">
          <div className="cm-list-head">
            <div className="cm-search">
              <Search size={13} />
              <TextField value={search} onValue={setSearch} placeholder="Search conversations…" aria-label="Search conversations" />
            </div>
            {mayCompose && (
              <button type="button" className="cm-new" onClick={() => setComposing(true)}>
                <MessageSquarePlus size={14} /> New
              </button>
            )}
          </div>

          <div className="pp-filters" role="tablist" aria-label="Conversation filters">
            {FILTERS.map(f => (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} title={f.hint}
                className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
                {f.label}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="pp-clear"><Inbox size={16} /><span>
              {threads.length === 0 ? 'No conversations yet. Start one with “New”.' : 'Nothing matches this view.'}
            </span></div>
          ) : (
            <ul className="cm-threads">
              {rows.map(t => (
                <li key={t.id}>
                  <button type="button" className={`cm-thread${t.id === thread?.id ? ' active' : ''}${t.unread_count ? ' unread' : ''}`}
                    onClick={() => { setOpenThreadId(t.id); setParams(prev => { const next = new URLSearchParams(prev); next.set('tab', 'Communication'); next.set('thread', String(t.id)); return next; }, { replace: true }); }}>
                    <span className="cm-thread-top">
                      <span className="cm-thread-subject">
                        {['memo', 'notice'].includes(t.communication_type) && <FileText size={12} />}
                        {confidentialityIsSensitive(t.confidentiality) && <Lock size={11} />}
                        {t.subject}
                      </span>
                      <span className="cm-thread-when">{relative(t.last_message_at ?? t.created_at)}</span>
                    </span>
                    <span className="cm-thread-prev">{t.last_message_preview || '—'}</span>
                    <span className="cm-thread-meta">
                      <span className="badge">{typeLabel(t.communication_type)}</span>
                      <span>{t.last_sender_name || t.started_by_name || '—'}</span>
                      {t.message_count > 1 && <span>{t.message_count} messages</span>}
                      {t.unread_count ? <span className="cm-unread">{t.unread_count} new</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ---------------- The conversation ---------------- */}
        <section className="cm-pane">
          {!thread && !loadingThread && (
            <EmptyState
              icon={<Inbox size={26} />}
              title="Pick a conversation"
              message="Messages, memos and notices addressed to you appear on the left. Everything you send from here is numbered and recorded in the Communication Log."
            />
          )}
          {loadingThread && !thread && <p className="cc-hint">Opening the conversation…</p>}

          {thread && <>
            <header className="cm-pane-head">
              <div>
                <h3>{thread.subject}</h3>
                <p>
                  {thread.thread_number} · {typeLabel(thread.communication_type)} · {pretty(thread.confidentiality)}
                  {thread.participants && thread.participants.length > 0 && <> · <Users size={11} /> {thread.participants.slice(0, 4).join('; ')}{thread.participants.length > 4 ? ` +${thread.participants.length - 4}` : ''}</>}
                </p>
              </div>
            </header>

            <div className="cm-messages">
              {thread.messages.map(message => {
                const mine = message.sender_user_id === user?.id;
                const ackPending = message.requires_acknowledgement === 1 && message.my_recipient_id && message.my_delivery_status !== 'acknowledged';
                return (
                  <article key={message.id} className={`cm-msg${mine ? ' mine' : ''}`}>
                    <header>
                      <strong>{message.sender_name || 'SECH_LIMS'}</strong>
                      <span>{stamp(message.sent_at ?? message.created_at)}</span>
                      <span className="badge">{message.communication_number}</span>
                      {message.direction !== 'internal' && <span className="badge">{pretty(message.direction)}</span>}
                      {message.channel !== 'in_app' && <span className="badge">{channelLabel(message.channel)}</span>}
                    </header>

                    <div className="cm-msg-body">{message.body}</div>

                    {message.attachments && message.attachments.length > 0 && (
                      <ul className="cm-attach">
                        {message.attachments.map(a => (
                          <li key={a.id}>
                            <button type="button" onClick={() => void openAttachment(message.id, a.id, a.original_name)}>
                              <Paperclip size={11} /> {a.original_name}
                            </button>
                            {a.caption && <span> — {a.caption}</span>}
                          </li>
                        ))}
                      </ul>
                    )}

                    <footer>
                      {message.recipients && message.recipients.length > 0 && (
                        <span title={message.recipients.map(r => `${r.staff_name || r.user_name || r.audience_label}: ${deliveryLabel(r.delivery_status)}`).join('\n')}>
                          To {[...new Set(message.recipients.map(r => r.audience_label))].slice(0, 3).join('; ')}
                          {message.recipients.length > 3 ? ` +${message.recipients.length - 3}` : ''}
                          {' · '}{message.read_count ?? 0}/{message.recipient_count ?? message.recipients.length} read
                          {message.requires_acknowledgement === 1 && <> · {message.acknowledged_count ?? 0} acknowledged</>}
                        </span>
                      )}
                      {message.dispatches && message.dispatches.some(d => d.dispatch_method !== 'system') && (
                        <span className="cm-prepared" title="Prepared and shared outside SECH_LIMS. No delivery or read confirmation is claimed for those channels.">
                          <ShieldAlert size={11} /> shared externally
                        </span>
                      )}
                      <span className="cm-msg-actions">
                        {ackPending && (
                          <button type="button" className="pt-mini ok" disabled={busy}
                            title="Acknowledge — you have read it and accept it"
                            onClick={() => void act(message.id, 'acknowledge')}>
                            <CheckCircle2 size={12} /> Acknowledge
                          </button>
                        )}
                        {mayCompose && (
                          <button type="button" className="pt-mini" title="Forward this communication"
                            onClick={() => setForwarding(message)}>
                            <Forward size={12} /> Forward
                          </button>
                        )}
                      </span>
                    </footer>
                  </article>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {mayCompose && (
              <div className="cm-reply">
                <TextField as="textarea" rows={3} value={draft} onValue={setDraft}
                  placeholder="Write a reply… (Ctrl+Enter to send)" aria-label="Your reply"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendReply(); } }} />
                <button type="button" onClick={() => void sendReply()} disabled={busy || !draft.trim()}>
                  <CornerUpLeft size={13} /> Reply
                </button>
              </div>
            )}
            {!mayCompose && (
              <p className="cc-hint">You may read this conversation but not reply to it.</p>
            )}
          </>}
        </section>
      </div>

      <ComposeDialog
        open={composing}
        onClose={() => setComposing(false)}
        onSent={() => { void reload(); void refreshPopups(); }}
        templates={templates}
        staff={staff}
      />
      <ForwardDialog
        message={forwarding}
        onClose={() => setForwarding(null)}
        onForwarded={() => { void reload(); if (thread) void openThread(thread.id); }}
      />
    </div>
  );
}
