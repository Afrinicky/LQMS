import { useCallback, useEffect, useState } from 'react';
import { Bot, Check, Loader2, Send, ShieldAlert, X } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { EVIDENCE_GRADE_LABELS, DENNIS_ACTION_STATE_LABELS } from '../../../shared/constants/middleware';
import { Facts, Field, Note, Panel, Pick, StatusMark, when, type SectionProps } from './shared';

/**
 * Dennis AI Assistant, for the middleware.
 *
 * The same Dennis as everywhere else in SECHLIMS, standing on different ground:
 * the diagnostics, the queue, the parser's actual output and the configuration
 * of interfaces known to work here.
 *
 * The order is what makes it safe, and the screen shows that order rather than
 * hiding it. Deterministic tools gather the evidence FIRST; the model explains
 * that evidence; a proposal is built by code and validated by code again before
 * anybody sees it. With no model configured this still works — the findings are
 * measurements, and the answer says it was composed without one.
 *
 * Dennis proposes. It never applies, activates, routes a result or touches a
 * protected connection: approval is a human action and applying a proposal goes
 * through the same permission check, validation and configuration version as
 * any other change.
 */
type Answer = {
  actionId: number | null;
  tool: string;
  findings: Array<{ label: string; detail: string; grade: string }>;
  answer: string;
  grade: string;
  confidence: string;
  proposal: Record<string, unknown> | null;
  validation: { ok: boolean; errors: string[]; warnings: string[] } | null;
  state: string;
  blockedReason: string | null;
  composedBy: string;
  notice: string;
};

type Action = {
  id: number; at: string; tool: string; intent: string | null;
  subject_kind: string; subject_id: number | null;
  answer: string; evidence_grade: string; confidence: string;
  proposal: Record<string, unknown> | null;
  validation: { ok: boolean; errors: string[]; warnings: string[] } | null;
  state: string; blocked_reason: string | null;
  asked_by: string | null; reviewed_by_name: string | null; reviewed_at: string | null; review_note: string | null;
  applied_version_id: number | null; online_used: number; redaction_applied: number;
};

