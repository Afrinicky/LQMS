import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CornerUpLeft, Lock, MessageSquare, Send, X } from 'lucide-react';
import { useCommunications, type InboundCommunication } from '../hooks/useCommunications';
import { COMMUNICATION_TYPE_LABELS, type CommunicationType } from '../../shared/constants/communications';

/**
 * The popup a new message arrives in.
 *
 * A member of staff at the bench is in the middle of something. A message that
 * takes over the screen, or that must be dealt with before anything else can
 * happen, is an interruption they will learn to kill on sight — so this is
 * deliberately small, corner-anchored, and never modal:
 *
 *   · it says who, what about, and the first line, which is enough to decide;
 *   · Open goes to the conversation, Reply answers without leaving the screen,
 *     Dismiss closes the popup and changes nothing;
 *   · dismissing is NOT reading. The message stays unread, stays in the inbox
 *     and stays counted. A popup that quietly marked things read would be a
 *     way of losing messages;
 *   · nothing is drawn at all when there is nothing new, so the corner of the
 *     screen is empty the overwhelming majority of the time.
 *
 * The styling is self-contained for the same reason the assistant widget's is:
 * the popup has to look right over any page, and its colours come from the
 * design tokens so it follows the active theme.
 */

const POPUP_CSS = `
.comm-pop-stack{position:fixed;right:22px;bottom:104px;z-index:1250;display:flex;flex-direction:column-reverse;gap:10px;max-width:92vw;pointer-events:none}
.comm-pop{pointer-events:auto;width:352px;max-width:92vw;background:var(--card);border:1px solid var(--border);border-radius:14px;
  box-shadow:var(--shadow-lg);overflow:hidden;color:var(--text);animation:commPopIn .16s ease-out}
@keyframes commPopIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.comm-pop.urgent{border-color:var(--danger-line)}
.comm-pop .hd{display:flex;align-items:center;gap:9px;padding:9px 11px;background:linear-gradient(90deg,#16284b,#1B3A6B);color:#EAF1FF}
.comm-pop .av{width:30px;height:30px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(circle at 30% 25%,var(--accent),#13315f);color:#fff;font-size:11.5px;font-weight:700;letter-spacing:.3px}
.comm-pop .who{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}
.comm-pop .who strong{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.comm-pop .who small{font-size:10.5px;color:#9FB2D6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.comm-pop .ic{background:transparent;border:none;color:#CFE0FF;cursor:pointer;padding:3px;border-radius:6px;display:flex}
.comm-pop .ic:hover{background:rgba(255,255,255,.14)}
.comm-pop .bd{padding:10px 12px;background:var(--surface)}
.comm-pop .sub{font-size:13px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:6px}
.comm-pop .sub svg{flex:0 0 auto;color:var(--muted)}
.comm-pop .prev{margin:0;font-size:12.5px;line-height:1.5;color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.comm-pop .chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.comm-pop .chip{font-size:10.5px;padding:2px 7px;border-radius:20px;border:1px solid var(--border);background:var(--panel-2);color:var(--muted)}
.comm-pop .chip.urgent{border-color:var(--danger-line);color:var(--danger)}
.comm-pop .chip.ack{border-color:var(--warning-line);color:var(--warning)}
.comm-pop .ft{display:flex;gap:7px;padding:9px 11px;border-top:1px solid var(--border);background:var(--panel)}
.comm-pop .ft button{flex:1;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px}
.comm-pop .ft button:hover{border-color:var(--border-strong)}
.comm-pop .ft button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.comm-pop .ft button:disabled{opacity:.55;cursor:default}
.comm-pop .rp{padding:10px 11px;border-top:1px solid var(--border);background:var(--panel);display:flex;gap:7px;align-items:flex-end}
.comm-pop .rp textarea{flex:1;resize:none;height:56px;border-radius:9px;border:1px solid var(--border);background:var(--surface);
  color:var(--text);padding:7px 9px;font-family:inherit;font-size:12.5px}
.comm-pop .rp button{border:none;border-radius:9px;background:var(--accent);color:var(--on-accent);padding:0 12px;height:34px;cursor:pointer;display:flex;align-items:center;gap:5px}
.comm-pop .rp button:disabled{opacity:.5;cursor:default}
.comm-pop .err{padding:7px 12px;font-size:11.5px;color:var(--danger);background:var(--danger-bg)}
@media (max-width:640px){.comm-pop-stack{right:12px;left:12px;bottom:90px}.comm-pop{width:auto}}
`;

