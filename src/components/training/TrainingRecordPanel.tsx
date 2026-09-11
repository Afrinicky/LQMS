import { useEffect, useMemo, useState } from 'react';
import {
  Award, BookOpenCheck, Building2, Clock, Cpu, ExternalLink, FileCheck2,
  GraduationCap, Loader2, ShieldCheck, UserCheck,
} from 'lucide-react';
import { apiRead } from '../../services/api';
import {
  TRAINING_ORIGIN_LABELS, TRAINING_ORIGIN_HINTS, TRAINING_CATEGORY_LABELS,
  TRAINING_FORMAT_LABELS, TRAINING_OUTCOME_LABELS, TRAINING_OUTCOME_TONES,
  ATTENDANCE_STATUS_LABELS, EFFECTIVENESS_OUTCOME_LABELS, EFFECTIVENESS_OUTCOME_TONES,
  summariseTrainingRecord, type TrainingRecordEntry,
} from '../../../shared/constants/training';

/**
 * One person's training file.
 *
 * The panel exists because the answer to "what training has this person had?"
 * was spread across four modules that did not know about one another, and
 * nobody could give it without opening four screens and adding up by hand. It
 * is deliberately the SAME component on the staff profile, in the portal and
 * beside an equipment competence form, so the three never disagree about
 * somebody's training — which is exactly what happens when three screens each
 * build their own answer.
 *
 * Where a record was made is shown as a tag and used for nothing else. Training
 * given on an analyser and entered in Equipment Management is this person's
 * training in precisely the way a course they were sent on is.
 *
 * Two numbers are stated rather than implied. Hours count only the sessions
 * that actually recorded a duration, and the count of those that did not is
 * shown beside the total — a training file that quietly reports "12 hours" when
 * half its records carry no duration is worse than one that admits it.
 */

const ORIGIN_ICON: Record<string, typeof GraduationCap> = {
  personnel: GraduationCap,
  equipment: Cpu,
  self_declared: BookOpenCheck,
  competency: ShieldCheck,
  orientation: UserCheck,
};

type Props = {
  /** Whose file. Omit for the signed-in person's own. */
  staffId?: number | null;
  title?: string;
  /** Rows supplied by a page that already loaded them, instead of fetching. */
  entries?: TrainingRecordEntry[];
  compact?: boolean;
};