export default function MiddlewareDennis({ reference, links, destinations, canApproveDennis, reload, onError, onNotice }: SectionProps) {
  const [tool, setTool] = useState('summarise_health');
  const [question, setQuestion] = useState('');
  const [linkId, setLinkId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [sample, setSample] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await apiRead<{ actions: Action[] }>('/middleware/dennis?limit=30', { actions: [] });
    setActions(data.actions);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function ask() {
    setBusy('ask'); onError(null);
    try {
      const result = await api<Answer>('/middleware/dennis/ask', {
        method: 'POST',
        body: JSON.stringify({
          tool, question: question || null,
          linkId: linkId || null, destinationId: destinationId || null,
          sample: sample || null,
          intent: destinationId ? { } : null,
        }),
      });
      setAnswer(result);
      await load();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function review(actionId: number, decision: 'approved' | 'rejected') {
    const note = decision === 'rejected'
      ? window.prompt('Why is this recommendation being rejected?') ?? ''
      : window.prompt('Any note for the record?') ?? '';
    setBusy(`a${actionId}`); onError(null);
    try {
      const outcome = await api<{ note: string }>(`/middleware/dennis/${actionId}/review`, {
        method: 'POST', body: JSON.stringify({ decision, note: note || null }),
      });
      onNotice(outcome.note);
      await load();
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  const needsSample = tool === 'analyse_sample' || tool === 'recommend_profile' || tool === 'propose_configuration';
  const needsLink = tool === 'explain_diagnostics' || tool === 'troubleshoot' || tool === 'compare_configuration' || tool === 'propose_mapping';
  const needsDestination = tool === 'explain_diagnostics' || tool === 'troubleshoot' || tool === 'propose_mapping' || tool === 'compare_configuration';

  return (
    <>
      <Panel title="Ask Dennis" subtitle="Evidence is measured first. The assistant explains it; it does not replace it.">
        <div className="mw-grid">
          <Pick label="What to ask for" value={tool} onValue={setTool} options={reference?.dennisTools ?? []} wide />
          {needsLink && (
            <Pick label="Analyser link" value={linkId} onValue={setLinkId}
              options={links.map(l => ({ key: String(l.id), label: l.name }))} blank="Not about one link" />
          )}
          {needsDestination && (
            <Pick label="Destination" value={destinationId} onValue={setDestinationId}
              options={destinations.map(d => ({ key: String(d.id), label: d.name }))} blank="Not about one destination" />
          )}
          <Field label="Your question" value={question} onValue={setQuestion} wide
            placeholder="Nothing has arrived on haematology 2 since the host was restarted." />
          {needsSample && (
            <Field label="A captured transmission" value={sample} onValue={setSample} wide area
              hint="Sanitised before it is read: record structure, delimiters, framing, test codes and units are kept; names and identifiers are replaced." />
          )}
          <div className="mw-actions">
            <button type="button" className="btn" disabled={busy === 'ask'} onClick={() => void ask()}>
              {busy === 'ask' ? <Loader2 size={13} className="pd-spin" /> : <Send size={13} />} Ask
            </button>
          </div>
        </div>
        <Note>
          Raw clinical messages stay in this environment. Dennis here uses the local model only — never an external
          one — and a sample that still looks identifiable after sanitising is refused rather than analysed.
        </Note>
      </Panel>

      {answer && (
        <Panel
          title="Answer"
          subtitle={`${EVIDENCE_GRADE_LABELS[answer.grade as keyof typeof EVIDENCE_GRADE_LABELS] ?? answer.grade} · confidence ${answer.confidence} · composed by the ${answer.composedBy}`}
          tone={answer.state === 'blocked' ? 'crit' : undefined}
        >
          {answer.state === 'blocked' && (
            <Note tone="crit"><ShieldAlert size={12} /> Blocked: {answer.blockedReason}</Note>
          )}
          <pre className="mw-answer">{answer.answer}</pre>

          {answer.findings.length > 0 && (
            <>
              <h5 className="mw-side-head">Evidence this was built from</h5>
              <ul className="mw-list is-compact">
                {answer.findings.map((finding, i) => (
                  <li key={i}>
                    <span className="mw-list-main">
                      <strong>{finding.label}</strong>
                      <span className="mw-sub">{finding.detail}</span>
                    </span>
                    <span className="mw-chip t-ok">{EVIDENCE_GRADE_LABELS[finding.grade as keyof typeof EVIDENCE_GRADE_LABELS] ?? finding.grade}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {answer.proposal && (
            <>
              <h5 className="mw-side-head">Proposed change</h5>
              <pre className="mw-pre">{JSON.stringify(answer.proposal, null, 2)}</pre>
              {answer.validation && (
                <Note tone={answer.validation.ok ? 'ok' : 'crit'}>
                  Validation {answer.validation.ok ? 'passed' : 'failed'}.
                  {answer.validation.errors.length ? ` ${answer.validation.errors.join(' ')}` : ''}
                  {answer.validation.warnings.length ? ` ${answer.validation.warnings.join(' ')}` : ''}
                </Note>
              )}
              <Note>
                A proposal is not a change. It is validated again at approval, because the laboratory's configuration
                may have moved since — a port that was free on Tuesday may be the production port today.
              </Note>
            </>
          )}
          <Note>{answer.notice}</Note>
        </Panel>
      )}

      <Panel title="Recommendations on the record" subtitle="Every answer, proposal, approval, rejection and block.">
        {!actions.length ? <Note>Dennis has not been asked about the middleware yet.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr><th>At</th><th>Asked</th><th>Tool</th><th>Grade</th><th>State</th><th>Review</th><th /></tr>
            </thead>
            <tbody>
              {actions.map(action => (
                <tr key={action.id} className={action.state === 'blocked' ? 'mw-row-fail' : undefined}>
                  <td>{when(action.at)}</td>
                  <td>
                    {action.asked_by ?? '—'}
                    {action.intent && <span className="mw-sub">{action.intent}</span>}
                  </td>
                  <td>{(reference?.dennisTools ?? []).find(t => t.key === action.tool)?.label ?? action.tool}</td>
                  <td>
                    <StatusMark status={action.evidence_grade === 'verified' ? 'ok' : action.evidence_grade === 'inferred' ? 'info' : 'warn'} />
                    <span className="mw-sub">{action.confidence}</span>
                  </td>
                  <td>
                    <span className={`mw-chip t-${action.state === 'applied' || action.state === 'approved' ? 'ok'
                      : action.state === 'blocked' || action.state === 'rejected' ? 'crit'
                      : action.state === 'proposed' ? 'warn' : 'idle'}`}>
                      {DENNIS_ACTION_STATE_LABELS[action.state as keyof typeof DENNIS_ACTION_STATE_LABELS] ?? action.state}
                    </span>
                    {action.blocked_reason && <span className="mw-sub t-crit">{action.blocked_reason}</span>}
                  </td>
                  <td className="mw-sub">
                    {action.reviewed_by_name
                      ? `${action.reviewed_by_name} ${when(action.reviewed_at)}${action.review_note ? ` — ${action.review_note}` : ''}`
                      : action.proposal ? 'awaiting review' : '—'}
                  </td>
                  <td className="mw-row-actions">
                    {canApproveDennis && action.state === 'proposed' && (
                      <>
                        <button type="button" className="pq-link" disabled={busy === `a${action.id}`} onClick={() => void review(action.id, 'approved')}>
                          {busy === `a${action.id}` ? <Loader2 size={12} className="pd-spin" /> : <Check size={12} />} Approve
                        </button>
                        <button type="button" className="pq-link" disabled={busy === `a${action.id}`} onClick={() => void review(action.id, 'rejected')}>
                          <X size={12} /> Reject
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="What Dennis may and may not do here">
        <Facts items={[
          { label: 'May', value: 'Explain diagnostics, produce a troubleshooting procedure, read a sanitised protocol sample, recommend a protocol or profile, compare a failing configuration with a working one, propose a configuration or a mapping, and summarise health.' },
          { label: 'May not', value: 'Change a protected production connection, activate anything, redirect a clinical result, bypass a permission, touch a patient record, or apply its own proposal.' },
          { label: 'Evidence', value: <><Bot size={12} /> Every answer names what was measured, and marks anything that does not follow from it as a hypothesis.</> },
          { label: 'Privacy', value: 'Samples are sanitised before they are read. External processing of identifiable patient information is not used by this module.' },
        ]} />
      </Panel>
    </>
  );
}
