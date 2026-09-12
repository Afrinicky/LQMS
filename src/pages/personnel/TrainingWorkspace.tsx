import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CalendarDays, CalendarClock, CheckCircle2, ClipboardList, Cpu, ExternalLink,
  GraduationCap, Loader2, Lock, PenLine, PlayCircle, Plus, Repeat, Settings2, SquareCheck,
  StopCircle, Target, Trash2, TrendingUp, UserCheck, Users, XCircle,
} from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { DetailModal, KpiStrip, Notice, RegisterSearch } from '../../components/ui';
import TextField from '../../components/ui/TextField';
import TrainerFields, {
  emptyTrainer, trainerFrom, trainerPayload, trainerProblem, type TrainerValue,
} from '../../components/training/TrainerFields';
import TrainingRecordPanel from '../../components/training/TrainingRecordPanel';
import { PrintButton } from './competencyShared';
import {
  TRAINING_CATEGORIES, TRAINING_CATEGORY_LABELS, TRAINING_FORMATS, TRAINING_FORMAT_LABELS,
  TRAINING_STATUS_LABELS, TRAINING_STATUS_TONES, TRAINING_STATUS_NEXT_STEP,
  TRAINING_MODES, TRAINING_MODE_LABELS, TRAINING_MODE_HINTS,
  TRAINING_FREQUENCIES, TRAINING_FREQUENCY_LABELS,
  ATTENDANCE_STATUSES, ATTENDANCE_STATUS_LABELS,
  TRAINING_OUTCOMES, TRAINING_OUTCOME_LABELS, TRAINING_OUTCOME_TONES,
  EFFECTIVENESS_METHODS, EFFECTIVENESS_METHOD_LABELS,
  EFFECTIVENESS_OUTCOMES, EFFECTIVENESS_OUTCOME_LABELS, EFFECTIVENESS_OUTCOME_TONES,
  trainerDisplayName, trainingIsLocked, attendedInPerson, recurrenceSummary, nextTrainingDate,
} from '../../../shared/constants/training';
import type { Section, Staff, EquipmentItem } from '../../../shared/types/api';

/* ============================================================================
   The training register.

   WHAT WAS WRONG WITH THIS SCREEN, and it was not the layout. A session was a
   row with a status dropdown. Anybody could open a session from three years ago
   and edit it, including its status, so there was no moment at which a session
   stopped being a draft and became the laboratory's record of what happened.
   Everything a laboratory actually does around training therefore had nowhere
   to go: scheduling it and telling the people expected at it, postponing it,
   running it, taking the attendance, signing it off, and having it come round
   again next month.

   So the screen is now the workflow, in the order the work happens:

     SCHEDULE — the session and everybody expected at it, in one form. They are
                told immediately, and again when the day comes.
     RUN      — start it, mark who came, have them sign the sheet.
     CLOSE    — a senior role reviews it and signs. That is what disseminates
                it to everybody's file and locks it.

   Each card says the one thing its session is waiting for, which is most of
   what makes this simple: nobody has to know the model to use the screen.

   And editing is gone from plain sight. A closed session has no Edit button at
   all; a senior role finds amend, reopen and delete folded away under "Senior
   actions", where a deliberate correction belongs and a casual one does not
   happen.
   ========================================================================= */

type Attendance = {
  id: number; staff_id: number; staff_name: string; employee_no: string | null;
  sheet_designation: string | null; section_name: string | null;
  attendance_status: string; outcome: string; hours: number | null; remarks: string | null;
  signed_at: string | null; marked_by_name: string | null; marked_at: string | null;
  has_signature_on_file: number; effectiveness_outcome: string | null;
  remedial_number: string | null; time_in: string | null; time_out: string | null;
};

type TrainingEvent = {
  id: number; training_number: string; title: string; description: string | null;
  category: string | null; training_type: string | null; training_format: string | null;
  delivery_mode: string; trainer_type: string; trainer_staff_id: number | null;
  trainer_name: string | null; external_trainer_name: string | null;
  external_trainer_organisation: string | null; external_trainer_qualifications: string | null;
  provider: string | null; objectives: string | null;
  section_id: number | null; section_name: string | null;
  equipment_id: number | null; equipment_name: string | null; equipment_number: string | null;
  training_date: string; end_date: string | null; start_time: string | null; end_time: string | null;
  duration_hours: number | null; location: string | null; status: string;
  training_mode: string; frequency: string; frequency_interval_days: number | null;
  series_parent_id: number | null; series_index: number | null; series_ends_on: string | null;
  series_parent_number: string | null;
  postponed_from_date: string | null; postponement_reason: string | null;
  cancellation_reason: string | null; cancelled_by_name: string | null;
  closed_at: string | null; closed_by_name: string | null; closure_summary: string | null;
  notified_at: string | null; reminder_sent_at: string | null;
  remedial_for_event_id: number | null; remedial_for_number: string | null; remedial_for_staff_name: string | null;
  effectiveness_method: string; effectiveness_due_date: string | null;
  effectiveness_outcome: string; effectiveness_notes: string | null;
  effectiveness_reviewer_name?: string | null; effectiveness_reviewed_at?: string | null;
  source_module: string | null;
  invited_count?: number; attended_count?: number; signed_count?: number;
  locked?: boolean; may_manage_closed?: boolean;
  attendance?: Attendance[];
};

type EventForm = TrainerValue & {
  trainingMode: string;
  title: string; description: string; objectives: string;
  category: string; trainingFormat: string;
  sectionId: string; equipmentId: string;
  trainingDate: string; endDate: string; startTime: string; endTime: string;
  durationHours: string; location: string;
  frequency: string; frequencyIntervalDays: string; seriesEndsOn: string;
  effectivenessMethod: string; effectivenessDueDate: string;
  participantStaffIds: string[];
};

const emptyEvent = (): EventForm => ({
  ...emptyTrainer(),
  trainingMode: 'scheduled',
  title: '', description: '', objectives: '',
  category: 'sop_procedure', trainingFormat: 'bench_side',
  sectionId: '', equipmentId: '',
  trainingDate: new Date().toISOString().slice(0, 10), endDate: '', startTime: '', endTime: '',
  durationHours: '', location: '',
  frequency: 'none', frequencyIntervalDays: '', seriesEndsOn: '',
  effectivenessMethod: 'competency_assessment', effectivenessDueDate: '',
  participantStaffIds: [],
});

type Filter = 'all' | 'scheduled' | 'running' | 'awaiting_closure' | 'closed' | 'called_off' | 'external' | 'follow_up';

const today = () => new Date().toISOString().slice(0, 10);

