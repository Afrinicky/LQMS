/**
 * Dynamic Digital Forms Engine — client renderer (Phase 2).
 *
 * Lists the form templates the Host exposes and renders any of them from its
 * JSON schema: sections, headings, text/number/date/time inputs, dropdowns,
 * multiple choice, checkboxes, pass/fail, rating scales, signatures, photos and
 * QR references — with required fields, conditional questions (showIf) and
 * validation. New forms appear automatically when an administrator adds a
 * template; no app update is needed.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';
import { Back, Field, Ico, ICO, PhotoField, Result, s, type Msg } from './ui';
import { SignaturePad, uploadSignatureImage } from './Signature';
import { ScanField } from './Scan';

type Row = Record<string, unknown>;
interface FField { key: string; label: string; type: string; required?: boolean; options?: string[]; max?: number; min?: number; hint?: string; showIf?: { field: string; equals: unknown } }
interface FSection { title?: string; fields: FField[] }
interface FSchema { sections: FSection[] }

export function FormsScreen({ onBack }: { onBack: () => void }) {
  const [templates, setTemplates] = useState<Row[] | null>(null);
  const [active, setActive] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api<Row[]>('/forms/templates').then(setTemplates).catch(e => setErr((e as Error).message)); }, []);

  if (active) return <FormFill templateKey={s(active.template_key)} title={s(active.title)} onBack={() => setActive(null)} />;

  // Group templates by category for a tidy, standardized launcher.
  const byCat = new Map<string, Row[]>();
  for (const t of templates ?? []) { const c = s(t.category) || 'General'; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c)!.push(t); }

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Digital forms</div>
      <p className="m-hint" style={{ marginTop: 0 }}>Complete checklists, inspections and logs. New forms are published by administrators and appear here automatically.</p>
      {err && <p className="m-err">{err}</p>}
      {templates === null && !err && <p className="m-empty">Loading forms…</p>}
      {templates && templates.length === 0 && <p className="m-empty">No forms are published yet.</p>}
      {[...byCat.entries()].map(([cat, rows]) => (
        <div key={cat}>
          <div className="m-section-h">{cat}</div>
          <div className="m-list">
            {rows.map(t => (
              <button key={s(t.id)} className="m-item tappable" onClick={() => setActive(t)}>
                <span className="m-item-ic"><Ico d={ICO.doc} size={18} /></span>
                <div className="m-item-body">
                  <div className="m-item-title">{s(t.title)}</div>
                  {t.description && <div className="m-item-meta"><span className="m-due">{s(t.description)}</span></div>}
                </div>
                {t.requires_signature ? <span className="m-chip">Signature</span> : null}
                <span className="m-chevron">›</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function isEmpty(v: unknown) { return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0); }

function FormFill({ templateKey, title, onBack }: { templateKey: string; title: string; onBack: () => void }) {
  const [schema, setSchema] = useState<FSchema | null>(null);
  const [requiresSig, setRequiresSig] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Row & { schema: FSchema; requires_signature: number }>(`/forms/templates/${templateKey}`)
      .then(t => { setSchema(t.schema); setRequiresSig(Boolean(t.requires_signature)); })
      .catch(e => setErr((e as Error).message));
  }, [templateKey]);

  const set = (key: string, value: unknown) => setAnswers(a => ({ ...a, [key]: value }));
  const visible = (f: FField) => !f.showIf || answers[f.showIf.field] === f.showIf.equals;

  const fields = useMemo(() => (schema?.sections ?? []).flatMap(sec => sec.fields ?? []), [schema]);

  async function save() {
    setRes(null);
    // Client-side required/validation for immediate feedback (server re-validates).
    for (const f of fields) {
      if (f.type === 'heading' || !visible(f)) continue;
      if (f.required && isEmpty(answers[f.key])) { setRes({ kind: 'err', msg: `"${f.label}" is required.` }); return; }
    }
    setBusy(true);
    try {
      let signatureImageFileId: number | null = null;
      if (requiresSig) {
        if (!sig) { setRes({ kind: 'err', msg: 'Please sign before submitting.' }); setBusy(false); return; }
        signatureImageFileId = await uploadSignatureImage(sig);
      }
      // Photo fields hold a File for preview; JSON can only carry a reference, so
      // record the filename (the bytes stay on the device — a documented limit of
      // in-form photos; use the dedicated capture screens for linked evidence).
      const serializable: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(answers)) serializable[k] = v instanceof File ? `[photo] ${v.name}` : v;
      const out = await submit('/forms/submissions', { templateKey, answers: serializable, signatureImageFileId }, `Form · ${title}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit automatically when back online.' });
      else { const no = s((out.data as { submissionNumber?: string })?.submissionNumber || ''); setRes({ kind: 'ok', msg: `Submitted${no ? ' (' + no + ')' : ''}.` }); setAnswers({}); setSig(null); }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">{title}</div>
      {err && <p className="m-err">{err}</p>}
      {schema === null && !err && <p className="m-empty">Loading form…</p>}
      {schema && (
        <div className="m-form">
          {schema.sections.map((sec, si) => (
            <div key={si} className="m-formsec">
              {sec.title && <div className="m-section-h">{sec.title}</div>}
              {(sec.fields ?? []).filter(visible).map(f => (
                <FieldRenderer key={f.key} f={f} value={answers[f.key]} onChange={v => set(f.key, v)} />
              ))}
            </div>
          ))}
          {requiresSig && (
            <Field label="Signature" hint="Your signature is recorded with your identity, time and device.">
              <SignaturePad onChange={setSig} />
            </Field>
          )}
          <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Submitting…' : 'Submit form'}</button>
          <Result r={res} />
        </div>
      )}
    </div>
  );
}

function FieldRenderer({ f, value, onChange }: { f: FField; value: unknown; onChange: (v: unknown) => void }) {
  const label = f.label + (f.required ? ' *' : '');
  switch (f.type) {
    case 'heading':
      return <div className="m-formheading">{f.label}</div>;
    case 'textarea':
      return <Field label={label} hint={f.hint}><textarea rows={3} value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
    case 'number':
      return <Field label={label} hint={f.hint}><input type="number" inputMode="decimal" step="any" value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
    case 'date':
      return <Field label={label} hint={f.hint}><input type="date" value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
    case 'time':
      return <Field label={label} hint={f.hint}><input type="time" value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
    case 'datetime':
      return <Field label={label} hint={f.hint}><input type="datetime-local" value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
    case 'dropdown':
      return <Field label={label} hint={f.hint}>
        <select value={s(value)} onChange={e => onChange(e.target.value)}>
          <option value="">Select…</option>
          {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>;
    case 'multichoice':
      return <Field label={label} hint={f.hint}>
        <div className="m-rchips">
          {(f.options ?? []).map(o => {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            const on = arr.includes(o);
            return <button type="button" key={o} className={`m-rchip ${on ? 'on ok' : ''}`}
              onClick={() => onChange(on ? arr.filter(x => x !== o) : [...arr, o])}>{o}</button>;
          })}
        </div>
      </Field>;
    case 'checkbox':
      return <label className="m-check"><input type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} /><span>{f.label}</span></label>;
    case 'passfail':
      return <Field label={label} hint={f.hint}>
        <div className="m-rchips">
          {(['pass', 'fail', 'na'] as const).map(o => (
            <button type="button" key={o} className={`m-rchip ${value === o ? 'on ' + (o === 'pass' ? 'ok' : o === 'fail' ? 'bad' : 'na') : ''}`}
              onClick={() => onChange(o)}>{o === 'na' ? 'N/A' : o[0].toUpperCase() + o.slice(1)}</button>
          ))}
        </div>
      </Field>;
    case 'rating': {
      const max = f.max ?? 5;
      return <Field label={label} hint={f.hint}>
        <div className="m-rchips">
          {Array.from({ length: max }, (_, i) => i + 1).map(n => (
            <button type="button" key={n} className={`m-rchip ${Number(value) === n ? 'on ok' : ''}`} onClick={() => onChange(n)}>{n}</button>
          ))}
        </div>
      </Field>;
    }
    case 'signature':
      return <Field label={label} hint={f.hint || 'Sign in the box'}><SignaturePad onChange={dataUrl => onChange(dataUrl ? 'signed' : '')} /></Field>;
    case 'photo':
      return <PhotoField file={(value as File) ?? null} onChange={file => onChange(file)} />;
    case 'qr':
      return <ScanField label={label} value={s(value)} onChange={v => onChange(v)} hint={f.hint} />;
    case 'text':
    default:
      return <Field label={label} hint={f.hint}><input value={s(value)} onChange={e => onChange(e.target.value)} /></Field>;
  }
}
