/**
 * Internal assessments (M6): conduct checklist-based assessments from the phone.
 * Lists assessment programs, then for a chosen one loads its selected questions
 * (grouped by section) and records a response + evidence note per question,
 * auto-saving each answer to /assessments/:id/question-response through the
 * offline-aware submit(). Answers already recorded on the Host are pre-filled.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../src/services/api';
import { submit } from './net';
import { Back, s } from './ui';

type Row = Record<string, unknown>;

const RESP = [
  { v: 'met', label: 'Met', cls: 'ok' },
  { v: 'partially_met', label: 'Partial', cls: 'warn' },
  { v: 'not_met', label: 'Not met', cls: 'bad' },
  { v: 'not_applicable', label: 'N/A', cls: 'na' },
];

export function AssessmentsScreen({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<Row[] | null>(null);
  const [active, setActive] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { api<Row[]>('/assessments').then(setList).catch(e => { setList([]); setErr((e as Error).message); }); }, []);

  if (active) return <Conduct assessment={active} onBack={() => setActive(null)} />;

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">Assessments</div>
      {err && <p className="m-err">{err}</p>}
      {list === null && !err && <p className="m-empty">Loading…</p>}
      {list && list.length === 0 && <p className="m-empty">No assessments on the Host.</p>}
      <div className="m-list">
        {(list ?? []).map(a => {
          const st = s(a.status).toLowerCase();
          const tag = st.includes('progress') ? 'warn' : st.includes('complete') || st.includes('closed') ? 'ok' : '';
          return (
            <button className="m-item tappable" key={s(a.id)} onClick={() => setActive(a)}>
              <div className="m-item-body">
                <div className="m-item-title">{s(a.title)}</div>
                <div className="m-item-meta">
                  {a.assessment_type ? <span className="m-chip">{s(a.assessment_type)}</span> : null}
                  {a.status ? <span className={`m-tag ${tag}`}>{s(a.status)}</span> : null}
                  {a.planned_start_date ? <span className="m-due">{s(a.planned_start_date)}</span> : null}
                </div>
              </div>
              <span className="m-chevron">›</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Conduct({ assessment, onBack }: { assessment: Row; onBack: () => void }) {
  const [qs, setQs] = useState<Row[] | null>(null);
  const [answered, setAnswered] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Row[]>(`/assessments/${s(assessment.id)}/selected-questions`)
      .then(rows => { setQs(rows); setAnswered(rows.filter(r => r.existing_response).length); })
      .catch(e => { setQs([]); setErr((e as Error).message); });
  }, [assessment.id]);

  const sections = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const q of qs ?? []) {
      const key = s(q.section_title_at_selection || q.checklist_name || 'Questions');
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(q);
    }
    return [...map.entries()];
  }, [qs]);

  return (
    <div className="m-screen">
      <Back onBack={onBack} />
      <div className="m-screen-h">{s(assessment.title)}</div>
      {err && <p className="m-err">{err}</p>}
      {qs === null && !err && <p className="m-empty">Loading questions…</p>}
      {qs && qs.length === 0 && !err && <p className="m-empty">No questions have been selected for this assessment yet — set it up on the desktop first.</p>}
      {qs && qs.length > 0 && <div className="m-progress">{answered} / {qs.length} answered</div>}
      {sections.map(([title, rows]) => (
        <div key={title}>
          <div className="m-section-h">{title}</div>
          {rows.map(q => <QuestionCard key={s(q.question_id)} assessmentId={s(assessment.id)} q={q} onFirstAnswer={() => setAnswered(a => a + 1)} />)}
        </div>
      ))}
    </div>
  );
}

function QuestionCard({ assessmentId, q, onFirstAnswer }: { assessmentId: string; q: Row; onFirstAnswer: () => void }) {
  const [resp, setResp] = useState(s(q.existing_response));
  const [note, setNote] = useState(s(q.existing_evidence_summary));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'queued' | 'err'>('idle');
  const [hadAnswer] = useState(Boolean(q.existing_response));
  const text = s(q.question_text_at_selection || q.question_text || ('Question ' + s(q.question_id)));

  async function save(nextResp: string, noteVal: string) {
    if (!nextResp) return;
    setState('saving');
    try {
      const out = await submit(`/assessments/${assessmentId}/question-response`,
        { questionId: Number(q.question_id), response: nextResp, evidenceSummary: noteVal }, `Assessment Q${s(q.question_id)}`);
      setState(out.queued ? 'queued' : 'saved');
      if (!hadAnswer && !resp) onFirstAnswer();
    } catch (e) { setState('err'); }
  }

  return (
    <div className="m-qcard">
      <div className="m-qtext">{text}</div>
      <div className="m-rchips">
        {RESP.map(r => (
          <button key={r.v} className={`m-rchip ${r.cls} ${resp === r.v ? 'on' : ''}`} onClick={() => { setResp(r.v); save(r.v, note); }}>{r.label}</button>
        ))}
      </div>
      <input className="m-qnote" placeholder="Evidence / note (optional)" value={note} onChange={e => setNote(e.target.value)} onBlur={() => { if (resp) save(resp, note); }} />
      {state !== 'idle' && <span className={`m-qstate ${state}`}>{state === 'saving' ? 'Saving…' : state === 'saved' ? '✓ Saved' : state === 'queued' ? 'Queued offline' : 'Save failed'}</span>}
    </div>
  );
}
