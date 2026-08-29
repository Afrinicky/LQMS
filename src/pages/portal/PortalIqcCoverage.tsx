import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plus, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import DefineControlForm from '../../components/iqc/DefineControlForm';
import type {
  IqcCoverage, IqcCoverageTest, Section, Staff, EquipmentItem,
} from '../../../shared/types/api';

/**
 * Setting up the unit's controls, from the portal.
 *
 * The unit head is the person who defines controls and the portal is where they
 * are, so the action lives here rather than three modules away. It is available
 * whether or not the unit's test menu has been filled in — a laboratory that has
 * not registered its tests still has controls to run, and blocking on the menu
 * would make this panel another dead end.
 *
 * Where the menu IS filled in, it is used as a checklist: which examinations have
 * a control and which do not.
 */

/** What the wizard fills its dropdowns from. */
type Lookups = { sections: Section[]; staff: Staff[]; equipment: EquipmentItem[]; sectionId: number | null };

export default function PortalIqcCoverage({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<IqcCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ test: IqcCoverageTest | null } | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<IqcCoverage>('/iqc/portal/coverage')); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Tests without a control first — those are the rows anyone opens this for.
  const ordered = useMemo(() => {
    const rows = data?.tests ?? [];
    return [...rows].sort((a, b) => Number(a.covered) - Number(b.covered) || a.testName.localeCompare(b.testName));
  }, [data]);

  if (loading) return <p className="muted">Loading…</p>;
  if (!data) return <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>;

  const { counts } = data;
  const canDefine = data.canDefine;

  return (
    <section className="portal-panel qcc">
      <div className="pp-head">
        <div>
          <h3>Controls</h3>
          <p>Which of this unit&rsquo;s tests have a control defined.</p>
        </div>
        {canDefine && (
          <button type="button" className="pp-action" onClick={() => setSetup({ test: null })}>
            <Plus size={13} /> New control
          </button>
        )}
      </div>

      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      {notice && (
        <p className="qcc-notice">
          <CheckCircle2 size={13} /> {notice}
          <button type="button" className="pq-link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      {data.message ? (
        <p className="muted">{data.message}</p>
      ) : counts.tests === 0 ? (
        <p className="muted">
          No tests are registered for {data.sectionName ?? 'this unit'} yet.
          {counts.controls > 0
            ? ` ${counts.controls} control${counts.controls === 1 ? ' is' : 's are'} defined.`
            : canDefine ? ' Controls can still be added.' : ''}
        </p>
      ) : (
        <>
          <div className="qcc-counts">
            <Stat value={counts.tests} label="Tests" />
            <Stat value={counts.covered} label="With a control" tone={counts.covered ? 'ok' : undefined} />
            <Stat value={counts.uncovered} label="Without" tone={counts.uncovered ? 'crit' : 'ok'} />
            {counts.needingLimits > 0 && <Stat value={counts.needingLimits} label="Awaiting limits" tone="warn" />}
          </div>

          <table className="data-table compact qcc-table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Instrument</th>
                <th>Control</th>
                {canDefine && <th />}
              </tr>
            </thead>
            <tbody>
              {ordered.map(test => (
                <tr key={test.id} className={test.covered ? '' : 'is-gap'}>
                  <td>
                    <span className="qcc-test">{test.testName}</span>
                    {test.methodName && <span className="qcc-sub">{test.methodName}</span>}
                  </td>
                  <td className="muted">{test.equipmentName ?? '—'}</td>
                  <td>
                    {test.controls.length === 0
                      ? <span className="qcc-none">None</span>
                      : (
                        <span className="qcc-have">
                          {test.controls.map(c => (
                            <span key={c.id}>
                              {c.materialName}{c.levelLabel ? ` · ${c.levelLabel}` : ''}
                              {c.expired && <span className="badge overdue">expired</span>}
                              {c.analytesWithoutLimits > 0 && <span className="badge warning">limits pending</span>}
                            </span>
                          ))}
                        </span>
                      )}
                  </td>
                  {canDefine && (
                    <td className="qcc-act">
                      <button type="button" className="pq-link" onClick={() => setSetup({ test })}>
                        {test.covered ? 'Add level' : 'Add control'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.unlisted.length > 0 && (
        <p className="qcc-foot muted">
          {data.unlisted.length} control{data.unlisted.length === 1 ? '' : 's'} for a test not on the menu:{' '}
          {data.unlisted.map(c => c.testName).join(', ')}.
        </p>
      )}

      {setup && (
        <SetUpControlDialog
          test={setup.test}
          onClose={() => setSetup(null)}
          onSaved={async message => {
            setSetup(null);
            setNotice(message);
            await load();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={`qcc-stat${tone ? ` tone-${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The setup form
   ----------------------------------------------------------------------------
   Deliberately the short one. In-house provenance, culture and sensitivity
   panels, instrument feeds and import layouts stay on the full definition screen
   in the IQC module; what is needed here is the vial in somebody's hand.
   ------------------------------------------------------------------------- */
/**
 * Setting a control up — the module's own wizard, in a dialog.
 *
 * It used to be a shortened form of its own: three type buttons, a handful of
 * fields, a parameter table. Two forms for one act is how a control ends up
 * defined with a rule set in one place and none in the other, and how a
 * laboratory ends up with two ideas of what a control record contains. So this
 * is the same component Quality Control uses — the numbered steps, the
 * provenance an in-house control has to carry, the rule sets, the templates —
 * opened where the person already is.
 *
 * The dialog adds only what the portal knows: the unit they work in, and the
 * test and instrument of the row they pressed the button on.
 */
function SetUpControlDialog({ test, onClose, onSaved }: {
  test: IqcCoverageTest | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The lists the wizard fills its dropdowns from, served by the right that
  // governs defining a control rather than three unrelated module rights.
  useEffect(() => {
    api<Lookups>('/iqc/portal/lookups')
      .then(setLookups)
      .catch(e => { setProblem(errorText(e)); setLookups({ sections: [], staff: [], equipment: [], sectionId: null }); });
  }, []);

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel qcc-dialog is-wizard" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <h3>New control</h3>
            <p className="modal-sub">
              {test ? `For ${test.testName}.` : 'It is filed against your unit and appears on the board today.'}
            </p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="modal-body">
          {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
          {!lookups ? <p className="muted">Reading the register…</p> : (
            <DefineControlForm
              sections={lookups.sections}
              staff={lookups.staff}
              equipment={lookups.equipment}
              mySectionId={lookups.sectionId}
              defaultTestName={test?.testName ?? ''}
              defaultEquipmentId={test?.equipmentId ?? null}
              embedded
              /* The panel only offers this where the server said the person may
                 define a control — including a unit head without the module's
                 create right, which the wizard would otherwise refuse to draw. */
              allowed
              onError={setProblem}
              onSaved={() => onSaved(
                test ? `Control added for ${test.testName}.` : 'Control defined. It appears on the board today.',
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