export default function TrainingRecordPanel({ staffId, title = 'Training file', entries: given, compact }: Props) {
  const [entries, setEntries] = useState<TrainingRecordEntry[] | null>(given ?? null);
  const [origin, setOrigin] = useState<string>('all');

  useEffect(() => {
    if (given) { setEntries(given); return; }
    let live = true;
    const path = staffId ? `/personnel/training-record/${staffId}` : '/personnel/my-training-record';
    void apiRead<{ entries: TrainingRecordEntry[] }>(path, { entries: [] })
      .then(answer => { if (live) setEntries(answer.entries ?? []); });
    return () => { live = false; };
  }, [staffId, given]);

  const summary = useMemo(() => summariseTrainingRecord(entries ?? []), [entries]);
  const origins = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of entries ?? []) seen.set(e.origin, (seen.get(e.origin) ?? 0) + 1);
    return [...seen.entries()];
  }, [entries]);
  const shown = (entries ?? []).filter(e => origin === 'all' || e.origin === origin);

  if (!entries) {
    return <div className="card training-file"><p className="muted"><Loader2 size={14} className="spin" /> Reading the training file…</p></div>;
  }

  return (
    <div className={`card training-file${compact ? ' compact' : ''}`}>
      <div className="training-file-head">
        <h3><GraduationCap size={16} /> {title}</h3>
        <p className="muted">
          Everything recorded anywhere in the system, in one place — sessions the laboratory ran, training given on
          an instrument, courses declared on the portal, and the assessments that show any of it worked.
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="muted empty-line">Nothing on file yet. Training recorded in Personnel Management, on a piece of
          equipment, or declared on this person&apos;s own portal will appear here.</p>
      ) : (
        <>
          <div className="training-stats">
            <Stat label="Records" value={summary.total} />
            <Stat label={`In ${new Date().getFullYear()}`} value={summary.thisYear} />
            <Stat label="Hours recorded" value={summary.hours ? summary.hours.toFixed(1) : '—'}
              note={summary.withoutHours ? `${summary.withoutHours} without a duration` : undefined} />
            <Stat label="Externally delivered" value={summary.external} />
            <Stat label="On equipment" value={summary.onEquipment} />
            {summary.awaitingVerification > 0 && (
              <Stat label="Awaiting verification" value={summary.awaitingVerification} tone="warn" />
            )}
            {summary.effectivenessOutstanding > 0 && (
              <Stat label="Follow-up owed" value={summary.effectivenessOutstanding} tone="warn" />
            )}
            {/* An attendance sheet this person was marked present at and has not
                signed. It is stated because the session cannot be closed until
                it is signed, so it is outstanding work rather than a cosmetic
                gap in the file. */}
            {summary.awaitingSignature > 0 && (
              <Stat label="Sheets to sign" value={summary.awaitingSignature} tone="warn" />
            )}
            {summary.scheduled > 0 && <Stat label="Still to come" value={summary.scheduled} />}
          </div>

          {origins.length > 1 && (
            <div className="training-filter">
              <button type="button" className={origin === 'all' ? 'on' : ''} onClick={() => setOrigin('all')}>
                All ({entries.length})
              </button>
              {origins.map(([key, count]) => (
                <button key={key} type="button" className={origin === key ? 'on' : ''}
                  title={TRAINING_ORIGIN_HINTS[key]} onClick={() => setOrigin(key)}>
                  {TRAINING_ORIGIN_LABELS[key] ?? key} ({count})
                </button>
              ))}
            </div>
          )}

          <ul className="training-timeline">
            {shown.map(entry => <Entry key={`${entry.origin}-${entry.sourceId}`} entry={entry} />)}
          </ul>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string | number; note?: string; tone?: 'warn' }) {
  return (
    <div className={`training-stat${tone ? ` ${tone}` : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
      {note && <em>{note}</em>}
    </div>
  );
}

function Entry({ entry }: { entry: TrainingRecordEntry }) {
  const Icon = ORIGIN_ICON[entry.origin] ?? GraduationCap;
  const outcomeTone = TRAINING_OUTCOME_TONES[String(entry.outcome)] ?? 'muted';
  const effectTone = EFFECTIVENESS_OUTCOME_TONES[String(entry.effectivenessOutcome)] ?? 'muted';

  return (
    <li className={`training-entry origin-${entry.origin}`}>
      <span className="training-entry-icon"><Icon size={15} /></span>
      <div className="training-entry-body">
        <div className="training-entry-top">
          <strong>{entry.title}</strong>
          <span className="training-origin-tag" title={TRAINING_ORIGIN_HINTS[entry.origin]}>
            {TRAINING_ORIGIN_LABELS[entry.origin] ?? entry.origin}
          </span>
          {entry.deliveryMode === 'external' && (
            <span className="training-origin-tag external"><ExternalLink size={11} /> Externally delivered</span>
          )}
        </div>

        <div className="training-entry-meta">
          <span>{entry.date ? entry.date : 'No date recorded'}{entry.endDate && entry.endDate !== entry.date ? ` → ${entry.endDate}` : ''}</span>
          {/* The trainer, whichever kind. This line was blank for every session
              an outside trainer gave, which was most of the ones that mattered. */}
          {entry.trainerName && entry.trainerName !== '—' && <span><UserCheck size={12} /> {entry.trainerName}</span>}
          {entry.provider && <span><Building2 size={12} /> {entry.provider}</span>}
          {entry.hours ? <span><Clock size={12} /> {entry.hours} h</span> : null}
          {entry.equipmentName && <span><Cpu size={12} /> {entry.equipmentName}</span>}
          {entry.location && <span>{entry.location}</span>}
          {entry.format && <span>{TRAINING_FORMAT_LABELS[entry.format] ?? entry.format.replace(/_/g, ' ')}</span>}
          {entry.category && <span>{TRAINING_CATEGORY_LABELS[entry.category] ?? entry.category.replace(/_/g, ' ')}</span>}
          {entry.reference && <span className="faint">{entry.reference}</span>}
        </div>

        <div className="training-entry-tags">
          {/* A session still to come, or held and not yet signed off, is not the
              same thing as a record — and a file that cannot tell them apart
              reads as a list of claims. */}
          {entry.status === 'planned' && <span className="badge tone-warn">Scheduled</span>}
          {entry.status === 'postponed' && <span className="badge tone-warn">Postponed</span>}
          {entry.status === 'in_progress' && <span className="badge tone-live">Running now</span>}
          {entry.status === 'completed' && <span className="badge tone-warn">Awaiting closure</span>}
          {entry.status === 'cancelled' && <span className="badge tone-bad">Called off</span>}
          {entry.attendanceStatus && entry.attendanceStatus !== 'attended' && (
            <span className="badge">{ATTENDANCE_STATUS_LABELS[entry.attendanceStatus] ?? entry.attendanceStatus}</span>
          )}
          {entry.signedAt && <span className="badge tone-ok">Signed {String(entry.signedAt).slice(0, 10)}</span>}
          {entry.outcome && entry.outcome !== 'not_assessed' && (
            <span className={`badge tone-${outcomeTone}`}>
              <Award size={11} /> {TRAINING_OUTCOME_LABELS[entry.outcome] ?? entry.outcome.replace(/_/g, ' ')}
            </span>
          )}
          {entry.effectivenessOutcome && entry.effectivenessOutcome !== 'pending' && (
            <span className={`badge tone-${effectTone}`}>
              {EFFECTIVENESS_OUTCOME_LABELS[entry.effectivenessOutcome] ?? entry.effectivenessOutcome}
            </span>
          )}
          {/* Outstanding only when a date was actually set, so "follow-up owed"
              means a date has passed rather than a field was left blank. */}
          {entry.effectivenessOutcome === 'pending' && entry.effectivenessDueDate && (
            <span className="badge tone-warn">Follow-up due {entry.effectivenessDueDate}</span>
          )}
          {entry.verificationStatus === 'declared' && (
            <span className="badge tone-warn"><FileCheck2 size={11} /> Declared — not yet verified</span>
          )}
          {entry.verificationStatus === 'verified' && (
            <span className="badge tone-ok"><FileCheck2 size={11} /> Verified</span>
          )}
        </div>

        {entry.notes && <p className="training-entry-note">{entry.notes}</p>}
      </div>
    </li>
  );
}
