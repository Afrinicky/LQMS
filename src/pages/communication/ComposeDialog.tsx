import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Lock, Paperclip, Search, Send, Users, X } from 'lucide-react';
import DetailModal from '../../components/ui/DetailModal';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import { api, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  COMPOSABLE_TYPES, COMMUNICATION_CHANNELS, COMMUNICATION_PRIORITIES,
  COMMUNICATION_CONFIDENTIALITY, COMMUNICATION_TYPE_LABELS, CHANNEL_LABELS,
  channelIsIntegrated, confidentialityIsSensitive, COMM_FEATURE,
  type CommunicationType, type CommunicationChannel,
} from '../../../shared/constants/communications';
import type { CommunicationTemplate, Staff } from '../../../shared/types/api';
import { pretty, useAudienceOptions, sameAudience, post, type AudiencePick } from './communicationData';

/**
 * Composing a communication.
 *
 * One dialog for a message, a memo, a notice and an acknowledgement request,
 * because they differ in three fields and nothing else — and three nearly
 * identical forms is how three nearly identical bugs get fixed one at a time.
 * The type chosen decides what the dialog shows:
 *
 *   · a memo or a notice gains the TO/FROM block that goes on the printed
 *     sheet, a reference, a signatory, and the option to require approval;
 *   · a channel SECH_LIMS cannot deliver on says so in plain words before the
 *     send, rather than reporting a delivery that never happened;
 *   · a restricted or confidential selection warns about external sharing
 *     before anything is written, not after it has gone.
 *
 * Attachments are uploaded after the record exists but before it is sent, so a
 * message and its attachments reach the recipient together.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onSent: () => void;
  templates: CommunicationTemplate[];
  staff: Staff[];
  /**
   * Narrows the type list — the memo workspace offers memos and notices only.
   * The first entry is the one the dialog opens on.
   */
  types?: CommunicationType[];
  /** Continue a conversation rather than starting one. */
  threadId?: number | null;
  /** Prefill the recipient list, e.g. when writing to one named person. */
  initialAudiences?: AudiencePick[];
  initialSubject?: string;
};

const EMPTY = {
  type: 'direct_message' as CommunicationType,
  subject: '', body: '', channel: 'in_app' as CommunicationChannel,
  priority: 'normal', confidentiality: 'internal',
  requiresAcknowledgement: false, acknowledgementDue: '',
  requiresApproval: false,
  memoToText: '', memoFromText: '', memoDate: '', memoReference: '',
  signatoryStaffId: '', templateCode: '',
};

