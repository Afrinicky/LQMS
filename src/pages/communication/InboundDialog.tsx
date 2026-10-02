import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Inbox, Search, X } from 'lucide-react';
import DetailModal from '../../components/ui/DetailModal';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import { errorText } from '../../services/api';
import {
  CHANNEL_LABELS, COMMUNICATION_CHANNELS, COMMUNICATION_CONFIDENTIALITY,
  COMMUNICATION_PRIORITIES, type CommunicationChannel,
} from '../../../shared/constants/communications';
import { post, pretty, sameAudience, useAudienceOptions, type AudiencePick } from './communicationData';

/**
 * Recording a communication that arrived from outside SECH_LIMS.
 *
 * A clinician telephones about a result, a supplier replies to a memo by
 * email, a ward sends a note on WhatsApp. None of those reach SECH_LIMS by
 * themselves, and until they are written down the conversation has a hole in
 * it: the outbound half is on the record and the answer is in somebody's
 * memory.
 *
 * This is how the inbound half gets on the record. Where an integration exists
 * the same endpoint is called by the integration and nobody types anything;
 * where one does not, a member of staff records what was received, from whom,
 * by what channel and when. Either way the message can be attached to the
 * conversation it answers, so one exchange stays one thread.
 */
export default function InboundDialog({ open, onClose, onRecorded }: {
  open: boolean;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const [form, setForm] = useState({
    senderExternalName: '', senderExternalAddress: '', channel: 'phone' as CommunicationChannel,
    subject: '', body: '', priority: 'normal', confidentiality: 'internal',
    externalReference: '', threadId: '',
  });
  const [picked, setPicked] = useState<AudiencePick[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { groups, loading } = useAudienceOptions(open);

  useEffect(() => {
    if (!open) return;
    setForm({
      senderExternalName: '', senderExternalAddress: '', channel: 'phone',
      subject: '', body: '', priority: 'normal', confidentiality: 'internal',
      externalReference: '', threadId: '',
    });
    setPicked([]); setSearch(''); setError(null); setNotice(null);
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map(g => ({ ...g, items: g.items.filter(i => `${i.label} ${i.detail ?? ''}`.toLowerCase().includes(q)) }))
      .filter(g => g.items.length > 0);
  }, [groups, search]);

  function toggle(option: { kind: string; ref: string | null; label: string }) {
    setPicked(prev => prev.some(p => sameAudience(p, option))
      ? prev.filter(p => !sameAudience(p, option))
      : [...prev, { kind: option.kind, ref: option.ref, label: option.label }]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const created = await post<{ communicationNumber: string }>('/communications/inbound', {
        ...form,
        threadId: form.threadId || null,
        audiences: picked,
      });
      setNotice(`Recorded as ${created.communicationNumber}. It is in the Communication Log and in the recipients' inboxes.`);
      onRecorded();
      setForm(f => ({ ...f, subject: '', body: '', externalReference: '' }));
    } catch (err) { setError(errorText(err) || 'The communication could not be recorded.'); }
    finally { setBusy(false); }
  }

  return (
    <DetailModal open={open} onClose={onClose} width="wide"
      title="Record an inbound communication"
      subtitle="What was received from outside SECH_LIMS, from whom, and by what channel.">
      <form className="comm-compose" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}

        <Notice kind="info">
          This records what was received. SECH_LIMS does not read external channels itself, so the log will show
          the communication as manually recorded, with your name against it.
        </Notice>

        <div className="cc-grid">
          <label>Received from
            <TextField value={form.senderExternalName} onValue={v => setForm({ ...form, senderExternalName: v })}
              required placeholder="Who sent it — a person, a ward, an organisation" />
          </label>
          <label>Their address or number
            <TextField value={form.senderExternalAddress} onValue={v => setForm({ ...form, senderExternalAddress: v })}
              placeholder="Email, telephone, handle — optional" />
          </label>
          <label>Channel
            <select value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value as CommunicationChannel })}>
              {COMMUNICATION_CHANNELS.map(c => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </select>
          </label>
          <label>Their reference
            <TextField value={form.externalReference} onValue={v => setForm({ ...form, externalReference: v })}
              placeholder="Optional message id or receipt" />
          </label>
          <label>Priority
            <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
              {COMMUNICATION_PRIORITIES.map(p => <option key={p} value={p}>{pretty(p)}</option>)}
            </select>
          </label>
          <label>Confidentiality
            <select value={form.confidentiality} onChange={e => setForm({ ...form, confidentiality: e.target.value })}>
              {COMMUNICATION_CONFIDENTIALITY.map(c => <option key={c} value={c}>{pretty(c)}</option>)}
            </select>
          </label>
          <label>Continue conversation (thread id)
            <TextField value={form.threadId} onValue={v => setForm({ ...form, threadId: v })}
              placeholder="Optional — leave blank to start a new one" />
          </label>
        </div>

        <label className="cc-wide">Subject
          <TextField value={form.subject} onValue={v => setForm({ ...form, subject: v })} required
            placeholder="What it was about" />
        </label>
        <label className="cc-wide">What was received
          <TextField as="textarea" rows={6} value={form.body} onValue={v => setForm({ ...form, body: v })} required
            placeholder="The message as received, or a faithful account of what was said." />
        </label>

        <section className="cc-aud">
          <header><h4><Inbox size={14} /> Who must act on it</h4></header>
          <p className="cc-hint">Leave empty and it is recorded against you.</p>
          {picked.length > 0 && (
            <div className="cc-chips">
              {picked.map(p => (
                <button key={`${p.kind}:${p.ref}`} type="button" className="cc-chip" title="Remove" onClick={() => toggle(p)}>
                  {p.label} <X size={11} />
                </button>
              ))}
            </div>
          )}
          <div className="cc-search">
            <Search size={13} />
            <TextField value={search} onValue={setSearch} placeholder="Search people, units, audiences…" aria-label="Search audiences" />
          </div>
          <div className="cc-aud-list">
            {loading && <p className="cc-hint">Loading audiences…</p>}
            {filtered.map(group => (
              <div key={group.title} className="cc-aud-group">
                <h5>{group.title}</h5>
                <ul>
                  {group.items.slice(0, search ? 40 : 8).map(item => {
                    const on = picked.some(p => sameAudience(p, item));
                    return (
                      <li key={`${item.kind}:${item.ref}`}>
                        <button type="button" className={on ? 'on' : ''} onClick={() => toggle(item)}>
                          <span className="tick">{on && <Check size={11} />}</span>
                          <span className="nm">{item.label}</span>
                          {item.detail && <span className="dt">{item.detail}</span>}
                          <span className="ct">{item.recipientCount}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <div className="cc-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="submit" disabled={busy}>Record it</button>
        </div>
      </form>
    </DetailModal>
  );
}
