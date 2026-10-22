import { useEffect, useState } from 'react';
import { Activity, Loader2, Lock, Stethoscope } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { DIAGNOSTIC_LAYERS, DIAGNOSTIC_LAYER_LABELS } from '../../../shared/constants/middleware';
import { Note, Panel, StatusMark, when, type DiagnosticReport, type SectionProps } from './shared';

/**
 * Connection Diagnostics.
 *
 * Layered, because "failed" on its own has sent people to the wrong room for an
 * afternoon. Each layer can pass while the next fails, and the five facts that
 * get confused with one another are kept apart throughout: the device is
 * reachable, the connection is established, the message parsed, the message was
 * delivered, and the destination accepted it.
 *
 * Nothing here probes a protected endpoint. That row is answered from the
 * register and labelled as such.
 */
export default function MiddlewareDiagnostics({ links, destinations, onError }: SectionProps) {
  const [subject, setSubject] = useState<string>('system');
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(target: string) {
    setSubject(target);
    setBusy(true); onError(null);
    try {
      const path = target === 'system' ? '/middleware/diagnostics'
        : target.startsWith('link:') ? `/middleware/links/${target.slice(5)}/diagnostics`
        : `/middleware/destinations/${target.slice(5)}/diagnostics`;
      setReport(await api<DiagnosticReport>(path));
    } catch (e) { onError(errorText(e)); setReport(null); }
    finally { setBusy(false); }
  }

  useEffect(() => { void run('system'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const byLayer = DIAGNOSTIC_LAYERS
    .map(layer => ({ layer, findings: (report?.findings ?? []).filter(f => f.layer === layer) }))
    .filter(group => group.findings.length);

  return (
    <div className="mw-split">
      <aside className="mw-side">
        <Panel title="What to diagnose" subtitle="One subject at a time.">
          <ul className="mw-list is-compact">
            <li className={subject === 'system' ? 'is-selected' : ''}>
              <button type="button" className="mw-list-button" onClick={() => void run('system')}>
                <span className="mw-list-main"><strong><Activity size={11} /> Whole module</strong></span>
              </button>
            </li>
          </ul>
          <h5 className="mw-side-head">Analyser links</h5>
          <ul className="mw-list is-compact">
            {links.map(link => (
              <li key={`l${link.id}`} className={subject === `link:${link.id}` ? 'is-selected' : ''}>
                <button type="button" className="mw-list-button" onClick={() => void run(`link:${link.id}`)}>
                  <span className="mw-list-main">
                    <strong>{link.name}</strong>
                    <span className="mw-sub">{link.state}</span>
                  </span>
                  {link.engine_protected && <span className="mw-chip t-lock"><Lock size={10} /></span>}
                </button>
              </li>
            ))}
            {!links.length && <li><span className="mw-sub">No analyser link is configured.</span></li>}
          </ul>
          <h5 className="mw-side-head">Destinations</h5>
          <ul className="mw-list is-compact">
            {destinations.map(destination => (
              <li key={`d${destination.id}`} className={subject === `dest:${destination.id}` ? 'is-selected' : ''}>
                <button type="button" className="mw-list-button" onClick={() => void run(`dest:${destination.id}`)}>
                  <span className="mw-list-main">
                    <strong>{destination.name}</strong>
                    <span className="mw-sub">{destination.state}</span>
                  </span>
                  {destination.is_protected ? <span className="mw-chip t-lock"><Lock size={10} /></span> : null}
                </button>
              </li>
            ))}
            {!destinations.length && <li><span className="mw-sub">No destination is configured.</span></li>}
          </ul>
        </Panel>
      </aside>

      <div className="mw-main">
        <Panel
          title={report ? report.subject : 'Diagnostics'}
          subtitle={report ? report.summary : 'Running the checks.'}
          tone={report?.status === 'fail' ? 'crit' : report?.status === 'warn' ? 'warn' : undefined}
          actions={
            <button type="button" className="pq-link" disabled={busy} onClick={() => void run(subject)}>
              {busy ? <Loader2 size={12} className="pd-spin" /> : <Stethoscope size={12} />} Re-run
            </button>
          }
        >
          {report && <Note>Checked {when(report.at)}.</Note>}
          {!byLayer.length && !busy && <Note>Nothing could be checked for this subject.</Note>}
        </Panel>

        {byLayer.map(group => (
          <Panel key={group.layer} title={DIAGNOSTIC_LAYER_LABELS[group.layer]}>
            <table className="data-table mw-table">
              <thead>
                <tr><th>Check</th><th>Observed</th><th>Measured</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {group.findings.map(finding => (
                  <tr key={finding.key} className={`mw-row-${finding.status}`}>
                    <td><strong>{finding.label}</strong></td>
                    <td>
                      {finding.detail}
                      {finding.remedy && <span className="mw-sub t-remedy">{finding.remedy}</span>}
                    </td>
                    <td className="num">{finding.measuredMs != null ? `${finding.measuredMs} ms` : '—'}</td>
                    <td><StatusMark status={finding.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}

        <Panel title="What each result does and does not establish">
          <ul className="mw-bullets">
            <li><strong>Reachable</strong> — something answered at that address and port. It does not mean it understands this protocol.</li>
            <li><strong>Established</strong> — a session opened and was held. It does not mean a message completed.</li>
            <li><strong>Parsed</strong> — bytes became records became results. It does not mean the identifiers or mappings are right.</li>
            <li><strong>Delivered</strong> — the message left this host. Against a destination with no acknowledgement policy, that is all it means.</li>
            <li><strong>Accepted</strong> — the receiving system said so in its own protocol. Only this establishes that the result is filed.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
