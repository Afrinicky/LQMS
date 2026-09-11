import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, CheckCircle2, ClipboardList, Cpu, ExternalLink, GraduationCap,
  Loader2, Plus, Target, Trash2, TrendingUp, UserCheck, Users,
} from 'lucide-react';
import { api, apiRead, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { DetailModal, KpiStrip, Notice, RegisterSearch } from '../../components/ui';
import TextField from '../../components/ui/TextField';
import TrainerFields, {
  emptyTrainer, trainerFrom, trainerPayload, trainerProblem, type TrainerValue,
} from '../../components/training/TrainerFields';
import TrainingRecordPanel from '../../components/training/TrainingRecordPanel';
import {
  TRAINING_CATEGORIES, TRAINING_CATEGORY_LABELS, TRAINING_FORMATS, TRAINING_FORMAT_LABELS,
  TRAINING_STATUSES, TRAINING_STATUS_LABELS, ATTENDANCE_STATUSES, ATTENDANCE_STATUS_LABELS,
  TRAINING_OUTCOMES, TRAINING_OUTCOME_LABELS, TRAINING_OUTCOME_TONES,
  EFFECTIVENESS_METHODS, EFFECTIVENESS_METHOD_LABELS,
  EFFECTIVENESS_OUTCOMES, EFFECTIVENESS_OUTCOME_LABELS, EFFECTIVENESS_OUTCOME_TONES,
  trainerDisplayName,
} from '../../../shared/constants/training';
import type { Section, Staff, EquipmentItem } from '../../../shared/types/api';

/* ============================================================================
   The training register.

   What was here before was a row of eleven boxes above a five-column table.
   Two things were wrong with it, and only one of them was cosmetic.

   The real one: the trainer was a dropdown of employees. So the week the
   supplier's engineer trained four people on the new analyser, the register
   could not say who did it — and that is the training a laboratory is most
   often asked to evidence. Recording who taught and who arranged it are now
   two separate questions, asked plainly, and either can be somebody from
   outside.

   The other: a session, the people on it, and whether it did any good were
   three unrelated screens, so nobody ever got to the last one. A session now
   opens as one record — what it was, who was there and what they came away
   with, and the follow-up it owes — because that is the order the work
   actually happens in.
   ========================================================================= */

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
  effectiveness_method: string; effectiveness_due_date: string | null;
  effectiveness_outcome: string; effectiveness_notes: string | null;
  effectiveness_reviewer_name?: string | null; effectiveness_reviewed_at?: string | null;
  source_module: string | null;
  invited_count?: number; attended_count?: number;
  attendance?: Attendance[];
};

type Attendance = {
  id: number; staff_id: number; staff_name: string; employee_no: string | null; section_name: string | null;
  attendance_status: string; outcome: string; hours: number | null; remarks: string | null;
  signed_at: string | null; effectiveness_outcome: string | null;
};

type EventForm = TrainerValue & {
  title: string; description: string; objectives: string;
  category: string; trainingFormat: string;
  sectionId: string; equipmentId: string;
  trainingDate: string; endDate: string; startTime: string; endTime: string;
  durationHours: string; location: string; status: string;
  effectivenessMethod: string; effectivenessDueDate: string;
};

const emptyEvent = (): EventForm => ({
  ...emptyTrainer(),
  title: '', description: '', objectives: '',
  category: 'sop_procedure', trainingFormat: 'bench_side',
  sectionId: '', equipmentId: '',
  trainingDate: new Date().toISOString().slice(0, 10), endDate: '', startTime: '', endTime: '',
  durationHours: '', location: '', status: 'planned',
  effectivenessMethod: 'competency_assessment', effectivenessDueDate: '',
});

