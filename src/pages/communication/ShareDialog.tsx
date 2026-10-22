import { useEffect, useState, type FormEvent } from 'react';
import { Copy, Download, ExternalLink, FileText, Printer, Share2 } from 'lucide-react';
import DetailModal from '../../components/ui/DetailModal';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import { API_BASE, api, errorText, getToken } from '../../services/api';
import {
  CHANNEL_LABELS, COMMUNICATION_CHANNELS, SHARE_FORMATS, SHARE_FORMAT_LABELS,
  DISPATCH_METHOD_HINTS, channelIsIntegrated, confidentialityIsSensitive,
  type CommunicationChannel, type ShareFormat,
} from '../../../shared/constants/communications';
import type { Communication } from '../../../shared/types/api';
import { post } from './communicationData';

/**
 * Preparing a communication for somewhere SECH_LIMS cannot reach.
 *
 * This dialog is where the system's honesty about external channels lives. It
 * does two separate things and keeps them visibly separate:
 *
 *   1. It PREPARES a copy — print or PDF, a Word file, plain text, or an image
 *      of the sheet — using the same renderer that produced the memo, so what
 *      leaves the building is what was approved.
 *   2. It RECORDS that the copy was shared through a named channel, by whom,
 *      and to whom.
 *
 * What it never does is claim a delivery. WhatsApp, Telegram, SMS and email
 * have no integration here; the log says "prepared and shared", names the
 * member of staff who did it, and leaves delivery and read confirmation blank,
 * because nothing in SECH_LIMS knows them. If an integration is added later,
 * the same record gains a system dispatch alongside this one.
 */
