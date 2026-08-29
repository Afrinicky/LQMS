import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, ClipboardList,
  Loader2, Plus, ShieldQuestion, Trash2, X,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../../components/ui/TextField';
import type { IqcCoverage, IqcCoverageTest } from '../../../shared/types/api';

/**
 * Is this unit's work controlled at all?
 *
 * The board next to this one answers "has today's control been run?", which is
 * the right question only once controls exist. A unit whose board is empty was
 * being told nothing except that it was empty, and being sent to a module its
 * head could not act in — so the gap stayed open and nobody could size it.
 *
 * The unit's own test menu is the denominator, because that is what ISO
 * 15189:2022 §7.3.7.1 asks about: a QC procedure for each examination. So the
 * count is honest — eleven tests, four controlled, seven not — and each
 * uncontrolled test carries the one button that closes it.
 *
 * The setup form is deliberately the short one. The full definition screen in
 * the IQC module handles in-house provenance, culture and sensitivity panels,
 * instrument feeds and import layouts, and it stays there. What a unit head
 * needs at eight in the morning is: this test has no control, here is the vial
 * in my hand, record it. Everything else can be filled in later on the control
 * itself.
 *
 * The one thing this form does that matters more than the rest: the SD is
 * optional and it says why. Most commercial inserts give an assayed mean and a
 * range and no SD at all, and a form that demands one gets abandoned or filled
 * with an invented number. It is accepted without, and the laboratory's own SD
 * is established from its own runs.
 */

type Draft = {
  analyte: string; unit: string; targetMean: string; targetSd: string;
  acceptableLow: string; acceptableHigh: string; decimalPlaces: string; expectedResult: string;
};

const emptyDraft = (): Draft => ({
  analyte: '', unit: '', targetMean: '', targetSd: '',
  acceptableLow: '', acceptableHigh: '', decimalPlaces: '2', expectedResult: '',
});

