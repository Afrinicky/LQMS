import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { Facts, Note, Panel, Pick, when, type SectionProps } from './shared';

/**
 * Audit Logs and Configuration Rollback.
 *
 * A clinical interface is a controlled thing, so every change records the
 * settings before and after it, with who made it and why. Rolling back writes
 * the old settings again and records THAT as a new version — the history is
 * append-only, because erasing the record of a change to a system carrying
 * patient results is worse than the change.
 *
 * Two things a rollback deliberately does not do: it never restores a
 * credential (an old one may have been revoked, and credentials are not kept in
 * a version at all), and it never leaves a destination active on restored
 * settings — it stands it down to awaiting approval so somebody signs for them.
 */
type Version = {
  id: number; scope: string; entity_id: number | null; entity_code: string | null; entity_name: string | null;
  action: string; reason: string | null; created_at: string; changed_by: string | null;
  rolled_back_from: number | null; dennis_action_id: number | null;
  changes: Array<{ field: string; from: string; to: string }>;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
};

export default function MiddlewareAudit({ overview, canRollback, reload, onError, onNotice }: SectionProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: '150' });
    if (scope) query.set('scope', scope);
    const data = await apiRead<{ versions: Version[] }>(`/middleware/versions?${query}`, { versions: [] });
    setVersions(data.versions);
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  async function rollback(version: Version) {
    const reason = window.prompt(`Why roll ${version.entity_name ?? 'this interface'} back to version ${version.id}?`);
    if (!reason?.trim()) return;
    setBusy(`v${version.id}`); onError(null);
    try {
      const outcome = await api<{ note: string }>(`/middleware/versions/${version.id}/rollback`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      onNotice(outcome.note);
      await load();
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function verifyBaseline(id: number) {
    setBusy(`b${id}`); onError(null);
    try {
      const outcome = await api<{ verdict: string; note: string; drift: string[] }>(`/middleware/baselines/${id}/verify`, {
        method: 'POST', body: JSON.stringify({}),
      });
      onNotice(`${outcome.note}${outcome.drift.length ? ` ${outcome.drift.join('; ')}` : ''}`);
      await reload();
    } catch (e) { onError(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <>
      <Panel
        title="Protected connection baselines"
        subtitle="Verification reads the link and reports drift. It never corrects it."
        tone="lock"
      >
        {!overview?.baselines?.length ? (
          <Note>
            No baseline is recorded. Capture one in Connection Setup — it reads the existing link's configuration and
            changes nothing about it.
          </Note>
        ) : (
          <table className="data-table mw-table">
            <thead><tr><th>Connection</th><th>Captured</th><th>Last verified</th><th>Verdict</th><th /></tr></thead>
            <tbody>
              {overview.baselines.map(baseline => (
                <tr key={baseline.id}>
                  <td><strong><Lock size={11} /> {baseline.label}</strong></td>
                  <td>{when(baseline.captured_at)}</td>
                  <td>{when(baseline.last_verified_at)}</td>
                  <td>
                    <span className={`mw-chip t-${baseline.last_verdict === 'drifted' ? 'warn' : baseline.last_verdict ? 'ok' : 'idle'}`}>
                      {baseline.last_verdict ?? 'not verified'}
                    </span>
                  </td>
                  <td>
                    <button type="button" className="pq-link" disabled={busy === `b${baseline.id}`} onClick={() => void verifyBaseline(baseline.id)}>
                      {busy === `b${baseline.id}` ? <Loader2 size={12} className="pd-spin" /> : <ShieldCheck size={12} />} Verify
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Configuration history"
        subtitle="Every change to a destination, a routing rule or a mapping, with the settings before and after it."
        actions={
          <Pick label="" value={scope} onValue={setScope} blank="Everything"
            options={[
              { key: 'destination', label: 'Destinations' },
              { key: 'route', label: 'Routing rules' },
              { key: 'mapping', label: 'Mappings' },
            ]} />
        }
      >
        {!versions.length ? <Note>No configuration change is recorded.</Note> : (
          <table className="data-table mw-table">
            <thead>
              <tr><th className="num">Version</th><th>When</th><th>Who</th><th>What</th><th>Change</th><th /></tr>
            </thead>
            <tbody>
              {versions.map(version => (
                <tr key={version.id} className={open === version.id ? 'is-selected' : undefined}>
                  <td className="num">{version.id}</td>
                  <td>{when(version.created_at)}</td>
                  <td>{version.changed_by ?? '—'}</td>
                  <td>
                    <strong>{version.entity_name ?? version.entity_code ?? version.scope}</strong>
                    <span className="mw-sub">
                      {version.scope} · {version.action}
                      {version.rolled_back_from ? ` · from version ${version.rolled_back_from}` : ''}
                      {version.dennis_action_id ? ` · Dennis recommendation ${version.dennis_action_id}` : ''}
                    </span>
                  </td>
                  <td>
                    {version.changes.length === 0 ? (
                      <span className="mw-sub">{version.action === 'create' ? 'Created.' : version.action === 'delete' ? 'Retired.' : 'No field changed.'}</span>
                    ) : (
                      <span className="mw-sub">
                        {version.changes.slice(0, 3).map(change => `${change.field}: ${change.from || '(none)'} → ${change.to || '(none)'}`).join('; ')}
                        {version.changes.length > 3 ? ` and ${version.changes.length - 3} more` : ''}
                      </span>
                    )}
                    {version.reason && <span className="mw-sub">{version.reason}</span>}
                  </td>
                  <td className="mw-row-actions">
                    <button type="button" className="pq-link" onClick={() => setOpen(open === version.id ? null : version.id)}>
                      <History size={12} /> {open === version.id ? 'Hide' : 'Detail'}
                    </button>
                    {canRollback && version.action !== 'delete' && (
                      <button type="button" className="pq-link" disabled={busy === `v${version.id}`} onClick={() => void rollback(version)}>
                        {busy === `v${version.id}` ? <Loader2 size={12} className="pd-spin" /> : <RotateCcw size={12} />} Roll back to this
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {open != null && (() => {
          const version = versions.find(v => v.id === open);
          if (!version) return null;
          return (
            <div className="mw-inset">
              <h5 className="mw-side-head">Version {version.id} in full</h5>
              {version.changes.length > 0 && (
                <table className="data-table mw-table">
                  <thead><tr><th>Field</th><th>Was</th><th>Became</th></tr></thead>
                  <tbody>
                    {version.changes.map(change => (
                      <tr key={change.field}>
                        <td className="mono">{change.field}</td>
                        <td>{change.from || '(none)'}</td>
                        <td>{change.to || '(none)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <details className="mw-reveal">
                <summary>Settings after this change</summary>
                <pre className="mw-pre">{JSON.stringify(version.after_json ?? {}, null, 2)}</pre>
              </details>
            </div>
          );
        })()}
      </Panel>

      <Panel title="What is recorded, and where">
        <Facts items={[
          { label: 'Configuration', value: 'Every create, update, approval, activation, stand-down, retirement and rollback, with the settings before and after it.' },
          { label: 'Privileged operations', value: 'Network scans, destination tests, replays, cancellations, re-routes and queue sweeps go to the system audit trail with the actor.' },
          { label: 'Dennis', value: 'Every recommendation, the evidence behind it, its validation, who approved or rejected it, and which version carried it out.' },
          { label: 'Credentials', value: 'Never in a version, never in a log, never returned by the API. A rollback restores settings and leaves the stored credential alone.' },
          { label: 'Messages', value: 'The source transmission is preserved as received and never rewritten, however many times it is routed or replayed.' },
        ]} />
      </Panel>
    </>
  );
}