export default function ShareDialog({ communication, onClose, onShared }: {
  communication: Communication | null;
  onClose: () => void;
  onShared: () => void;
}) {
  const open = Boolean(communication);
  const [channel, setChannel] = useState<CommunicationChannel>('whatsapp');
  const [format, setFormat] = useState<ShareFormat>('pdf');
  const [recipientLabel, setRecipientLabel] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChannel('whatsapp'); setFormat('pdf'); setRecipientLabel(''); setReference('');
    setNotes(''); setConfirmed(false); setJustification(''); setError(null); setNotice(null); setText(null);
  }, [open, communication?.id]);

  if (!communication) return null;
  const sensitive = confidentialityIsSensitive(communication.confidentiality);
  const integrated = channelIsIntegrated(channel);

  function openPrintSheet() {
    const token = getToken();
    // The print sheet is a page, not an API call, so it is opened with a
    // one-time window rather than fetched: the browser's own print dialog is
    // what turns it into a PDF, which is the only PDF writer every machine in
    // the laboratory is guaranteed to have.
    const url = `${API_BASE}/communications/${communication.id}/print`;
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      .then(async res => {
        if (!res.ok) throw new Error('The printable copy could not be prepared.');
        const html = await res.text();
        const win = window.open('', '_blank');
        if (!win) throw new Error('Allow pop-ups for SECH_LIMS so the printable copy can open.');
        win.document.write(html);
        win.document.close();
        setNotice('Printable copy opened. Choose a printer, or “Save as PDF” to produce the file.');
        onShared();
      })
      .catch(e => setError(errorText(e)));
  }

  async function downloadWord() {
    setBusy(true); setError(null);
    try {
      // The export endpoint builds the file and records it against a dispatch;
      // the communication's own download route then serves it, so preparing a
      // memo needs no rights over the document library.
      const built = await api<{ fileId: number; originalName: string }>(`/communications/${communication.id}/export/docx`);
      const token = getToken();
      const download = await fetch(`${API_BASE}/communications/${communication.id}/exports/${built.fileId}/raw`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!download.ok) throw new Error('The Word file was built but could not be downloaded. It is recorded against the communication.');
      const blob = await download.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = built.originalName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice(`Word file prepared: ${built.originalName}.`);
      onShared();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function loadText() {
    setBusy(true); setError(null);
    try {
      const payload = await api<{ text: string }>(`/communications/${communication.id}/render.txt`);
      setText(payload.text);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function copyText() {
    try {
      const payload = text ?? (await api<{ text: string }>(`/communications/${communication.id}/render.txt`)).text;
      setText(payload);
      await navigator.clipboard.writeText(payload);
      setNotice('The communication has been copied as plain text. Paste it into the channel you are using, then record the share below.');
    } catch (e) { setError(errorText(e) || 'The text could not be copied. Select it from the box and copy it by hand.'); }
  }

  async function recordShare(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await post<{ message: string }>(`/communications/${communication.id}/share`, {
        channel,
        shareFormat: format,
        dispatchMethod: integrated ? 'system' : 'prepared',
        recipientLabel: recipientLabel || null,
        externalReference: reference || null,
        notes: notes || null,
        sensitiveReleaseConfirmed: confirmed,
        sensitiveReleaseJustification: justification || null,
      });
      setNotice(result.message);
      onShared();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <DetailModal open={open} onClose={onClose} width="narrow"
      title="Prepare and share"
      subtitle={`${communication.communication_number} — ${communication.subject}`}>
      <div className="comm-share">
        {error && <Notice kind="error">{error}</Notice>}
        {notice && <Notice kind="success">{notice}</Notice>}

        <section>
          <h4>1 — Prepare the copy</h4>
          <p className="cc-hint">
            Every copy is produced from the same approved content, so what you share is what the record says.
          </p>
          <div className="cs-formats">
            <button type="button" onClick={openPrintSheet} disabled={busy}>
              <Printer size={14} /> Print / Save as PDF
            </button>
            <button type="button" onClick={() => void downloadWord()} disabled={busy}>
              <FileText size={14} /> Word document
            </button>
            <button type="button" onClick={() => void copyText()} disabled={busy}>
              <Copy size={14} /> Copy as text
            </button>
            <button type="button" onClick={() => void loadText()} disabled={busy}>
              <Download size={14} /> Show plain text
            </button>
          </div>
          {text && (
            <label className="cc-wide">Plain text
              <textarea readOnly rows={8} value={text} aria-label="The communication as plain text" />
            </label>
          )}
          <p className="cc-hint">
            For an image copy, open the printable sheet and use your device&rsquo;s screenshot or
            &ldquo;save as image&rdquo; function, then record the share below as JPG.
          </p>
        </section>

        <form onSubmit={recordShare}>
          <h4>2 — Record how it was shared</h4>
          <div className="cc-grid">
            <label>Channel
              <select value={channel} onChange={e => setChannel(e.target.value as CommunicationChannel)}>
                {COMMUNICATION_CHANNELS.map(c => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
              </select>
            </label>
            <label>Format
              <select value={format} onChange={e => setFormat(e.target.value as ShareFormat)}>
                {SHARE_FORMATS.map(f => <option key={f} value={f}>{SHARE_FORMAT_LABELS[f]}</option>)}
              </select>
            </label>
            <label>Shared with
              <TextField value={recipientLabel} onValue={setRecipientLabel}
                placeholder="e.g. Ward 3 sister, +233…, group name" />
            </label>
            <label>Their reference
              <TextField value={reference} onValue={setReference} placeholder="Optional message id, ticket, receipt" />
            </label>
            <label className="cc-wide">Notes
              <TextField as="textarea" rows={2} value={notes} onValue={setNotes}
                placeholder="Anything the record should say about this dispatch." />
            </label>
          </div>

          <Notice kind="info">{DISPATCH_METHOD_HINTS[integrated ? 'system' : 'prepared']}</Notice>

          {sensitive && (
            <div className="cs-release">
              <p>
                <strong>This communication is marked {communication.confidentiality}.</strong> Confirm the release
                and record why it is leaving SECH_LIMS. Both are stored on the dispatch record.
              </p>
              <label className="cc-check">
                <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                <span>I confirm this release is authorised.</span>
              </label>
              <label className="cc-wide">Reason for the release
                <TextField as="textarea" rows={2} value={justification} onValue={setJustification}
                  placeholder="Why this content may be shared outside SECH_LIMS, and on whose authority." />
              </label>
            </div>
          )}

          <div className="cc-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>Close</button>
            <button type="submit" disabled={busy || (sensitive && (!confirmed || !justification.trim()))}>
              <Share2 size={14} /> Record the share
            </button>
          </div>
        </form>

        <p className="cc-hint">
          <ExternalLink size={11} /> Where SECH_LIMS gains a direct integration with a channel, a system dispatch
          will be recorded alongside this one and delivery will be reported from the channel itself.
        </p>
      </div>
    </DetailModal>
  );
}