export default function PortalIqcCoverage({ onChanged }: { onChanged?: () => void }) {
  const [data, setData] = useState<IqcCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [setupFor, setSetupFor] = useState<IqcCoverageTest | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<IqcCoverage>('/iqc/portal/coverage')); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Uncontrolled first. A list sorted alphabetically buries the gap among the
  // tests that are already fine, which is the opposite of what this is for.
  const ordered = useMemo(() => {
    const rows = data?.tests ?? [];
    return [...rows].sort((a, b) => Number(a.covered) - Number(b.covered) || a.testName.localeCompare(b.testName));
  }, [data]);

  if (loading) return <p className="muted">Checking your unit&rsquo;s tests against its controls…</p>;
  if (!data) return <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>;
  if (data.message) return <p className="muted">{data.message}</p>;

  const { counts } = data;
  const allCovered = counts.tests > 0 && counts.uncovered === 0;

  return (
    <section className="portal-panel qcc">
      <div className="pp-head">
        <div>
          <h3><ShieldQuestion size={16} /> What your unit&rsquo;s tests are controlled by</h3>
          <p>
            Every examination on {data.sectionName ?? 'your unit'}&rsquo;s menu needs a quality control
            procedure of its own (ISO 15189:2022 §7.3.7.1). This is which of them have one.
          </p>
        </div>
        {counts.uncovered > 0 && <span className="pp-count crit">{counts.uncovered}</span>}
      </div>

      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      {notice && (
        <p className="qcc-notice">
          <CheckCircle2 size={13} /> {notice}
          <button type="button" className="pq-link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      {counts.tests === 0 ? (
        <p className="muted">
          No tests are registered against {data.sectionName ?? 'your unit'} yet, so there is nothing to
          check controls against. The unit&rsquo;s test menu is set under Process Management &rarr; Test
          Catalogue, or on the unit itself under Organisation.
          {counts.controls > 0 && ` Your unit does have ${counts.controls} control${counts.controls === 1 ? '' : 's'} defined — they are listed below.`}
        </p>
      ) : (
        <div className="qcc-counts">
          <Stat value={counts.tests} label="tests on the menu" tone="info" />
          <Stat value={counts.covered} label="have a control" tone={counts.covered ? 'ok' : 'warn'} />
          <Stat value={counts.uncovered} label="have none" tone={counts.uncovered ? 'crit' : 'ok'} />
          {counts.needingLimits > 0 && (
            <Stat value={counts.needingLimits} label="parameters with no SD yet" tone="warn" />
          )}
        </div>
      )}

      {allCovered && (
        <p className="qcc-clear">
          <CheckCircle2 size={14} /> Every test on this unit&rsquo;s menu has a control defined against it.
        </p>
      )}

      {counts.needingLimits > 0 && (
        <p className="qcc-limits">
          <AlertTriangle size={13} />
          <span>
            {counts.needingLimits} control parameter{counts.needingLimits === 1 ? ' has' : 's have'} no SD, so
            results are checked against the acceptable range but not yet by Westgard. The system establishes
            the SD from your own runs — 20 results over 20 separate days for the definitive set, 20 over 5 days
            for interim limits — and the Levey-Jennings chart appears with it. Nothing needs doing except
            running the control.
          </span>
        </p>
      )}

      {counts.tests > 0 && (
        <>
          <button type="button" className="qcc-toggle" onClick={() => setOpen(v => !v)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {open ? 'Hide the test list' : `Show all ${counts.tests} test${counts.tests === 1 ? '' : 's'}`}
          </button>

          {open && (
            <ul className="qcc-list">
              {ordered.map(test => (
                <li key={test.id} className={test.covered ? '' : 'is-gap'}>
                  <div className="qcc-row">
                    <div className="qcc-row-main">
                      <span className="qcc-test">
                        {test.testName}
                        {test.testCode && <span className="badge">{test.testCode}</span>}
                      </span>
                      <span className="qcc-meta">
                        {test.methodName && <span>{test.methodName}</span>}
                        {test.equipmentName && <span>{test.equipmentName}</span>}
                        {test.covered
                          ? <span className="ok">{test.controls.length} control{test.controls.length === 1 ? '' : 's'}</span>
                          : <span className="crit">No control defined</span>}
                      </span>
                      {test.controls.length > 0 && (
                        <ul className="qcc-controls">
                          {test.controls.map(c => (
                            <li key={c.id}>
                              {c.materialName}{c.levelLabel ? ` · ${c.levelLabel}` : ''} · lot {c.lotNumber}
                              {c.expired && <span className="badge overdue">lot expired</span>}
                              {c.analytesWithoutLimits > 0 && (
                                <span className="badge warning" title="Recorded against its acceptable range; Westgard needs an SD, which is established from your own runs.">
                                  {c.analytesWithoutLimits} of {c.analytes} without an SD
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    {data.canDefine && (
                      <button type="button" className="qcc-add" onClick={() => setSetupFor(test)}>
                        <Plus size={12} /> {test.covered ? 'Add another level' : 'Set up a control'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {data.unlisted.length > 0 && (
        <details className="qcc-unlisted">
          <summary>
            {data.unlisted.length} control{data.unlisted.length === 1 ? '' : 's'} for something not on the test menu
          </summary>
          <p className="muted">
            Not necessarily wrong — a menu is often incomplete — but worth reconciling, because a control
            whose examination is not registered will not appear in the count above.
          </p>
          <ul>
            {data.unlisted.map(c => (
              <li key={c.id}>{c.materialName} — {c.testName}{c.levelLabel ? ` · ${c.levelLabel}` : ''} · lot {c.lotNumber}</li>
            ))}
          </ul>
        </details>
      )}

      {!data.canDefine && counts.uncovered > 0 && (
        <p className="rw-locked">
          <ClipboardList size={11} /> Defining a control is your unit head&rsquo;s, or somebody holding the
          right to create controls. The gap is shown here so it can be raised with them.
        </p>
      )}

      {setupFor && (
        <SetUpControlDialog
          test={setupFor}
          equipment={data.equipment}
          onClose={() => setSetupFor(null)}
          onSaved={async message => {
            setSetupFor(null);
            setNotice(message);
            await load();
            onChanged?.();
          }}
        />
      )}
    </section>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className={`qcc-stat tone-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The short form
   ------------------------------------------------------------------------- */
function SetUpControlDialog({ test, equipment, onClose, onSaved }: {
  test: IqcCoverageTest;
  equipment: Array<{ id: number; name: string; equipmentNumber: string | null }>;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [controlType, setControlType] = useState<'quantitative' | 'qualitative' | 'semi_quantitative'>('quantitative');
  const [form, setForm] = useState({
    materialName: '', levelLabel: '', lotNumber: '', manufacturer: '',
    expiryDate: '', storageCondition: '',
    equipmentId: test.equipmentId ? String(test.equipmentId) : '',
    source: 'commercial' as 'commercial' | 'in_house',
    preparationMethod: '',
  });
  const [rows, setRows] = useState<Draft[]>([emptyDraft()]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const setRow = (i: number, k: keyof Draft, v: string) =>
    setRows(rs => rs.map((r, index) => (index === i ? { ...r, [k]: v } : r)));

  const quantitative = controlType !== 'qualitative';

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      const result = await api<{ id: number; materialCode: string; note: string | null }>('/iqc/portal/controls', {
        method: 'POST',
        body: JSON.stringify({
          ...form, controlType, testName: test.testName,
          equipmentId: form.equipmentId || null,
          analytes: rows.filter(r => r.analyte.trim()),
        }),
      });
      await onSaved(
        `${form.materialName} is set up against ${test.testName} and is on your unit's board now.`
        + (result.note ? ` ${result.note}` : ''),
      );
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel qcc-dialog" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <div className="modal-title">
            <h3>Set up a control for {test.testName}</h3>
            <p className="modal-sub">
              It is filed against your own unit, so it appears on your bench board from today.
              Anything not asked for here can be filled in later on the control itself.
            </p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="modal-body">
          {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

          <div className="qcc-choice">
            {([
              ['quantitative', 'Gives a number', 'A measured value judged by Westgard against a mean and SD.'],
              ['qualitative', 'Gives a result', 'Reactive / non-reactive, positive / negative — judged against what it should give.'],
              ['semi_quantitative', 'Gives a graded result', 'A titre or a grade, judged against an acceptable range.'],
            ] as const).map(([key, label, hint]) => (
              <button key={key} type="button" className={controlType === key ? 'active' : ''}
                onClick={() => setControlType(key)}>
                <strong>{label}</strong><span>{hint}</span>
              </button>
            ))}
          </div>

          <div className="form-grid">
            <label>Control name
              <TextField value={form.materialName} onValue={v => set('materialName', v)}
                placeholder="e.g. Haematology Control Normal" autoFocus />
            </label>
            <label>Level or designation
              <TextField value={form.levelLabel} onValue={v => set('levelLabel', v)}
                placeholder="e.g. Level 1 (Normal), Positive control" />
            </label>
            <label>Lot / batch number
              <TextField value={form.lotNumber} onValue={v => set('lotNumber', v)} />
            </label>
            <label>Expiry date
              <input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} />
            </label>
            <label>Where it came from
              <select value={form.source} onChange={e => set('source', e.target.value)}>
                <option value="commercial">Bought in</option>
                <option value="in_house">Made here</option>
              </select>
            </label>
            {form.source === 'commercial' && (
              <label>Manufacturer<TextField value={form.manufacturer} onValue={v => set('manufacturer', v)} /></label>
            )}
            <label>Instrument it runs on
              <select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}>
                <option value="">Manual method — no instrument</option>
                {equipment.map(x => (
                  <option key={x.id} value={x.id}>{x.name}{x.equipmentNumber ? ` (${x.equipmentNumber})` : ''}</option>
                ))}
              </select>
            </label>
            <label>Storage condition
              <TextField value={form.storageCondition} onValue={v => set('storageCondition', v)} placeholder="e.g. 2–8 °C" />
            </label>
          </div>

          {form.source === 'in_house' && (
            <label className="stack">How it was prepared <em>(required)</em>
              <TextField as="textarea" rows={2} value={form.preparationMethod}
                onValue={v => set('preparationMethod', v)}
                placeholder="How the material was pooled, aliquoted and stored." />
            </label>
          )}

          <div className="qcc-analytes">
            <div className="qcc-analytes-head">
              <strong>What does it measure?</strong>
              <span>
                One row per parameter. An FBC control reads eight; a serology control reads one.
              </span>
            </div>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {quantitative ? <>
                    <th>Unit</th>
                    <th title="The assayed mean off the insert, or the value your laboratory established.">Target mean</th>
                    <th title="Leave blank if the insert does not give one — it usually does not.">SD</th>
                    <th>Range low</th>
                    <th>Range high</th>
                  </> : <th>Expected result</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><TextField value={r.analyte} onValue={v => setRow(i, 'analyte', v)} placeholder="e.g. Haemoglobin" /></td>
                    {quantitative ? <>
                      <td><TextField value={r.unit} onValue={v => setRow(i, 'unit', v)} placeholder="g/dL" /></td>
                      <td><TextField value={r.targetMean} onValue={v => setRow(i, 'targetMean', v)} inputMode="decimal" /></td>
                      <td><TextField value={r.targetSd} onValue={v => setRow(i, 'targetSd', v)} inputMode="decimal" placeholder="optional" /></td>
                      <td><TextField value={r.acceptableLow} onValue={v => setRow(i, 'acceptableLow', v)} inputMode="decimal" /></td>
                      <td><TextField value={r.acceptableHigh} onValue={v => setRow(i, 'acceptableHigh', v)} inputMode="decimal" /></td>
                    </> : (
                      <td><TextField value={r.expectedResult} onValue={v => setRow(i, 'expectedResult', v)} placeholder="e.g. Reactive" /></td>
                    )}
                    <td>
                      {rows.length > 1 && (
                        <button type="button" className="pq-link" title="Remove this parameter"
                          onClick={() => setRows(rs => rs.filter((_, index) => index !== i))}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className="pq-link" onClick={() => setRows(rs => [...rs, emptyDraft()])}>
              <Plus size={12} /> Add another parameter
            </button>

            {quantitative && (
              <p className="qcc-sd-note">
                <strong>No SD on the insert? Leave it blank.</strong> Most commercial inserts give a mean and a
                range and no SD, because the SD belongs to your instrument and your operators, not to the vial.
                This laboratory&rsquo;s own SD is calculated from your runs — 20 results over 20 separate days is
                the definitive set, and 20 over 5 days serves as interim limits meanwhile (CLSI C24, ISO
                15189:2022 §7.3.7.2). Until then the control is still checked against its acceptable range.
              </p>
            )}
          </div>
        </div>

        <footer className="modal-foot">
          <button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : 'Set the control up'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
