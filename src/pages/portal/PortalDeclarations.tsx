import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, FileSignature, Printer } from 'lucide-react';
import { API_BASE, getToken } from '../../services/api';
import { downloadFileById, titleCase, usePortal } from './portalData';
import type { MyDeclaration } from '../../../shared/types/api';

/**
 * My declarations — confidentiality, impartiality, conflict of interest and the
 * code of conduct, as they stand for this person.
 *
 * Two lists, because they answer two different questions: what still needs my
 * signature, and what have I already signed and might be asked to produce. The
 * second matters at assessment time, which is why every signed declaration can
 * be reopened and printed with the signature that was applied to it.
 */
const esc = (s?: string | null) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function signatureDataUrl(): Promise<string | null> {
  const token = getToken();
  const r = await fetch(`${API_BASE}/signatures/me/image`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) return null;
  const blob = await r.blob();
  return new Promise<string | null>(resolve => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(String(fr.result));
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}

export default function PortalDeclarations() {
  const navigate = useNavigate();
  const { declarations, profile, staff, hasSignature, setError } = usePortal();
  const [reading, setReading] = useState<MyDeclaration | null>(null);

  const name = staff?.full_name || profile?.user.fullName || '';

  async function print(d: MyDeclaration) {
    const sigImg = hasSignature ? await signatureDataUrl() : null;
    const sigBlock = sigImg
      ? `<img class="sigimg" src="${sigImg}" alt="signature" />`
      : d.signed_file_id
        ? '<span class="muted">signed copy on file</span>'
        : `<span class="signame">${esc(name)}</span>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title>
      <style>
        body { font-family: Georgia, 'Times New Roman', serif; color: #111; margin: 32px; line-height: 1.5; }
        h1 { font-size: 20px; margin: 0 0 2px; }
        .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
        .body { white-space: pre-wrap; font-size: 13.5px; margin: 16px 0 22px; }
        .ack { border-left: 3px solid #333; padding: 6px 12px; font-style: italic; margin: 18px 0; }
        .signblock { margin-top: 34px; }
        .sigimg { max-height: 46px; max-width: 200px; display: block; }
        .signame { font-family: 'Segoe Script', 'Brush Script MT', cursive; font-size: 20px; }
        .sigline { border-top: 1px solid #333; width: 260px; margin-top: 4px; padding-top: 4px; font-size: 12px; }
        .muted { color: #666; font-style: italic; }
        @media print { body { margin: 12mm; } }
      </style></head><body>
      <div class="meta">${esc(d.form_number || '')}</div>
      <h1>${esc(d.title)}</h1>
      <div class="meta">Version ${esc(d.version || '—')} · effective ${esc(d.effective_date || '—')}${d.issued_by ? ` · issued by ${esc(d.issued_by)}` : ''}</div>
      ${d.body_content ? `<div class="body">${esc(d.body_content)}</div>` : '<p class="muted">The declaration text was supplied as an attached file.</p>'}
      ${d.acknowledgement_statement ? `<div class="ack">${esc(d.acknowledgement_statement)}</div>` : ''}
      <div class="signblock">
        ${sigBlock}
        <div class="sigline">${esc(name)} — signed ${esc(d.signed_at ? String(d.signed_at).slice(0, 19).replace('T', ' ') : '')}</div>
      </div>
      <script>window.onload=function(){window.print();}</script>
      </body></html>`;
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { setError('Allow pop-ups to print the declaration.'); return; }
    w.document.write(html);
    w.document.close();
  }

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><FileSignature size={16} /> Awaiting your signature</h3>
            <p>A declaration is not in force until you have read and signed it. Each one opens where you sign it.</p>
          </div>
          {declarations.pending.length > 0 && <span className="pp-count crit">{declarations.pending.length}</span>}
        </div>
        {declarations.pending.length === 0 ? (
          <div className="pp-clear"><FileSignature size={18} /><span>You have signed everything asked of you.</span></div>
        ) : (
          <ul className="pt-list">
            {declarations.pending.map(d => (
              <li key={`p-${d.id}`} className="pt-row sev-warn">
                <span className="pt-rail warn" />
                <button type="button" className="pt-row-main"
                  onClick={() => navigate(`/organisation?tab=Code%20of%20Conduct&form=${d.id}`)}>
                  <span className="pt-row-title">{d.title}</span>
                  <span className="pt-row-meta">
                    <span className="badge">{titleCase(d.form_type)}</span>
                    <span>v{d.version || '—'}</span>
                    {d.effective_date && <span>effective {d.effective_date}</span>}
                  </span>
                </button>
                <div className="pt-row-side">
                  <button type="button" className="pt-open"
                    onClick={() => navigate(`/organisation?tab=Code%20of%20Conduct&form=${d.id}`)}>
                    Read &amp; sign <ArrowRight size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3>Signed by me</h3>
            <p>Your signed declarations, reopenable and printable — this is what an assessor asks to see.</p>
          </div>
          {declarations.signed.length > 0 && <span className="pp-count">{declarations.signed.length}</span>}
        </div>
        {declarations.signed.length === 0 ? (
          <p className="muted">You have not signed any declaration yet.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Declaration</th><th>Type</th><th>Signed</th><th /></tr></thead>
            <tbody>
              {declarations.signed.map(d => (
                <tr key={`s-${d.id}`}>
                  <td>{d.title}<div className="muted pr-sub">v{d.version || '—'}{d.form_number ? ` · ${d.form_number}` : ''}</div></td>
                  <td>{titleCase(d.form_type)}</td>
                  <td>{d.signed_at ? String(d.signed_at).slice(0, 10) : '—'}</td>
                  <td className="pr-actions-cell">
                    <button type="button" className="link-button" onClick={() => setReading(d)}>Open</button>
                    <button type="button" className="link-button" onClick={() => void print(d)}><Printer size={12} /> Print</button>
                    {d.signed_file_id && (
                      <button type="button" className="link-button"
                        onClick={() => downloadFileById(d.signed_file_id!, `signed-${d.form_number || d.id}`).catch(e => setError((e as Error).message))}>
                        Signed copy
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {reading && (
        <div className="doc-drawer-overlay" onClick={() => setReading(null)}>
          <div className="doc-drawer" onClick={e => e.stopPropagation()}>
            <div className="doc-drawer-panel">
              <div className="doc-drawer-head">
                <div>
                  <span className="hint">{titleCase(reading.form_type)}</span>
                  <h3>{reading.title}</h3>
                  <p className="muted">v{reading.version || '—'} · signed {reading.signed_at ? String(reading.signed_at).slice(0, 10) : '—'}</p>
                </div>
                <button className="drawer-close" type="button" onClick={() => setReading(null)}>×</button>
              </div>
              <div className="doc-drawer-body">
                {reading.body_content
                  ? <div className="pd-body">{reading.body_content}</div>
                  : <p className="muted">This declaration was issued as a form document.</p>}
                {reading.acknowledgement_statement && <p className="pd-ack">{reading.acknowledgement_statement}</p>}
                <div className="pr-btns">
                  <button type="button" onClick={() => void print(reading)}><Printer size={14} /> Print</button>
                  {reading.signed_file_id && (
                    <button type="button" className="secondary"
                      onClick={() => downloadFileById(reading.signed_file_id!, `signed-${reading.form_number || reading.id}`).catch(e => setError((e as Error).message))}>
                      Download signed copy
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
