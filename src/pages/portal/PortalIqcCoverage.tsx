import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import TextField from '../../components/ui/TextField';
import type { IqcCoverage, IqcCoverageTest } from '../../../shared/types/api';

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

type Draft = {
  analyte: string; unit: string; targetMean: string; targetSd: string;
  acceptableLow: string; acceptableHigh: string; expectedResult: string;
};

const emptyDraft = (): Draft => ({
  analyte: '', unit: '', targetMean: '', targetSd: '',
  acceptableLow: '', acceptableHigh: '', expectedResult: '',
});

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
          equipment={data.equipment}
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
function SetUpControlDialog({ test, equipment, onClose, onSaved }: {
  test: IqcCoverageTest | null;
  equipment: Array<{ id: number; name: string; equipmentNumber: string | null }>;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
}) {
  const [controlType, setControlType] = useState<'quantitative' | 'qualitative' | 'semi_quantitative'>('quantitative');
  const [form, setForm] = useState({
    testName: test?.testName ?? '',
    materialName: '', levelLabel: '', lotNumber: '', manufacturer: '',
    expiryDate: '', storageCondition: '',
    equipmentId: test?.equipmentId ? String(test.equipmentId) : '',
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
          ...form, controlType,
          equipmentId: form.equipmentId || null,
          analytes: rows.filter(r => r.analyte.trim()),
        }),
      });
      await onSaved(
        `${form.materialName} added for ${form.testName}.` + (result.note ? ` ${result.note}` : ''),
      );
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-panel qcc-dialog" onClick={e => e.stopPropagation()}>
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

          <div className="qcc-choice">
            {([
              ['quantitative', 'Numeric', 'A measured value.'],
              ['qualitative', 'Reactive / non-reactive', 'Matched against an expected result.'],
              ['semi_quantitative', 'Graded', 'A titre or grade within a range.'],
            ] as const).map(([key, label, hint]) => (
              <button key={key} type="button" className={controlType === key ? 'active' : ''}
                onClick={() => setControlType(key)}>
                <strong>{label}</strong><span>{hint}</span>
              </button>
            ))}
          </div>

          <div className="form-grid">
            <label>Test
              <TextField value={form.testName} onValue={v => set('testName', v)}
                disabled={Boolean(test)} placeholder="e.g. Full blood count" autoFocus={!test} />
            </label>
            <label>Control name
              <TextField value={form.materialName} onValue={v => set('materialName', v)}
                placeholder="e.g. Haematology Control Normal" autoFocus={Boolean(test)} />
            </label>
            <label>Level
              <TextField value={form.levelLabel} onValue={v => set('levelLabel', v)} placeholder="e.g. Level 1" />
            </label>
            <label>Lot number
              <TextField value={form.lotNumber} onValue={v => set('lotNumber', v)} />
            </label>
            <label>Expiry
              <input type="date" value={form.expiryDate} onChange={e => set('expiryDate', e.target.value)} />
            </label>
            <label>Source
              <select value={form.source} onChange={e => set('source', e.target.value)}>
                <option value="commercial">Bought in</option>
                <option value="in_house">Made here</option>
              </select>
            </label>
            {form.source === 'commercial' && (
              <label>Manufacturer<TextField value={form.manufacturer} onValue={v => set('manufacturer', v)} /></label>
            )}
            <label>Instrument
              <select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}>
                <option value="">Manual method</option>
                {equipment.map(x => (
                  <option key={x.id} value={x.id}>{x.name}{x.equipmentNumber ? ` (${x.equipmentNumber})` : ''}</option>
                ))}
              </select>
            </label>
            <label>Storage
              <TextField value={form.storageCondition} onValue={v => set('storageCondition', v)} placeholder="e.g. 2–8 °C" />
            </label>
          </div>

          {form.source === 'in_house' && (
            <label className="stack">Preparation method
              <TextField as="textarea" rows={2} value={form.preparationMethod}
                onValue={v => set('preparationMethod', v)}
                placeholder="How it was pooled, aliquoted and stored." />
            </label>
          )}

          <div className="qcc-analytes">
            <div className="qcc-analytes-head">
              <strong>Parameters</strong>
              <button type="button" className="pq-link" onClick={() => setRows(rs => [...rs, emptyDraft()])}>
                <Plus size={12} /> Add
              </button>
            </div>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Parameter</th>
                  {quantitative ? <>
                    <th>Unit</th><th>Mean</th><th>SD</th><th>Low</th><th>High</th>
                  </> : <th>Expected</th>}
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
                        <button type="button" className="pq-link" title="Remove"
                          onClick={() => setRows(rs => rs.filter((_, index) => index !== i))}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {quantitative && (
              <p className="qcc-sd-note">
                Leave the SD blank if the insert does not give one. It is calculated from this
                laboratory&rsquo;s own runs once there are enough of them.
              </p>
            )}
          </div>
        </div>

        <footer className="modal-foot">
          <button type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : 'Save control'}
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}
