import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Forward, Lock, Search, X } from 'lucide-react';
import DetailModal from '../../components/ui/DetailModal';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import { errorText } from '../../services/api';
import { confidentialityIsSensitive } from '../../../shared/constants/communications';
import type { Communication } from '../../../shared/types/api';
import { post, sameAudience, useAudienceOptions, type AudiencePick } from './communicationData';

/**
 * Forwarding a communication to somebody else.
 *
 * The original is quoted in full rather than summarised, and the forward is a
 * communication of its own with its own number: a memo passed on three times
 * leaves three records, and the Communication Log can show the chain. A
 * restricted or confidential communication cannot be forwarded by somebody who
 * does not hold the external-sharing right, and the server refuses it
 * regardless of what this dialog offers.
 */
export default function ForwardDialog({ message, onClose, onForwarded }: {
  message: Communication | null;
  onClose: () => void;
  onForwarded: () => void;
}) {
  const open = Boolean(message);
  const [picked, setPicked] = useState<AudiencePick[]>([]);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { groups, loading } = useAudienceOptions(open);

  useEffect(() => { if (open) { setPicked([]); setNote(''); setSearch(''); setError(null); } }, [open, message?.id]);

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
    if (!message || picked.length === 0) return;
    setBusy(true); setError(null);
    try {
      await post(`/communications/${message.id}/forward`, { audiences: picked, note });
      onForwarded();
      onClose();
    } catch (err) { setError(errorText(err) || 'The communication could not be forwarded.'); }
    finally { setBusy(false); }
  }

  if (!message) return null;

  return (
    <DetailModal open={open} onClose={onClose} width="narrow"
      title="Forward this communication"
      subtitle={`${message.communication_number} — ${message.subject}`}>
      <form className="comm-compose" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        {confidentialityIsSensitive(message.confidentiality) && (
          <Notice kind="warn">
            <Lock size={12} /> This communication is marked {message.confidentiality}. Forwarding it needs the
            external-sharing right, and the forward is recorded against your name.
          </Notice>
        )}

        <label className="cc-wide">Covering note
          <TextField as="textarea" rows={3} value={note} onValue={setNote}
            placeholder="Optional — why you are passing this on. The original is quoted below it in full." />
        </label>

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

        <div className="cc-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" disabled={busy || picked.length === 0}><Forward size={14} /> Forward</button>
        </div>
      </form>
    </DetailModal>
  );
}