/** Is a follow-up review actually overdue, as opposed to a field being blank? */
function followUpOverdue(event: TrainingEvent): boolean {
  return event.effectiveness_outcome === 'pending'
    && event.effectiveness_method !== 'not_required'
    && Boolean(event.effectiveness_due_date) && String(event.effectiveness_due_date) <= today();
}

export default function TrainingWorkspace({ staff, sections, equipment }: {
  staff: Staff[]; sections: Section[]; equipment: EquipmentItem[];
}) {
  const { can } = usePermissions();
  const canCreate = can('personnel.training', 'create');
  const canEdit = can('personnel.training', 'edit');
  // The senior roles: the administrator, the laboratory manager, the quality
  // manager. Closing a session, reopening a closed one and deleting one are
  // theirs, and the screen asks the same question the server enforces.
  const canClose = can('personnel.training', 'approve');
  const canPrint = can('personnel.training', 'print');

  const [events, setEvents] = useState<TrainingEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TrainingEvent | null>(null);
  const [form, setForm] = useState<EventForm>(emptyEvent);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<TrainingEvent | null>(null);
  const [viewStaff, setViewStaff] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setEvents(await apiRead<TrainingEvent[]>('/personnel/training', []));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const list = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (events ?? []).filter(e => {
      if (filter === 'scheduled' && !(e.status === 'planned' || e.status === 'postponed')) return false;
      if (filter === 'running' && e.status !== 'in_progress') return false;
      if (filter === 'awaiting_closure' && e.status !== 'completed') return false;
      if (filter === 'closed' && e.status !== 'closed') return false;
      if (filter === 'called_off' && e.status !== 'cancelled') return false;
      if (filter === 'external' && e.delivery_mode !== 'external' && e.trainer_type !== 'external_person') return false;
      if (filter === 'follow_up' && !followUpOverdue(e)) return false;
      if (!term) return true;
      return [e.title, e.training_number, e.trainer_name, e.external_trainer_name,
        e.external_trainer_organisation, e.provider, e.location, e.equipment_name]
        .some(v => String(v ?? '').toLowerCase().includes(term));
    });
  }, [events, search, filter]);

  const stats = useMemo(() => {
    const all = events ?? [];
    const year = new Date().getFullYear();
    return {
      scheduled: all.filter(e => e.status === 'planned' || e.status === 'postponed').length,
      running: all.filter(e => e.status === 'in_progress').length,
      // The number this register could never show, and the one that matters:
      // sessions that have been held and never signed off.
      awaitingClosure: all.filter(e => e.status === 'completed').length,
      closedThisYear: all.filter(e => e.status === 'closed' && Number(String(e.training_date).slice(0, 4)) === year).length,
      followUp: all.filter(followUpOverdue).length,
    };
  }, [events]);

  function startNew(mode: 'scheduled' | 'retrospective') {
    setEditing(null);
    setForm({ ...emptyEvent(), trainingMode: mode, effectivenessMethod: mode === 'retrospective' ? 'direct_observation' : 'competency_assessment' });
    setShowForm(true); setError(null);
  }

  function startEdit(event: TrainingEvent) {
    setEditing(event);
    setForm({
      ...trainerFrom(event as unknown as Record<string, unknown>),
      trainingMode: event.training_mode ?? 'scheduled',
      title: event.title ?? '', description: event.description ?? '', objectives: event.objectives ?? '',
      category: event.category ?? 'sop_procedure', trainingFormat: event.training_format ?? 'bench_side',
      sectionId: event.section_id ? String(event.section_id) : '',
      equipmentId: event.equipment_id ? String(event.equipment_id) : '',
      trainingDate: event.training_date ?? '', endDate: event.end_date ?? '',
      startTime: event.start_time ?? '', endTime: event.end_time ?? '',
      durationHours: event.duration_hours == null ? '' : String(event.duration_hours),
      location: event.location ?? '',
      frequency: event.frequency ?? 'none',
      frequencyIntervalDays: event.frequency_interval_days == null ? '' : String(event.frequency_interval_days),
      seriesEndsOn: event.series_ends_on ?? '',
      effectivenessMethod: event.effectiveness_method ?? 'not_required',
      effectivenessDueDate: event.effectiveness_due_date ?? '',
      // Participants are only part of creating a session; an existing one has an
      // attendance sheet, and people are added to that from the session itself.
      participantStaffIds: [],
    });
    setShowForm(true); setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    const problem = trainerProblem(form)
      ?? (form.title.trim() ? null : 'Give the training a title.')
      ?? (editing || form.participantStaffIds.length > 0 ? null
        : 'Choose who the training is for. A session with nobody on it is not a training record.');
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      const payload = { ...form, ...trainerPayload(form) };
      if (editing) {
        await api(`/personnel/training/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setNotice(trainingIsLocked(editing.status)
          ? `${editing.training_number} amended. The change is recorded against your name in the audit trail.`
          : `${editing.training_number} updated.`);
      } else {
        const made = await api<{ trainingNumber: string; invited: number; notified: number; status: string }>(
          '/personnel/training', { method: 'POST', body: JSON.stringify(payload) });
        setNotice(made.status === 'planned'
          ? `${made.trainingNumber} scheduled. ${made.notified} of ${made.invited} on the list have been sent a notice, and they will be reminded when the day comes.`
          : `${made.trainingNumber} recorded with ${made.invited} on the attendance sheet. Mark who attended, then close it.`);
      }
      setShowForm(false); setEditing(null); setForm(emptyEvent());
      await load();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function openEvent(id: number) {
    try { setOpen(await api<TrainingEvent>(`/personnel/training/${id}`)); }
    catch (err) { setError(errorText(err)); }
  }

  return (
    <div className="training-workspace">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <KpiStrip items={[
        { label: 'Scheduled', value: stats.scheduled, onClick: () => setFilter('scheduled') },
        { label: 'Running now', value: stats.running, onClick: () => setFilter('running') },
        {
          label: 'Held, not yet closed', value: stats.awaitingClosure,
          tone: stats.awaitingClosure ? 'warning' : undefined, onClick: () => setFilter('awaiting_closure'),
        },
        { label: `Closed in ${new Date().getFullYear()}`, value: stats.closedThisYear, onClick: () => setFilter('closed') },
        {
          label: 'Follow-up overdue', value: stats.followUp,
          tone: stats.followUp ? 'warning' : undefined, onClick: () => setFilter('follow_up'),
        },
      ]} />

      <div className="training-toolbar">
        {/* RegisterSearch rather than a plain input: the text lives inside it,
            so a keystroke re-renders one box instead of this whole workspace
            and its card list. On a register of any size that difference is a
            box that types and a box that appears to have stopped responding. */}
        <RegisterSearch className="training-search" onQuery={setSearch}
          placeholder="Search by title, number, trainer, provider or instrument" />
        <div className="training-filter">
          {([['all', 'All'], ['scheduled', 'Scheduled'], ['running', 'Running'],
            ['awaiting_closure', 'To close'], ['closed', 'Closed'], ['called_off', 'Called off'],
            ['external', 'External'], ['follow_up', 'Follow-up owed']] as const).map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        {canCreate && (
          <div className="training-new">
            <button type="button" className="primary" onClick={() => startNew('scheduled')}>
              <CalendarClock size={14} /> Schedule training
            </button>
            {/* The other half of a real register, and it was never a first-class
                action: most of what goes on a training register is somebody
                writing down a session that has already been given. */}
            <button type="button" onClick={() => startNew('retrospective')}>
              <Plus size={14} /> Record past training
            </button>
          </div>
        )}
      </div>

      {showForm && (
        <DetailModal open onClose={() => setShowForm(false)}
          title={editing ? <>Edit {editing.training_number}</> : form.trainingMode === 'scheduled'
            ? <>Schedule a training session</> : <>Record training that has been held</>}>
          <EventFormBody form={form} setForm={setForm} staff={staff} sections={sections} equipment={equipment}
            busy={busy} editing={editing} onSubmit={submit} onCancel={() => setShowForm(false)} />
        </DetailModal>
      )}

      {events === null ? (
        <p className="muted"><Loader2 size={14} className="spin" /> Loading the training register…</p>
      ) : list.length === 0 ? (
        <div className="card">
          <p className="muted">
            {events.length === 0
              ? 'No training has been recorded yet. Schedule a session and everybody expected at it is told; or record one that has already been held. Either way it appears on every attendee’s own training file once it is closed.'
              : 'Nothing matches that.'}
          </p>
        </div>
      ) : (
        <ul className="training-cards">
          {list.map(event => (
            <TrainingCard key={event.id} event={event}
              onOpen={() => void openEvent(event.id)}
              // No Edit button on a finished record, for anybody. A senior role
              // amends it from inside the session, deliberately.
              onEdit={canEdit && !trainingIsLocked(event.status) && event.source_module !== 'equipment'
                ? () => startEdit(event) : undefined} />
          ))}
        </ul>
      )}

      {open && (
        <DetailModal open onClose={() => setOpen(null)}
          title={<>{open.training_number} — {open.title}</>}
          subtitle={TRAINING_STATUS_NEXT_STEP[open.status] ?? undefined}
          header={canPrint || (open.attendance ?? []).length > 0 ? (
            <div className="training-print-actions">
              <PrintButton path={`/personnel/training/${open.id}/print`} label="Training report"
                title="The whole session, including the attendance sheet" />
              {!trainingIsLocked(open.status) && (
                <PrintButton path={`/personnel/training/${open.id}/print?sheet=blank`} label="Blank sheet"
                  title="An attendance sheet to carry to the session and have signed by hand" />
              )}
            </div>
          ) : undefined}>
          <EventDetail event={open} staff={staff} canEdit={canEdit} canCreate={canCreate} canClose={canClose}
            onChanged={async () => { await openEvent(open.id); await load(); }}
            onClosedAway={async () => { setOpen(null); await load(); }}
            onError={setError} onNotice={setNotice}
            onAmend={() => { setOpen(null); startEdit(open); }}
            onViewStaff={person => setViewStaff(person)} />
        </DetailModal>
      )}

      {viewStaff && (
        <DetailModal open onClose={() => setViewStaff(null)} title={<>{viewStaff.name} — training file</>}>
          <TrainingRecordPanel staffId={viewStaff.id} title={`${viewStaff.name}'s training`} />
        </DetailModal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ the form */

function EventFormBody({ form, setForm, staff, sections, equipment, busy, editing, onSubmit, onCancel }: {
  form: EventForm; setForm: (next: EventForm) => void;
  staff: Staff[]; sections: Section[]; equipment: EquipmentItem[];
  busy: boolean; editing: TrainingEvent | null;
  onSubmit: (e: FormEvent) => void; onCancel: () => void;
}) {
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm({ ...form, [key]: value });
  const scheduled = form.trainingMode === 'scheduled';
  const amending = Boolean(editing && trainingIsLocked(editing.status));

  return (
    <form className="training-form" onSubmit={onSubmit}>
      {amending && (
        <Notice kind="warn">
          <strong>{editing?.training_number} is closed.</strong> It is the laboratory&apos;s record of this training and it
          is on the file of everybody who attended. Changing it now is recorded against your name as an amendment to a
          closed record.
        </Notice>
      )}

      {!editing && (
        <section>
          <h4><CalendarClock size={14} /> Which of these is it?</h4>
          <div className="mode-choice">
            {TRAINING_MODES.map(mode => (
              <label key={mode} className={form.trainingMode === mode ? 'on' : ''}>
                <input type="radio" name="trainingMode" value={mode} checked={form.trainingMode === mode}
                  onChange={() => set('trainingMode', mode)} />
                <span>
                  <strong>{TRAINING_MODE_LABELS[mode]}</strong>
                  <small>{TRAINING_MODE_HINTS[mode]}</small>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4><ClipboardList size={14} /> What the training {scheduled && !editing ? 'is' : 'was'}</h4>
        <div className="field-grid">
          <label className="wide">Title<span className="req"> *</span>
            <TextField value={form.title} onValue={v => set('title', v)} required
              placeholder="e.g. Operation of the Sysmex XN-550" /></label>
          <label>Category
            <select value={form.category} onChange={e => set('category', e.target.value)}>
              {TRAINING_CATEGORIES.map(c => <option key={c} value={c}>{TRAINING_CATEGORY_LABELS[c]}</option>)}
            </select></label>
          <label>How it {scheduled && !editing ? 'will be' : 'was'} run
            <select value={form.trainingFormat} onChange={e => set('trainingFormat', e.target.value)}>
              {TRAINING_FORMATS.map(f => <option key={f} value={f}>{TRAINING_FORMAT_LABELS[f]}</option>)}
            </select></label>
          <label className="wide">What it {scheduled && !editing ? 'is' : 'was'} meant to achieve
            <TextField as="textarea" value={form.objectives} onValue={v => set('objectives', v)}
              placeholder="What should the people on it be able to do afterwards?" /></label>
          <label className="wide">Description
            <TextField as="textarea" value={form.description} onValue={v => set('description', v)} /></label>
        </div>
      </section>

      {/* Either kind of trainer, asked the same way on every screen that asks. */}
      <section>
        <TrainerFields value={form} onChange={next => setForm({ ...form, ...next })} staff={staff} />
      </section>

      <section>
        <h4><CalendarDays size={14} /> When and where</h4>
        <div className="field-grid">
          <label>{scheduled && !editing ? 'Date it will be held' : 'Date held'}<span className="req"> *</span>
            <input type="date" value={form.trainingDate} onChange={e => set('trainingDate', e.target.value)} required /></label>
          <label>Ends (if more than a day)
            <input type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} /></label>
          <label>Start time<input type="time" value={form.startTime} onChange={e => set('startTime', e.target.value)} /></label>
          <label>End time<input type="time" value={form.endTime} onChange={e => set('endTime', e.target.value)} /></label>
          {/* Hours are asked for because a training file that cannot total them
              cannot answer the question it exists to answer, and because these
              hours are attributed to everybody who attends when it closes. */}
          <label>Duration (hours)
            <input type="number" min="0" step="0.5" value={form.durationHours}
              onChange={e => set('durationHours', e.target.value)} placeholder="e.g. 3.5" />
            <small className="muted">Credited to everybody who attends, when the session is closed.</small>
          </label>
          <label>Location<TextField value={form.location} onValue={v => set('location', v)} /></label>
          <label>Unit / section
            <select value={form.sectionId} onChange={e => set('sectionId', e.target.value)}>
              <option value="">Whole laboratory</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label>Equipment it was about
            <select value={form.equipmentId} onChange={e => set('equipmentId', e.target.value)}>
              <option value="">Not about a specific instrument</option>
              {equipment.map(e2 => <option key={e2.id} value={e2.id}>{e2.equipment_number} — {e2.name}</option>)}
            </select></label>
        </div>
      </section>

      {/* Recurrence. Most real training is not a one-off — safety, the quality
          manual, the annual refresher — and every occurrence used to depend on
          somebody remembering to create it. */}
      <section>
        <h4><Repeat size={14} /> Does it come round again?</h4>
        <p className="muted section-note">
          A recurring session raises its next occurrence automatically when this one is closed, with the same people
          invited — and each occurrence is reviewed for effect in its own right. A one-off is reviewed once.
        </p>
        <div className="field-grid">
          <label>How often
            <select value={form.frequency} onChange={e => set('frequency', e.target.value)}>
              {TRAINING_FREQUENCIES.map(f => <option key={f} value={f}>{TRAINING_FREQUENCY_LABELS[f]}</option>)}
            </select></label>
          {form.frequency === 'custom' && (
            <label>Days between sessions<span className="req"> *</span>
              <input type="number" min="1" step="1" value={form.frequencyIntervalDays}
                onChange={e => set('frequencyIntervalDays', e.target.value)} placeholder="e.g. 45" /></label>
          )}
          {form.frequency !== 'none' && (
            <>
              <label>Stop repeating after
                <input type="date" value={form.seriesEndsOn} onChange={e => set('seriesEndsOn', e.target.value)} />
                <small className="muted">Left blank, the series runs until somebody stops it.</small>
              </label>
              <p className="muted next-occurrence">
                {nextTrainingDate(form.trainingDate, form.frequency, Number(form.frequencyIntervalDays) || null)
                  ? <>Next one after this would fall on <strong>{nextTrainingDate(form.trainingDate, form.frequency, Number(form.frequencyIntervalDays) || null)}</strong>.</>
                  : 'Give the interval and the next date can be worked out.'}
              </p>
            </>
          )}
        </div>
      </section>

      {/* Who it is for. Part of creating the session, because training is given
          to groups and a register where the group is a separate second step is a
          register full of sessions with nobody on them. */}
      {!editing && (
        <section>
          <h4><Users size={14} /> Who it is for<span className="req"> *</span></h4>
          <p className="muted section-note">
            Tick everybody expected at the session — a whole unit, a few people, or one person on their own.
            {form.trainingMode === 'scheduled'
              ? ' Each of them is sent a notice now, and reminded the day before.'
              : ' Each of them goes onto the attendance sheet, where you then mark who actually came.'}
          </p>
          <ParticipantPicker staff={staff} sections={sections}
            chosen={form.participantStaffIds} onChange={next => set('participantStaffIds', next)} />
        </section>
      )}

      <section>
        <h4><Target size={14} /> How its effect will be judged</h4>
        <p className="muted section-note">
          A session is not finished when it has been held. Choosing how it will be checked, and by when, is what
          turns a list of sessions into evidence that the work changed.
        </p>
        <div className="field-grid">
          <label>Method
            <select value={form.effectivenessMethod} onChange={e => set('effectivenessMethod', e.target.value)}>
              {EFFECTIVENESS_METHODS.map(m => <option key={m} value={m}>{EFFECTIVENESS_METHOD_LABELS[m]}</option>)}
            </select></label>
          {form.effectivenessMethod !== 'not_required' && (
            <label>Review by
              <input type="date" value={form.effectivenessDueDate}
                onChange={e => set('effectivenessDueDate', e.target.value)} />
              <small className="muted">Left blank, this is set to three months after the training.</small>
            </label>
          )}
        </div>
      </section>

      <div className="form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…'
            : editing ? (amending ? 'Save amendment to closed record' : 'Save changes')
              : form.trainingMode === 'scheduled' ? 'Schedule it and notify everybody' : 'Record the session'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Everybody expected at the session, ticked off a list.
 *
 * Grouped by unit and with "everybody in this unit" as one click, because the
 * monthly safety briefing is for a unit and selecting twenty names one at a time
 * is precisely the friction that left sessions with nobody on them.
 */
function ParticipantPicker({ staff, sections, chosen, onChange }: {
  staff: Staff[]; sections: Section[]; chosen: string[]; onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const picked = new Set(chosen);
  const term = filter.trim().toLowerCase();
  const shown = staff.filter(s => !term
    || [s.fullName, s.designation, s.employeeNo, s.sectionName].some(v => String(v ?? '').toLowerCase().includes(term)));

  const toggle = (id: string) => onChange(picked.has(id) ? chosen.filter(x => x !== id) : [...chosen, id]);
  const addAll = (ids: string[]) => onChange([...new Set([...chosen, ...ids])]);

  const bySection = sections
    .map(section => ({ section, people: shown.filter(s => s.sectionId === section.id) }))
    .filter(group => group.people.length > 0);
  const unassigned = shown.filter(s => !s.sectionId || !sections.some(sec => sec.id === s.sectionId));

  const group = (label: string, people: Staff[], key: string) => (
    <div className="pp-group" key={key}>
      <div className="pp-group-head">
        <strong>{label}</strong>
        <button type="button" className="ghost" onClick={() => addAll(people.map(p => String(p.id)))}>
          <SquareCheck size={12} /> Everybody here
        </button>
      </div>
      <div className="trainee-list">
        {people.map(person => (
          <label key={person.id} className="trainee-option">
            <input type="checkbox" checked={picked.has(String(person.id))} onChange={() => toggle(String(person.id))} />
            <span>
              {person.fullName}
              {person.designation ? <small className="muted"> · {person.designation}</small> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="participant-picker">
      <div className="pp-toolbar">
        <input type="search" value={filter} onChange={e => setFilter(e.target.value)}
          placeholder="Filter by name, grade or unit" aria-label="Filter the staff list" />
        <span className="pp-count">
          {chosen.length === 0 ? 'Nobody chosen yet'
            : `${chosen.length} ${chosen.length === 1 ? 'person' : 'people'} on the list`}
        </span>
        {chosen.length > 0 && <button type="button" className="ghost" onClick={() => onChange([])}>Clear</button>}
      </div>
      <div className="pp-groups">
        {bySection.map(g => group(g.section.name, g.people, `sec-${g.section.id}`))}
        {unassigned.length > 0 && group('No unit recorded', unassigned, 'none')}
        {shown.length === 0 && <p className="muted">Nobody matches that.</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- a card */

function TrainingCard({ event, onOpen, onEdit }: { event: TrainingEvent; onOpen: () => void; onEdit?: () => void }) {
  const external = event.delivery_mode === 'external' || event.trainer_type === 'external_person';
  const series = recurrenceSummary(event.frequency, event.frequency_interval_days);
  const overdue = followUpOverdue(event);
  const tone = TRAINING_STATUS_TONES[event.status] ?? 'muted';

  return (
    <li className={`training-card status-${event.status}`}>
      <div className="training-card-head">
        <div>
          <span className="training-card-ref">{event.training_number}</span>
          <h4>{event.title}</h4>
        </div>
        <span className={`badge tone-${tone}`}>{TRAINING_STATUS_LABELS[event.status] ?? event.status}</span>
      </div>

      <div className="training-card-meta">
        <span><CalendarDays size={12} /> {event.training_date}</span>
        {/* Named whichever kind of trainer it was. */}
        <span><UserCheck size={12} /> {trainerDisplayName(event)}</span>
        {external && <span className="ext"><ExternalLink size={12} /> External</span>}
        {series && <span><Repeat size={12} /> {series}</span>}
        {event.equipment_name && <span><Cpu size={12} /> {event.equipment_name}</span>}
        {event.section_name && <span>{event.section_name}</span>}
        {event.duration_hours ? <span>{event.duration_hours} h</span> : null}
      </div>

      {/* The one line that makes this register usable without knowing the
          model: what this session is waiting for, right now. */}
      <p className="training-next-step">
        {event.status === 'postponed' && event.postponed_from_date
          ? `Postponed from ${event.postponed_from_date}. ${TRAINING_STATUS_NEXT_STEP[event.status]}`
          : TRAINING_STATUS_NEXT_STEP[event.status] ?? ''}
      </p>

      <div className="training-card-foot">
        <span className="muted">
          <Users size={12} /> {event.attended_count ?? 0} attended of {event.invited_count ?? 0} on the list
          {(event.signed_count ?? 0) > 0 && ` · ${event.signed_count} signed`}
        </span>
        {overdue && <span className="badge tone-warn">Follow-up due {event.effectiveness_due_date}</span>}
        {event.effectiveness_outcome && event.effectiveness_outcome !== 'pending' && (
          <span className={`badge tone-${EFFECTIVENESS_OUTCOME_TONES[event.effectiveness_outcome] ?? 'muted'}`}>
            {EFFECTIVENESS_OUTCOME_LABELS[event.effectiveness_outcome]}
          </span>
        )}
        {event.status === 'closed' && <span className="badge tone-ok"><Lock size={11} /> Closed record</span>}
        <span className="grow" />
        {onEdit && <button type="button" className="ghost" onClick={onEdit}>Edit</button>}
        <button type="button" onClick={onOpen}>Open</button>
      </div>

      {event.remedial_for_number && (
        <p className="training-card-note">
          <AlertTriangle size={12} /> Individual retraining for {event.remedial_for_staff_name ?? 'a member of staff'},
          arranged because {event.remedial_for_number} did not work for them.
        </p>
      )}
      {event.source_module === 'equipment' && (
        <p className="training-card-note">
          <Cpu size={12} /> Recorded against a piece of equipment. Equipment Management owns this record; changing it
          there updates it here.
        </p>
      )}
    </li>
  );
}

/* ---------------------------------------------------------------- the detail */

function EventDetail({ event, staff, canEdit, canCreate, canClose, onChanged, onClosedAway, onError, onNotice, onAmend, onViewStaff }: {
  event: TrainingEvent; staff: Staff[]; canEdit: boolean; canCreate: boolean; canClose: boolean;
  onChanged: () => Promise<void>; onClosedAway: () => Promise<void>;
  onError: (m: string) => void; onNotice: (m: string) => void;
  onAmend: () => void;
  onViewStaff: (person: { id: number; name: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [review, setReview] = useState({ outcome: event.effectiveness_outcome || 'pending', notes: event.effectiveness_notes ?? '' });
  const [closure, setClosure] = useState('');
  const [ask, setAsk] = useState<null | 'postpone' | 'cancel' | 'reopen' | 'delete'>(null);
  const [askReason, setAskReason] = useState('');
  const [askDate, setAskDate] = useState(event.training_date);

  const locked = trainingIsLocked(event.status);
  const attendance = event.attendance ?? [];
  const present = attendance.filter(a => attendedInPerson(a.attendance_status));
  const unaccounted = attendance.filter(a => a.attendance_status === 'invited');
  const onList = new Set(attendance.map(a => a.staff_id));
  const available = staff.filter(s => !onList.has(s.id));
  const series = recurrenceSummary(event.frequency, event.frequency_interval_days);
  // Equipment owns its own records, so the lifecycle buttons would be writing
  // into a record another module maintains.
  const ownedElsewhere = event.source_module === 'equipment';

  const act = async (path: string, body: unknown, message: string, after: 'reload' | 'away' = 'reload') => {
    setBusy(true);
    try {
      const answer = await api<any>(`/personnel/training/${event.id}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
      onNotice(typeof answer?.__message === 'string' ? answer.__message : message);
      setAsk(null); setAskReason('');
      if (after === 'away') await onClosedAway(); else await onChanged();
      return answer;
    } catch (err) { onError(errorText(err)); return null; }
    finally { setBusy(false); }
  };

  async function addPeople() {
    if (adding.length === 0) { onError('Choose at least one person to add.'); return; }
    setBusy(true);
    try {
      const answer = await api<{ added: number }>(`/personnel/training/${event.id}/participants`, {
        method: 'POST', body: JSON.stringify({ staffIds: adding }),
      });
      onNotice(`${answer.added} added to the session${event.status === 'planned' ? ' and sent a notice' : ''}.`);
      setAdding([]); setShowAdd(false);
      await onChanged();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function updateAttendee(row: Attendance, patch: Record<string, unknown>) {
    try {
      await api(`/personnel/training/${event.id}/attendance`, {
        method: 'POST',
        body: JSON.stringify({
          staffId: row.staff_id, attendanceStatus: row.attendance_status, outcome: row.outcome,
          hours: row.hours ?? '', remarks: row.remarks ?? '', ...patch,
        }),
      });
      await onChanged();
    } catch (err) { onError(errorText(err)); }
  }

  async function markEverybodyPresent() {
    setBusy(true);
    try {
      for (const row of unaccounted) {
        await api(`/personnel/training/${event.id}/attendance`, {
          method: 'POST',
          body: JSON.stringify({ staffId: row.staff_id, attendanceStatus: 'attended', outcome: row.outcome || 'not_assessed' }),
        });
      }
      await onChanged();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function removeAttendee(row: Attendance) {
    try {
      await api(`/personnel/training/${event.id}/attendance/${row.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) { onError(errorText(err)); }
  }

  async function signFor(row: Attendance) {
    try {
      await api(`/personnel/training/${event.id}/attendance/${row.id}/sign`, {
        method: 'POST', body: JSON.stringify({ onPaper: true }),
      });
      onNotice(`${row.staff_name}'s signature on the paper sheet has been recorded. The paper sheet remains the original.`);
      await onChanged();
    } catch (err) { onError(errorText(err)); }
  }

  async function close() {
    const answer = await act('/close', { closureSummary: closure },
      'Closed. It is now on the training file of everybody who attended, and on their portal.');
    if (!answer) return;
    const extras: string[] = [];
    if (Array.isArray(answer.remedial) && answer.remedial.length > 0) {
      extras.push(`Individual retraining has been scheduled for ${answer.remedial.length} ${answer.remedial.length === 1 ? 'person' : 'people'} the session did not work for (${answer.remedial.map((r: any) => r.trainingNumber).join(', ')}).`);
    }
    if (answer.nextOccurrence) {
      extras.push(`The next one in the series, ${answer.nextOccurrence.trainingNumber}, is scheduled for ${answer.nextOccurrence.date} with the same people invited.`);
    }
    if (extras.length) onNotice(`Closed and disseminated. ${extras.join(' ')}`);
  }

  async function saveReview(e: FormEvent) {
    e.preventDefault();
    await act('/effectiveness', review, 'The effectiveness review has been recorded and signed.');
  }

  return (
    <div className="training-detail">
      {/* Where this session is, and the one thing it needs next. */}
      <div className={`training-stage stage-${event.status}`}>
        <span className={`badge tone-${TRAINING_STATUS_TONES[event.status] ?? 'muted'}`}>
          {TRAINING_STATUS_LABELS[event.status] ?? event.status}
        </span>
        <p>{TRAINING_STATUS_NEXT_STEP[event.status]}</p>
      </div>

      {locked && (
        <Notice kind="info">
          <Lock size={13} />{' '}
          {event.status === 'cancelled'
            ? <>This session was called off{event.cancelled_by_name ? ` by ${event.cancelled_by_name}` : ''}. It is kept so the
                training programme can account for it.</>
            : <>Closed{event.closed_by_name ? ` by ${event.closed_by_name}` : ''}{event.closed_at ? ` on ${String(event.closed_at).slice(0, 10)}` : ''} and
                signed. This is the laboratory&apos;s record of the training and it is on the file of everybody who attended.
                {event.may_manage_closed ? ' You may reopen or amend it under Senior actions below.' : ''}</>}
        </Notice>
      )}

      <div className="training-detail-facts">
        <Fact label="Held" value={event.training_date + (event.end_date ? ` → ${event.end_date}` : '')} />
        <Fact label="Time" value={[event.start_time, event.end_time].filter(Boolean).join(' – ')} />
        <Fact label="Who ran it" value={event.delivery_mode === 'external' ? 'An outside body' : 'The laboratory'} />
        <Fact label="Who taught it" value={trainerDisplayName(event)} />
        {event.external_trainer_qualifications && <Fact label="Their qualification" value={event.external_trainer_qualifications} />}
        {event.provider && <Fact label="Provider" value={event.provider} />}
        {event.equipment_name && <Fact label="Equipment" value={`${event.equipment_number ?? ''} ${event.equipment_name}`.trim()} />}
        {event.location && <Fact label="Location" value={event.location} />}
        {event.duration_hours ? <Fact label="Duration" value={`${event.duration_hours} hours`} /> : null}
        <Fact label="Category" value={event.category ? (TRAINING_CATEGORY_LABELS[event.category] ?? event.category) : '—'} />
        {series && <Fact label="Recurs" value={`${series}${event.series_index ? ` · occurrence ${event.series_index}` : ''}`} />}
        {event.postponed_from_date && <Fact label="Postponed from" value={event.postponed_from_date} />}
        {event.notified_at && <Fact label="Notices sent" value={String(event.notified_at).slice(0, 10)} />}
      </div>

      {event.objectives && <p className="training-objectives"><Target size={13} /> {event.objectives}</p>}
      {event.postponement_reason && (
        <p className="training-card-note"><CalendarClock size={12} /> Postponed: {event.postponement_reason}</p>
      )}
      {event.cancellation_reason && (
        <p className="training-card-note"><XCircle size={12} /> Called off: {event.cancellation_reason}</p>
      )}
      {event.remedial_for_number && (
        <p className="training-card-note">
          <AlertTriangle size={12} /> Individual retraining for {event.remedial_for_staff_name ?? 'a member of staff'},
          arising from {event.remedial_for_number}.
        </p>
      )}

      {/* ---- Running the session ---- */}
      {!locked && !ownedElsewhere && canEdit && (
        <div className="training-actions">
          {(event.status === 'planned' || event.status === 'postponed') && (
            <button type="button" className="primary" disabled={busy}
              onClick={() => void act('/start', {}, 'The session is running. Mark everybody who came.')}>
              <PlayCircle size={14} /> Start the session
            </button>
          )}
          {event.status === 'in_progress' && (
            <button type="button" disabled={busy}
              onClick={() => void act('/hold', {}, 'Recorded as held. The documentation is outstanding until a senior role closes it.')}>
              <StopCircle size={14} /> End the session
            </button>
          )}
          {(event.status === 'planned' || event.status === 'postponed' || event.status === 'in_progress') && (
            <>
              <button type="button" onClick={() => { setAsk('postpone'); setAskDate(event.training_date); }}>
                <CalendarClock size={14} /> Postpone
              </button>
              <button type="button" className="ghost danger" onClick={() => setAsk('cancel')}>
                <XCircle size={14} /> Call it off
              </button>
            </>
          )}
        </div>
      )}

      {ask === 'postpone' && (
        <form className="training-ask" onSubmit={e => { e.preventDefault(); void act('/postpone', { trainingDate: askDate, reason: askReason }, 'Postponed. Everybody expected at it has been told the new date.'); }}>
          <h5><CalendarClock size={13} /> Postpone this session</h5>
          <p className="muted">Everybody on the list is told that it has moved, and told the new date.</p>
          <label>New date<input type="date" value={askDate} onChange={e => setAskDate(e.target.value)} required /></label>
          <label className="wide">Why<TextField value={askReason} onValue={setAskReason} required
            placeholder="e.g. The analyser engineer's visit was moved" /></label>
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy}>Postpone and notify</button>
            <button type="button" className="ghost" onClick={() => setAsk(null)}>Cancel</button>
          </div>
        </form>
      )}

      {ask === 'cancel' && (
        <form className="training-ask" onSubmit={e => { e.preventDefault(); void act('/cancel', { reason: askReason }, 'Called off. Everybody expected at it has been told.'); }}>
          <h5><XCircle size={13} /> Call this session off</h5>
          <p className="muted">
            The session is kept on the register as one that was planned and did not happen, so the programme can
            account for it. Everybody on the list is told.
          </p>
          <label className="wide">Why<TextField value={askReason} onValue={setAskReason} required
            placeholder="e.g. The provider withdrew the course" /></label>
          <div className="form-actions">
            <button type="submit" className="primary" disabled={busy}>Call it off and notify</button>
            <button type="button" className="ghost" onClick={() => setAsk(null)}>Keep it</button>
          </div>
        </form>
      )}

      {/* ---- The attendance sheet ---- */}
      <h4><Users size={14} /> Attendance sheet</h4>
      <p className="muted section-note">
        The same sheet as every other signing sheet here: name, the designation held at the time, the signature and
        the date. A supervisor marks who came; each person signs for themselves, from this screen or their own portal.
        {present.length > 0 && ` ${attendance.filter(a => a.signed_at).length} of ${present.length} who attended have signed.`}
      </p>

      {attendance.length === 0 ? (
        <p className="muted">Nobody on the list yet.</p>
      ) : (
        <table className="data-table attendance-table">
          <thead><tr>
            <th>Name</th><th>Designation</th><th>Attendance</th><th>Outcome</th><th>Hours</th>
            <th>Signature</th><th>Their file</th><th />
          </tr></thead>
          <tbody>
            {attendance.map(row => (
              <tr key={row.id} className={row.attendance_status === 'invited' ? 'unaccounted' : undefined}>
                <td>
                  <strong>{row.staff_name}</strong>
                  {row.employee_no && <><br /><small className="muted">{row.employee_no}</small></>}
                </td>
                {/* Snapshot at signing, not joined live: a sheet signed three
                    years ago has to keep saying what grade the person held then. */}
                <td>{row.sheet_designation || <span className="muted">—</span>}</td>
                <td>
                  {canCreate && !locked ? (
                    <select value={row.attendance_status} onChange={e => void updateAttendee(row, { attendanceStatus: e.target.value })}>
                      {ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>)}
                    </select>
                  ) : ATTENDANCE_STATUS_LABELS[row.attendance_status] ?? row.attendance_status}
                  {row.marked_by_name && <><br /><small className="muted">marked by {row.marked_by_name}</small></>}
                </td>
                <td>
                  {canCreate && !locked ? (
                    <select value={row.outcome ?? 'not_assessed'} onChange={e => void updateAttendee(row, { outcome: e.target.value })}>
                      {TRAINING_OUTCOMES.map(o => <option key={o} value={o}>{TRAINING_OUTCOME_LABELS[o]}</option>)}
                    </select>
                  ) : (
                    <span className={`badge tone-${TRAINING_OUTCOME_TONES[row.outcome] ?? 'muted'}`}>
                      {TRAINING_OUTCOME_LABELS[row.outcome] ?? row.outcome}
                    </span>
                  )}
                  {row.remedial_number && <><br /><small className="muted">retraining {row.remedial_number}</small></>}
                </td>
                <td>{row.hours ?? '—'}</td>
                <td>
                  {row.signed_at
                    ? <span className="badge tone-ok"><PenLine size={11} /> {String(row.signed_at).slice(0, 10)}</span>
                    : attendedInPerson(row.attendance_status)
                      ? (canEdit && !locked
                        ? <button type="button" className="ghost" title="Record that this person signed the paper attendance sheet"
                            onClick={() => void signFor(row)}><PenLine size={12} /> Signed on paper</button>
                        : <span className="muted">Not signed</span>)
                      : <span className="muted">—</span>}
                </td>
                <td>
                  {/* Their whole training file, from here: this session sits on
                      it alongside everything else, wherever it was recorded. */}
                  <button type="button" className="ghost"
                    onClick={() => onViewStaff({ id: row.staff_id, name: row.staff_name })}>
                    <GraduationCap size={12} /> Open
                  </button>
                </td>
                <td>
                  {canEdit && !locked && !row.signed_at && (
                    <button type="button" className="ghost danger" onClick={() => void removeAttendee(row)}
                      aria-label={`Remove ${row.staff_name}`}><Trash2 size={13} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canCreate && !locked && (
        <div className="training-actions">
          {unaccounted.length > 0 && (
            <button type="button" disabled={busy} onClick={() => void markEverybodyPresent()}>
              <SquareCheck size={14} /> Mark all {unaccounted.length} remaining as attended
            </button>
          )}
          <button type="button" onClick={() => setShowAdd(v => !v)}>
            <Plus size={14} /> Add people to this session
          </button>
        </div>
      )}

      {showAdd && canCreate && !locked && (
        <div className="training-ask">
          <h5><Users size={13} /> Add people</h5>
          <ParticipantPicker staff={available} sections={[]} chosen={adding} onChange={setAdding} />
          <div className="form-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void addPeople()}>
              Add {adding.length > 0 ? `${adding.length} ` : ''}to the session
            </button>
            <button type="button" className="ghost" onClick={() => { setShowAdd(false); setAdding([]); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* ---- Closing it ---- */}
      {!locked && !ownedElsewhere && (
        <>
          <h4><CheckCircle2 size={14} /> Review and close</h4>
          {canClose ? (
            <form className="training-ask" onSubmit={e => { e.preventDefault(); void close(); }}>
              <p className="muted">
                Closing is what makes this a record. You are signing that the session and its attendance sheet are
                complete and correct; it then goes onto the training file of everybody who attended and onto their
                portal, and it is out of reach of ordinary editing.
                {series && ' The next occurrence in the series will be scheduled, with the same people invited.'}
                {present.some(a => a.outcome === 'unsatisfactory' || a.outcome === 'needs_further_training')
                  && ' Anybody the session did not work for will have individual retraining scheduled for them alone.'}
              </p>
              {unaccounted.length > 0 && (
                <Notice kind="warn">
                  {unaccounted.length} {unaccounted.length === 1 ? 'person is' : 'people are'} still marked only as
                  invited. Say who came and who did not — a closed sheet has to account for everybody on it.
                </Notice>
              )}
              <label className="wide">Closing note
                <TextField as="textarea" value={closure} onValue={setClosure}
                  placeholder="Anything the record should say about how the session went." /></label>
              <div className="form-actions">
                <button type="submit" className="primary" disabled={busy || unaccounted.length > 0 || present.length === 0}>
                  <CheckCircle2 size={14} /> {busy ? 'Closing…' : 'Review, sign and close'}
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">
              This session is held but not yet closed. Closing it is done by the administrator, the laboratory manager
              or the quality manager, who signs for the record. Until then it is not on anybody&apos;s file.
            </p>
          )}
        </>
      )}

      {/* ---- Did it work? ---- */}
      <h4><TrendingUp size={14} /> Did it work?</h4>
      {event.effectiveness_method === 'not_required' ? (
        <p className="muted">No follow-up was asked for on this session.</p>
      ) : (
        <>
          <p className="muted">
            To be judged by {EFFECTIVENESS_METHOD_LABELS[event.effectiveness_method] ?? event.effectiveness_method}
            {event.effectiveness_due_date ? `, by ${event.effectiveness_due_date}` : ''}.
            {series
              ? ' This session recurs, so its effect is reviewed each time it comes round.'
              : ' A one-off session, reviewed once.'}
            {event.effectiveness_reviewed_at && ` Reviewed ${String(event.effectiveness_reviewed_at).slice(0, 10)}`}
            {event.effectiveness_reviewer_name && ` by ${event.effectiveness_reviewer_name}`}.
          </p>
          {canEdit ? (
            <form className="effectiveness-form" onSubmit={saveReview}>
              <label>Finding
                <select value={review.outcome} onChange={e => setReview({ ...review, outcome: e.target.value })}>
                  {EFFECTIVENESS_OUTCOMES.map(o => <option key={o} value={o}>{EFFECTIVENESS_OUTCOME_LABELS[o]}</option>)}
                </select></label>
              <label className="wide">What was found
                <TextField as="textarea" value={review.notes} onValue={v => setReview({ ...review, notes: v })}
                  placeholder="What changed in the work — or what did not, and what is being done about it." /></label>
              <p className="muted wide">
                Recording the review signs it with your signature on file. A finding of &ldquo;not effective&rdquo; against
                somebody schedules individual retraining for them.
              </p>
              <button type="submit" className="primary" disabled={busy}>
                <CheckCircle2 size={13} /> {busy ? 'Saving…' : 'Record and sign the review'}
              </button>
            </form>
          ) : (
            <p className={`badge tone-${EFFECTIVENESS_OUTCOME_TONES[event.effectiveness_outcome] ?? 'muted'}`}>
              {EFFECTIVENESS_OUTCOME_LABELS[event.effectiveness_outcome]}
            </p>
          )}
        </>
      )}

      {event.closure_summary && (
        <>
          <h4><ClipboardList size={14} /> Closing note</h4>
          <p className="training-closure-note">{event.closure_summary}</p>
        </>
      )}

      {/* ---- Senior actions, deliberately out of plain sight ----
          A closed record that can be edited from a button on the list is not a
          record. A laboratory still has to be able to correct its own file, so
          the means exist — folded away, senior-only, and audited. */}
      {canClose && (locked || canEdit) && !ownedElsewhere && (
        <details className="senior-actions">
          <summary><Settings2 size={13} /> Senior actions</summary>
          <p className="muted">
            Reserved to the administrator, the laboratory manager and the quality manager. Everything here is recorded
            against your name in the audit trail.
          </p>
          <div className="training-actions">
            {locked && event.status === 'closed' && (
              <button type="button" onClick={() => setAsk('reopen')}>Reopen this closed record</button>
            )}
            {locked && event.status === 'closed' && (
              <button type="button" className="ghost" onClick={onAmend}>Amend the closed record</button>
            )}
            {!locked && <button type="button" className="ghost" onClick={onAmend}>Edit this session</button>}
            <button type="button" className="ghost danger" onClick={() => setAsk('delete')}>Delete</button>
          </div>

          {ask === 'reopen' && (
            <form className="training-ask" onSubmit={e => { e.preventDefault(); void act('/reopen', { reason: askReason }, 'Reopened. It is no longer a closed record until it is closed again.'); }}>
              <label className="wide">Why is this closed record being reopened?<span className="req"> *</span>
                <TextField value={askReason} onValue={setAskReason} required
                  placeholder="e.g. An outcome was recorded against the wrong person" /></label>
              <div className="form-actions">
                <button type="submit" className="primary" disabled={busy}>Reopen</button>
                <button type="button" className="ghost" onClick={() => setAsk(null)}>Leave it closed</button>
              </div>
            </form>
          )}

          {ask === 'delete' && (
            <div className="training-ask">
              <p>
                <strong>Deleting is almost always the wrong thing.</strong> A session that is not going ahead should be
                called off, so the programme can still account for it. Delete only a record created in error. A session
                anybody has signed for cannot be deleted at all.
              </p>
              <div className="form-actions">
                <button type="button" className="danger" disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/personnel/training/${event.id}`, { method: 'DELETE' });
                      onNotice(`${event.training_number} deleted.`);
                      await onClosedAway();
                    } catch (err) { onError(errorText(err)); }
                    finally { setBusy(false); }
                  }}>
                  Delete {event.training_number}
                </button>
                <button type="button" className="ghost" onClick={() => setAsk(null)}>Keep it</button>
              </div>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="training-fact"><span>{label}</span><strong>{value || '—'}</strong></div>;
}
