import { FileBadge } from 'lucide-react';
import { downloadFileById, isOverdue, titleCase, usePortal } from './portalData';

/**
 * My documents — the certificates, licences and records on this person's file.
 *
 * A member of staff is the one who has to renew a practising licence, so they
 * are the one who should be able to see when it lapses. Expiry that has passed
 * is called out in red rather than left as a date to work out.
 */
export default function PortalDocuments() {
  const { documents, setError } = usePortal();
  const expiring = documents.filter(d => isOverdue(d.expiry_date)).length;

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><FileBadge size={16} /> My documents</h3>
            <p>
              Everything held on your staff file. To add or correct one, give it to Personnel
              Management — a staff file is a controlled record, so it is not edited from here.
            </p>
          </div>
          {documents.length > 0 && <span className={`pp-count${expiring ? ' crit' : ''}`}>{documents.length}</span>}
        </div>

        {expiring > 0 && (
          <p className="pp-inline-warn">
            {expiring === 1 ? 'One document has expired' : `${expiring} documents have expired`} — renew and
            hand the new copy to Personnel Management.
          </p>
        )}

        {documents.length === 0 ? (
          <p className="muted">No documents are on your file yet.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Type</th><th>Title</th><th>Issued</th><th>Expires</th><th>Verified</th><th /></tr></thead>
            <tbody>
              {documents.map(d => (
                <tr key={d.id}>
                  <td>{titleCase(d.document_type)}</td>
                  <td>{d.title}</td>
                  <td>{d.issue_date || '—'}</td>
                  <td className={isOverdue(d.expiry_date) ? 'pr-expired' : ''}>{d.expiry_date || 'No expiry'}</td>
                  <td>{d.verification_status ? <span className={`badge ${d.verification_status}`}>{d.verification_status}</span> : '—'}</td>
                  <td>
                    {d.file_id
                      ? <button type="button" className="link-button"
                          onClick={() => downloadFileById(d.file_id!, d.file_name || d.title).catch(e => setError((e as Error).message))}>
                          Download
                        </button>
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