export default function TrainingWorkspace({ staff, sections, equipment }: {
  staff: Staff[]; sections: Section[]; equipment: EquipmentItem[];
}) {
  const { can } = usePermissions();
  const canCreate = can('personnel.training', 'create');
  const canEdit = can('personnel.training', 'edit');

  const [events, setEvents] = useState<TrainingEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'planned' | 'completed' | 'external' | 'follow_up'>('all');
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
    const today = new Date().toISOString().slice(0, 10);
    return (events ?? []).filter(e => {
      if (filter === 'planned' && e.status !== 'planned') return false;
      if (filter === 'completed' && e.status !== 'completed') return false;
      if (filter === 'external' && e.delivery_mode !== 'external' && e.trainer_type !== 'external_person') return false;
      // Outstanding means a date has passed, not that a field is blank — so the
      // list is short enough to actually be worked through.
      if (filter === 'follow_up' && !(e.effectiveness_outcome === 'pending'
        && e.effectiveness_method !== 'not_required'
        && e.effectiveness_due_date && e.effectiveness_due_date <= today)) return false;
      if (!term) return true;
      return [e.title, e.training_number, e.trainer_name, e.external_trainer_name,
        e.external_trainer_organisation, e.provider, e.location, e.equipment_name]
        .some(v => String(v ?? '').toLowerCase().includes(term));
    });
  }, [events, search, filter]);

  const stats = useMemo(() => {
    const all = events ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: all.length,
      planned: all.filter(e => e.status === 'planned').length,
      external: all.filter(e => e.delivery_mode === 'external' || e.trainer_type === 'external_person').length,
      onEquipment: all.filter(e => e.equipment_id).length,
      followUp: all.filter(e => e.effectiveness_outcome === 'pending' && e.effectiveness_method !== 'not_required'
        && e.effectiveness_due_date && e.effectiveness_due_date <= today).length,
    };
  }, [events]);

  function startNew() { setEditing(null); setForm(emptyEvent()); setShowForm(true); setError(null); }
  function startEdit(event: TrainingEvent) {
    setEditing(event);
    setForm({
      ...trainerFrom(event as unknown as Record<string, unknown>),
      title: event.title ?? '', description: event.description ?? '', objectives: event.objectives ?? '',
      category: event.category ?? 'sop_procedure', trainingFormat: event.training_format ?? 'bench_side',
      sectionId: event.section_id ? String(event.section_id) : '',
      equipmentId: event.equipment_id ? String(event.equipment_id) : '',
      trainingDate: event.training_date ?? '', endDate: event.end_date ?? '',
      startTime: event.start_time ?? '', endTime: event.end_time ?? '',
      durationHours: event.duration_hours == null ? '' : String(event.duration_hours),
      location: event.location ?? '', status: event.status ?? 'planned',
      effectivenessMethod: event.effectiveness_method ?? 'not_required',
      effectivenessDueDate: event.effectiveness_due_date ?? '',
    });
    setShowForm(true); setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    const problem = trainerProblem(form) ?? (form.title.trim() ? null : 'Give the training a title.');
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      const payload = { ...trainerPayload(form), ...form, ...trainerPayload(form) };
      if (editing) {
        await api(`/personnel/training/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        setNotice(`${editing.training_number} updated.`);
      } else {
        const made = await api<{ trainingNumber: string }>('/personnel/training', { method: 'POST', body: JSON.stringify(payload) });
        setNotice(`${made.trainingNumber} created. Add the people who are to attend.`);
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
        { label: 'Sessions on record', value: stats.total },
        { label: 'Planned', value: stats.planned, onClick: () => setFilter('planned') },
        { label: 'Externally delivered', value: stats.external, onClick: () => setFilter('external') },
        { label: 'On equipment', value: stats.onEquipment },
        { label: 'Follow-up overdue', value: stats.followUp, tone: stats.followUp ? 'warning' : undefined, onClick: () => setFilter('follow_up') },
      ]} />

      <div className="training-toolbar">
        {/* RegisterSearch rather than a plain input: the text lives inside it,
            so a keystroke re-renders one box instead of this whole workspace
            and its card list. On a register of any size that difference is a
            box that types and a box that appears to have stopped responding. */}
        <RegisterSearch className="training-search" onQuery={setSearch}
          placeholder="Search by title, number, trainer, provider or instrument" />
        <div className="training-filter">
          {([['all', 'All'], ['planned', 'Planned'], ['completed', 'Completed'],
            ['external', 'External'], ['follow_up', 'Follow-up owed']] as const).map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        {canCreate && <button type="button" className="primary" onClick={startNew}><Plus size={14} /> New training</button>}
      </div>

      {showForm && (
        <DetailModal open onClose={() => setShowForm(false)}
          title={editing ? <>Edit {editing.training_number}</> : <>New training session</>}>
          <EventFormBody form={form} setForm={setForm} staff={staff} sections={sections} equipment={equipment}
            busy={busy} editing={Boolean(editing)} onSubmit={submit} onCancel={() => setShowForm(false)} />
        </DetailModal>
      )}

      {events === null ? (
        <p className="muted"><Loader2 size={14} className="spin" /> Loading the training register…</p>
      ) : list.length === 0 ? (
        <div className="card">
          <p className="muted">
            {events.length === 0
              ? 'No training has been recorded yet. A session recorded here — or on a piece of equipment in Equipment Management — appears on every attendee’s own training file.'
              : 'Nothing matches that.'}
          </p>
        </div>
      ) : (
        <ul className="training-cards">
          {list.map(event => (
            <TrainingCard key={event.id} event={event}
              onOpen={() => void openEvent(event.id)}
              onEdit={canEdit && event.source_module !== 'equipment' ? () => startEdit(event) : undefined} />
          ))}
        </ul>
      )}

      {open && (
        <DetailModal open onClose={() => setOpen(null)}
          title={<>{open.training_number} — {open.title}</>}>
          <EventDetail event={open} staff={staff} canEdit={canEdit} canCreate={canCreate}
            onChanged={async () => { await openEvent(open.id); await load(); }}
            onError={setError} onNotice={setNotice}
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
  busy: boolean; editing: boolean;
  onSubmit: (e: FormEvent) => void; onCancel: () => void;
}) {
  const set = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm({ ...form, [key]: value });

  return (
    <form className="training-form" onSubmit={onSubmit}>
      <section>
        <h4><ClipboardList size={14} /> What the training was</h4>
        <div className="field-grid">
          <label className="wide">Title<span className="req"> *</span>
            <TextField value={form.title} onValue={v => set('title', v)} required
              placeholder="e.g. Operation of the Sysmex XN-550" /></label>
          <label>Category
            <select value={form.category} onChange={e => set('category', e.target.value)}>
              {TRAINING_CATEGORIES.map(c => <option key={c} value={c}>{TRAINING_CATEGORY_LABELS[c]}</option>)}
            </select></label>
          <label>How it was run
            <select value={form.trainingFormat} onChange={e => set('trainingFormat', e.target.value)}>
              {TRAINING_FORMATS.map(f => <option key={f} value={f}>{TRAINING_FORMAT_LABELS[f]}</option>)}
            </select></label>
          <label className="wide">What it was meant to achieve
            <TextField as="textarea" value={form.objectives} onValue={v => set('objectives', v)}
              placeholder="What should the people on it be able to do afterwards?" /></label>
          <label className="wide">Description
            <TextField as="textarea" value={form.description} onValue={v => set('description', v)} /></label>
        </div>
      </section>

      {/* The change this whole screen exists for. */}
      <section>
        <TrainerFields value={form} onChange={next => setForm({ ...form, ...next })} staff={staff} />
      </section>

      <section>
        <h4><CalendarDays size={14} /> When and where</h4>
        <div className="field-grid">
          <label>Date<span className="req"> *</span>
            <input type="date" value={form.trainingDate} onChange={e => set('trainingDate', e.target.value)} required /></label>
          <label>Ends (if more than a day)
            <input type="date" value={form.endDate} onChange={e => set('endDate', e.target.value)} /></label>
          <label>Start time<input type="time" value={form.startTime} onChange={e => set('startTime', e.target.value)} /></label>
          <label>End time<input type="time" value={form.endTime} onChange={e => set('endTime', e.target.value)} /></label>
          {/* Hours are asked for because a training file that cannot total them
              cannot answer the question it exists to answer. */}
          <label>Duration (hours)
            <input type="number" min="0" step="0.5" value={form.durationHours}
              onChange={e => set('durationHours', e.target.value)} placeholder="e.g. 3.5" /></label>
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
          <label>Status
            <select value={form.status} onChange={e => set('status', e.target.value)}>
              {TRAINING_STATUSES.map(s => <option key={s} value={s}>{TRAINING_STATUS_LABELS[s]}</option>)}
            </select></label>
        </div>
      </section>

      <section>
        <h4><Target size={14} /> How its effect will be judged</h4>
        <p className="muted section-note">
          A session is not finished when it has been held. Choosing how it will be checked, and by when, is what
          turns a list of sessions into evidence that the work changed — and it is what this register could never say.
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
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create training session'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------- a card */

function TrainingCard({ event, onOpen, onEdit }: { event: TrainingEvent; onOpen: () => void; onEdit?: () => void }) {
  const external = event.delivery_mode === 'external' || event.trainer_type === 'external_person';
  const today = new Date().toISOString().slice(0, 10);
  const followUpDue = event.effectiveness_outcome === 'pending'
    && event.effectiveness_method !== 'not_required'
    && event.effectiveness_due_date && event.effectiveness_due_date <= today;

  return (
    <li className={`training-card status-${event.status}`}>
      <div className="training-card-head">
        <div>
          <span className="training-card-ref">{event.training_number}</span>
          <h4>{event.title}</h4>
        </div>
        <span className={`badge ${event.status}`}>{TRAINING_STATUS_LABELS[event.status] ?? event.status}</span>
      </div>

      <div className="training-card-meta">
        <span><CalendarDays size={12} /> {event.training_date}</span>
        {/* Named whichever kind of trainer it was. */}
        <span><UserCheck size={12} /> {trainerDisplayName(event)}</span>
        {external && <span className="ext"><ExternalLink size={12} /> External</span>}
        {event.equipment_name && <span><Cpu size={12} /> {event.equipment_name}</span>}
        {event.section_name && <span>{event.section_name}</span>}
        {event.duration_hours ? <span>{event.duration_hours} h</span> : null}
      </div>

      <div className="training-card-foot">
        <span className="muted">
          <Users size={12} /> {event.attended_count ?? 0} attended of {event.invited_count ?? 0} on the list
        </span>
        {followUpDue && <span className="badge tone-warn">Follow-up due {event.effectiveness_due_date}</span>}
        {event.effectiveness_outcome && event.effectiveness_outcome !== 'pending' && (
          <span className={`badge tone-${EFFECTIVENESS_OUTCOME_TONES[event.effectiveness_outcome] ?? 'muted'}`}>
            {EFFECTIVENESS_OUTCOME_LABELS[event.effectiveness_outcome]}
          </span>
        )}
        <span className="grow" />
        {onEdit && <button type="button" className="ghost" onClick={onEdit}>Edit</button>}
        <button type="button" onClick={onOpen}>Open</button>
      </div>

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

function EventDetail({ event, staff, canEdit, canCreate, onChanged, onError, onNotice, onViewStaff }: {
  event: TrainingEvent; staff: Staff[]; canEdit: boolean; canCreate: boolean;
  onChanged: () => Promise<void>; onError: (m: string) => void; onNotice: (m: string) => void;
  onViewStaff: (person: { id: number; name: string }) => void;
}) {
  const [adding, setAdding] = useState({ staffId: '', attendanceStatus: 'attended', outcome: 'not_assessed', hours: '', remarks: '' });
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState({ outcome: event.effectiveness_outcome || 'pending', notes: event.effectiveness_notes ?? '' });

  const onList = new Set((event.attendance ?? []).map(a => a.staff_id));
  const available = staff.filter(s => !onList.has(s.id));

  async function addAttendee(e: FormEvent) {
    e.preventDefault();
    if (!adding.staffId) { onError('Choose who attended.'); return; }
    setBusy(true);
    try {
      await api(`/personnel/training/${event.id}/attendance`, { method: 'POST', body: JSON.stringify(adding) });
      setAdding({ staffId: '', attendanceStatus: 'attended', outcome: 'not_assessed', hours: '', remarks: '' });
      await onChanged();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function updateAttendee(row: Attendance, patch: Partial<Record<string, unknown>>) {
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

  async function removeAttendee(row: Attendance) {
    try {
      await api(`/personnel/training/${event.id}/attendance/${row.id}`, { method: 'DELETE' });
      await onChanged();
    } catch (err) { onError(errorText(err)); }
  }

  async function saveReview(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      await api(`/personnel/training/${event.id}/effectiveness`, { method: 'POST', body: JSON.stringify(review) });
      onNotice('The effectiveness review has been recorded.');
      await onChanged();
    } catch (err) { onError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="training-detail">
      <div className="training-detail-facts">
        <Fact label="Held" value={event.training_date + (event.end_date ? ` → ${event.end_date}` : '')} />
        <Fact label="Who ran it" value={event.delivery_mode === 'external' ? 'An outside body' : 'The laboratory'} />
        <Fact label="Who taught it" value={trainerDisplayName(event)} />
        {event.external_trainer_qualifications && <Fact label="Their qualification" value={event.external_trainer_qualifications} />}
        {event.provider && <Fact label="Provider" value={event.provider} />}
        {event.equipment_name && <Fact label="Equipment" value={`${event.equipment_number ?? ''} ${event.equipment_name}`.trim()} />}
        {event.location && <Fact label="Location" value={event.location} />}
        {event.duration_hours ? <Fact label="Duration" value={`${event.duration_hours} hours`} /> : null}
        <Fact label="Category" value={event.category ? (TRAINING_CATEGORY_LABELS[event.category] ?? event.category) : '—'} />
      </div>
      {event.objectives && <p className="training-objectives"><Target size={13} /> {event.objectives}</p>}

      <h4><Users size={14} /> Who was there, and what they came away with</h4>
      {(event.attendance ?? []).length === 0 ? (
        <p className="muted">Nobody on the list yet.</p>
      ) : (
        <table className="data-table attendance-table">
          <thead><tr><th>Name</th><th>Attendance</th><th>Outcome</th><th>Hours</th><th>Their file</th><th /></tr></thead>
          <tbody>
            {(event.attendance ?? []).map(row => (
              <tr key={row.id}>
                <td>
                  <strong>{row.staff_name}</strong>
                  {row.section_name && <><br /><small className="muted">{row.section_name}</small></>}
                </td>
                <td>
                  {canCreate ? (
                    <select value={row.attendance_status} onChange={e => void updateAttendee(row, { attendanceStatus: e.target.value })}>
                      {ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>)}
                    </select>
                  ) : ATTENDANCE_STATUS_LABELS[row.attendance_status] ?? row.attendance_status}
                </td>
                <td>
                  {canCreate ? (
                    <select value={row.outcome ?? 'not_assessed'} onChange={e => void updateAttendee(row, { outcome: e.target.value })}>
                      {TRAINING_OUTCOMES.map(o => <option key={o} value={o}>{TRAINING_OUTCOME_LABELS[o]}</option>)}
                    </select>
                  ) : (
                    <span className={`badge tone-${TRAINING_OUTCOME_TONES[row.outcome] ?? 'muted'}`}>
                      {TRAINING_OUTCOME_LABELS[row.outcome] ?? row.outcome}
                    </span>
                  )}
                </td>
                <td>{row.hours ?? '—'}</td>
                <td>
                  {/* The point of the whole change, reachable from here: this
                      session sits on that person's file alongside everything
                      else, wherever it was recorded. */}
                  <button type="button" className="ghost"
                    onClick={() => onViewStaff({ id: row.staff_id, name: row.staff_name })}>
                    <GraduationCap size={12} /> Open
                  </button>
                </td>
                <td>
                  {canEdit && <button type="button" className="ghost danger" onClick={() => void removeAttendee(row)}
                    aria-label={`Remove ${row.staff_name}`}><Trash2 size={13} /></button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canCreate && (
        <form className="attendance-add" onSubmit={addAttendee}>
          <label>Add somebody
            <select value={adding.staffId} onChange={e => setAdding({ ...adding, staffId: e.target.value })}>
              <option value="">Choose…</option>
              {available.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select></label>
          <label>Attendance
            <select value={adding.attendanceStatus} onChange={e => setAdding({ ...adding, attendanceStatus: e.target.value })}>
              {ATTENDANCE_STATUSES.map(s => <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>)}
            </select></label>
          <label>Outcome
            <select value={adding.outcome} onChange={e => setAdding({ ...adding, outcome: e.target.value })}>
              {TRAINING_OUTCOMES.map(o => <option key={o} value={o}>{TRAINING_OUTCOME_LABELS[o]}</option>)}
            </select></label>
          <label>Hours
            <input type="number" min="0" step="0.5" value={adding.hours}
              onChange={e => setAdding({ ...adding, hours: e.target.value })}
              placeholder={event.duration_hours ? String(event.duration_hours) : ''} /></label>
          <button type="submit" disabled={busy}><Plus size={13} /> Add</button>
        </form>
      )}

      <h4><TrendingUp size={14} /> Did it work?</h4>
      {event.effectiveness_method === 'not_required' ? (
        <p className="muted">No follow-up was asked for on this session.</p>
      ) : (
        <>
          <p className="muted">
            To be judged by {EFFECTIVENESS_METHOD_LABELS[event.effectiveness_method] ?? event.effectiveness_method}
            {event.effectiveness_due_date ? `, by ${event.effectiveness_due_date}` : ''}.
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
              <button type="submit" className="primary" disabled={busy}>
                <CheckCircle2 size={13} /> {busy ? 'Saving…' : 'Record the review'}
              </button>
            </form>
          ) : (
            <p className={`badge tone-${EFFECTIVENESS_OUTCOME_TONES[event.effectiveness_outcome] ?? 'muted'}`}>
              {EFFECTIVENESS_OUTCOME_LABELS[event.effectiveness_outcome]}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="training-fact"><span>{label}</span><strong>{value || '—'}</strong></div>;
}