function initials(name?: string | null): string {
  if (!name) return 'S';
  const parts = String(name).trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'S';
}

function whenText(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return String(iso).slice(0, 16).replace('T', ' ');
}

function PopupCard({ message }: { message: InboundCommunication }) {
  const { dismissPopup, markRead, reply } = useCommunications();
  const navigate = useNavigate();
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (replying) boxRef.current?.focus(); }, [replying]);

  const urgent = message.priority === 'urgent' || message.priority === 'high';
  const sensitive = message.confidentiality === 'restricted' || message.confidentiality === 'confidential';

  async function open() {
    setBusy(true);
    try {
      await markRead(message.id);
      navigate(`/information-management?tab=Communication&thread=${message.thread_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the conversation.');
    } finally { setBusy(false); }
  }

  async function send() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true); setError(null);
    try {
      await reply(message.id, body);
      setDraft(''); setReplying(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the reply.');
    } finally { setBusy(false); }
  }

  return (
    <div className={`comm-pop${urgent ? ' urgent' : ''}`} role="alert" aria-live="polite">
      <div className="hd">
        <span className="av" aria-hidden="true">{initials(message.sender_name)}</span>
        <span className="who">
          <strong>{message.sender_name || 'SECH_LIMS'}</strong>
          <small>{COMMUNICATION_TYPE_LABELS[message.communication_type as CommunicationType] ?? 'Message'} · {whenText(message.sent_at)}</small>
        </span>
        <button type="button" className="ic" aria-label="Dismiss — the message stays unread in your inbox"
          title="Dismiss — the message stays unread in your inbox" onClick={() => dismissPopup(message.id)}>
          <X size={15} />
        </button>
      </div>

      <div className="bd">
        <p className="sub">
          {urgent ? <AlertTriangle size={13} /> : <MessageSquare size={13} />}
          {message.subject}
        </p>
        <p className="prev">{message.preview || '—'}</p>
        <div className="chips">
          <span className="chip">{message.communication_number}</span>
          {urgent && <span className="chip urgent">{message.priority === 'urgent' ? 'Urgent' : 'High priority'}</span>}
          {sensitive && <span className="chip"><Lock size={9} style={{ verticalAlign: '-1px' }} /> {message.confidentiality}</span>}
          {message.requires_acknowledgement === 1 && (
            <span className="chip ack">
              Acknowledgement required{message.acknowledgement_due ? ` by ${String(message.acknowledgement_due).slice(0, 10)}` : ''}
            </span>
          )}
        </div>
      </div>

      {error && <div className="err">{error}</div>}

      {replying ? (
        <div className="rp">
          <textarea ref={boxRef} value={draft} placeholder="Type your reply…"
            aria-label="Your reply" onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
          <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} title="Send the reply (Ctrl+Enter)">
            <Send size={13} /> Send
          </button>
        </div>
      ) : (
        <div className="ft">
          <button type="button" className="primary" onClick={() => void open()} disabled={busy}>Open</button>
          <button type="button" onClick={() => setReplying(true)} disabled={busy}><CornerUpLeft size={13} /> Reply</button>
          <button type="button" onClick={() => void markRead(message.id).catch(() => dismissPopup(message.id))} disabled={busy}
            title="Mark it read without opening it">
            <CheckCircle2 size={13} /> Mark read
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The popup stack. Newest nearest the bottom of the screen, oldest above it,
 * and nothing at all when the person has no new messages.
 */
export default function CommunicationPopup() {
  const { popups, available } = useCommunications();
  if (!available || popups.length === 0) return null;
  return (
    <>
      <style>{POPUP_CSS}</style>
      <div className="comm-pop-stack" aria-label="New communications">
        {popups.map(message => <PopupCard key={message.id} message={message} />)}
      </div>
    </>
  );
}