export default function ComposeDialog({
  open, onClose, onSent, templates, staff, types, threadId, initialAudiences, initialSubject,
}: Props) {
  const { can } = usePermissions();
  const defaultType = types?.[0] ?? EMPTY.type;
  const [form, setForm] = useState({ ...EMPTY, type: defaultType });
  const [picked, setPicked] = useState<AudiencePick[]>(initialAudiences ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reach, setReach] = useState<{ total: number; inApp: number; external: number } | null>(null);
  const { groups, loading: loadingAudiences } = useAudienceOptions(open);

  // A fresh dialog every time it opens: a half-written memo left in state and
  // reopened days later is how the wrong audience gets the wrong notice.
  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, type: defaultType, subject: initialSubject ?? '' });
    setPicked(initialAudiences ?? []);
    setFiles([]); setSearch(''); setError(null); setNotice(null); setReach(null);
    // initialAudiences is written inline at the call site, so depending on it
    // would reset the form on every render of the page behind the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultType, initialSubject]);

  // How many people the current selection reaches, asked of the server as the
  // selection changes. A sender about to address forty people should see that
  // before they press send, not afterwards.
  useEffect(() => {
    if (!open || picked.length === 0) { setReach(null); return; }
    let cancelled = false;
    post<{ total: number; inApp: number; external: number }>('/communications/resolve-audiences', { audiences: picked })
      .then(r => { if (!cancelled) setReach(r); })
      .catch(() => { if (!cancelled) setReach(null); });
    return () => { cancelled = true; };
  }, [open, picked]);

  const isFormal = form.type === 'memo' || form.type === 'notice';
  // A type is offered only where the person may actually create it, so the
  // dialog never invites somebody to write something the save will refuse.
  const allowedTypes = (types ?? COMPOSABLE_TYPES).filter(t => {
    const formal = t === 'memo' || t === 'notice';
    return can(formal ? COMM_FEATURE.memos : COMM_FEATURE.messages, 'create');
  });
  const mayCreateChosen = can(isFormal ? COMM_FEATURE.memos : COMM_FEATURE.messages, 'create');
  const sensitive = confidentialityIsSensitive(form.confidentiality);
  const offChannel = !channelIsIntegrated(form.channel);

  const filteredGroups = useMemo(() => {
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

  function applyTemplate(code: string) {
    const template = templates.find(t => t.template_code === code);
    setForm(f => ({ ...f, templateCode: code }));
    if (!template) return;
    setForm(f => ({
      ...f,
      type: ((types && !types.includes(template.communication_type as CommunicationType))
        ? defaultType : template.communication_type) as CommunicationType,
      subject: template.subject,
      body: template.body,
      channel: (template.default_channel ?? 'in_app') as CommunicationChannel,
      confidentiality: template.confidentiality ?? 'internal',
      requiresApproval: template.requires_approval === 1,
      requiresAcknowledgement: template.requires_acknowledgement === 1,
    }));
    if (template.default_audience_kind) {
      setPicked([{
        kind: template.default_audience_kind,
        ref: template.default_audience_ref ?? null,
        label: template.default_audience_ref ?? pretty(template.default_audience_kind),
      }]);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    if (picked.length === 0) { setError('Choose at least one recipient or audience.'); return; }
    setBusy(true);
    try {
      // Created first, attachments second, sent last — so nothing is delivered
      // before what travels with it is in place.
      const created = await post<{ id: number; communicationNumber: string; status: string }>('/communications', {
        type: form.type,
        subject: form.subject,
        body: form.body,
        bodyFormat: 'text',
        direction: offChannel ? 'outbound' : 'internal',
        channel: form.channel,
        priority: form.priority,
        confidentiality: form.confidentiality,
        audiences: picked,
        threadId: threadId ?? null,
        requiresApproval: isFormal && form.requiresApproval,
        requiresAcknowledgement: form.requiresAcknowledgement,
        acknowledgementDue: form.acknowledgementDue || null,
        memoToText: isFormal ? (form.memoToText || picked.map(p => p.label).join('; ')) : null,
        memoFromText: isFormal ? form.memoFromText || null : null,
        memoDate: isFormal ? form.memoDate || null : null,
        memoReference: isFormal ? form.memoReference || null : null,
        signatoryStaffId: form.signatoryStaffId || null,
        send: false,
      });

      for (const file of files) {
        const payload = new FormData();
        payload.append('file', file);
        await api(`/communications/${created.id}/attachments`, { method: 'POST', body: payload });
      }

      if (isFormal && form.requiresApproval) {
        await post(`/communications/${created.id}/submit-approval`, {});
        setNotice(`${created.communicationNumber} is ready and has gone for approval. It will be dispatched once it is released.`);
      } else {
        const sent = await post<{ delivered: number; prepared: number }>(`/communications/${created.id}/send`, { channel: form.channel });
        const tail = sent.prepared
          ? `; ${sent.prepared} have no SECH_LIMS account and need a copy by another channel.`
          : '.';
        setNotice(offChannel
          ? `${created.communicationNumber} sent. Delivered in-app to ${sent.delivered} recipient(s)${tail} A copy is prepared for ${CHANNEL_LABELS[form.channel]} — share it and the log will show it as prepared, not delivered.`
          : `${created.communicationNumber} sent. Delivered in-app to ${sent.delivered} recipient(s)${tail}`);
      }
      onSent();
      setForm({ ...EMPTY, type: defaultType });
      setPicked([]); setFiles([]);
    } catch (e) {
      setError(errorText(e) || 'The communication could not be sent.');
    } finally { setBusy(false); }
  }

  return (
    <DetailModal
      open={open}
      onClose={onClose}
      title={types?.length === 1 ? `New ${COMMUNICATION_TYPE_LABELS[types[0]].toLowerCase()}` : types ? 'New memo or notice' : 'New communication'}
      subtitle="Everything sent from here is numbered, addressed and recorded in the Communication Log."
      width="wide"
    >
      <form className="comm-compose" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}
        {allowedTypes.length === 0 && (
          <Notice kind="warn">You may read communications here but not compose one.</Notice>
        )}

        <div className="cc-grid">
          <label>Type
            <select value={form.type} disabled={allowedTypes.length <= 1}
              onChange={e => setForm({ ...form, type: e.target.value as CommunicationType })}>
              {allowedTypes.map(t => <option key={t} value={t}>{COMMUNICATION_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label>Template
            <select value={form.templateCode} onChange={e => applyTemplate(e.target.value)}>
              <option value="">— none —</option>
              {templates.filter(t => !types || types.includes(t.communication_type as CommunicationType))
                .map(t => <option key={t.template_code} value={t.template_code}>{t.template_name}</option>)}
            </select>
          </label>
          <label>Channel
            <select value={form.channel} onChange={e => setForm({ ...form, channel: e.target.value as CommunicationChannel })}>
              {COMMUNICATION_CHANNELS.map(c => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </select>
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
        </div>

        {offChannel && (
          <Notice kind="warn">
            SECH_LIMS has no direct integration with {CHANNEL_LABELS[form.channel]}. Recipients who hold a
            SECH_LIMS account will still receive it in-app; for that channel the log will record the copy as
            <strong> prepared</strong>, and claim no delivery or read confirmation.
          </Notice>
        )}
        {sensitive && (
          <Notice kind="warn">
            <Lock size={12} /> Marked {form.confidentiality}. Sharing it outside SECH_LIMS will require the release
            to be confirmed and a reason recorded.
          </Notice>
        )}

        {/* ---- Recipients ---- */}
        <section className="cc-aud">
          <header>
            <h4><Users size={14} /> Recipients and audience</h4>
            {reach && (
              <span className="cc-reach">
                Reaches <strong>{reach.total}</strong> recipient{reach.total === 1 ? '' : 's'}
                {reach.external > 0 && <> · {reach.external} with no SECH_LIMS account</>}
              </span>
            )}
          </header>

          {picked.length > 0 && (
            <div className="cc-chips">
              {picked.map(p => (
                <button key={`${p.kind}:${p.ref}`} type="button" className="cc-chip"
                  title="Remove this recipient" onClick={() => toggle(p)}>
                  {p.label} <X size={11} />
                </button>
              ))}
            </div>
          )}

          <div className="cc-search">
            <Search size={13} />
            <TextField value={search} onValue={setSearch} placeholder="Search people, units, departments, audiences…"
              aria-label="Search audiences" />
          </div>

          <div className="cc-aud-list">
            {loadingAudiences && <p className="cc-hint">Loading audiences…</p>}
            {!loadingAudiences && filteredGroups.length === 0 && <p className="cc-hint">Nothing matches that search.</p>}
            {filteredGroups.map(group => (
              <div key={group.title} className="cc-aud-group">
                <h5>{group.title}</h5>
                <ul>
                  {group.items.slice(0, search ? 40 : 12).map(item => {
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
                {!search && group.items.length > 12 && <p className="cc-hint">{group.items.length - 12} more — use the search box.</p>}
              </div>
            ))}
          </div>
        </section>

        {/* ---- The message ---- */}
        <label className="cc-wide">Subject
          <TextField value={form.subject} onValue={v => setForm({ ...form, subject: v })} required
            placeholder="What this communication is about" />
        </label>
        <label className="cc-wide">Message
          <TextField as="textarea" rows={8} value={form.body} onValue={v => setForm({ ...form, body: v })} required
            placeholder="Write the communication here." />
        </label>

        {/* ---- The formal memo block ---- */}
        {isFormal && (
          <section className="cc-memo">
            <h4>Memo heading and release</h4>
            <div className="cc-grid">
              <label>TO (as printed)
                <TextField value={form.memoToText} onValue={v => setForm({ ...form, memoToText: v })}
                  placeholder={picked.map(p => p.label).join('; ') || 'Taken from the audience above'} />
              </label>
              <label>FROM (as printed)
                <TextField value={form.memoFromText} onValue={v => setForm({ ...form, memoFromText: v })}
                  placeholder="e.g. Quality Manager" />
              </label>
              <label>Memo date<input type="date" value={form.memoDate} onChange={e => setForm({ ...form, memoDate: e.target.value })} /></label>
              <label>Your reference
                <TextField value={form.memoReference} onValue={v => setForm({ ...form, memoReference: v })}
                  placeholder="Optional external reference" />
              </label>
              <label>Signatory
                <select value={form.signatoryStaffId} onChange={e => setForm({ ...form, signatoryStaffId: e.target.value })}>
                  <option value="">— the sender —</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                </select>
              </label>
              <label className="cc-check">
                <input type="checkbox" checked={form.requiresApproval}
                  onChange={e => setForm({ ...form, requiresApproval: e.target.checked })} />
                <span>Requires approval before it is dispatched</span>
              </label>
            </div>
          </section>
        )}

        <div className="cc-grid">
          <label className="cc-check">
            <input type="checkbox" checked={form.requiresAcknowledgement}
              onChange={e => setForm({ ...form, requiresAcknowledgement: e.target.checked })} />
            <span>Recipients must acknowledge</span>
          </label>
          {form.requiresAcknowledgement && (
            <label>Acknowledge by
              <input type="date" value={form.acknowledgementDue}
                onChange={e => setForm({ ...form, acknowledgementDue: e.target.value })} />
            </label>
          )}
          <label className="cc-file">
            <span><Paperclip size={13} /> Attachments</span>
            <input type="file" multiple onChange={e => setFiles(Array.from(e.target.files ?? []))} />
          </label>
        </div>
        {files.length > 0 && (
          <p className="cc-hint">{files.length} file{files.length === 1 ? '' : 's'} will be attached: {files.map(f => f.name).join(', ')}</p>
        )}

        <div className="cc-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button>
          {/* The right is read here as well as on the button that opens the
              dialog: a type nobody may create is not offered above, and a
              person with none of them is told so rather than being left to
              fill the form in and have the save refused. */}
          <button type="submit" disabled={busy || picked.length === 0 || !mayCreateChosen}>
            <Send size={14} /> {isFormal && form.requiresApproval ? 'Submit for approval' : 'Send'}
          </button>
        </div>
      </form>
    </DetailModal>
  );
}
