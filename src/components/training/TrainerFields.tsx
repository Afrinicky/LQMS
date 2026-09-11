import { GraduationCap, UserCheck, Users } from 'lucide-react';
import {
  TRAINING_DELIVERY_MODES, TRAINING_DELIVERY_LABELS, TRAINING_DELIVERY_HINTS,
  TRAINER_TYPES, TRAINER_TYPE_LABELS, TRAINER_TYPE_HINTS,
} from '../../../shared/constants/training';
import TextField from '../ui/TextField';

/**
 * Who ran the training, and who taught it.
 *
 * This block is the whole fix, and it is deliberately one component used by
 * both the personnel training form and the equipment competence form. Those
 * two screens asked the same question in two different ways and both got it
 * wrong the same way — a dropdown of employees and nothing else — so when the
 * supplier's engineer spent a day training four people on the new analyser,
 * neither screen could record who did it.
 *
 * Two questions, asked in this order, because the answers are independent:
 *
 *   Who arranged it?  Internal or external. This is about the session.
 *   Who taught it?    A member of staff, or somebody from outside.
 *
 * They do not follow from one another. An in-house refresher can be taught by
 * a visiting specialist, and one of our own scientists can teach on somebody
 * else's course — so neither field is inferred from the other, and choosing
 * "external" does not silently change the trainer.
 *
 * When the trainer is from outside, three boxes appear. Only the name is
 * required: an organisation and a line about what qualifies them is what an
 * assessor asks for, but a laboratory that has the engineer's name and nothing
 * else should still be able to record the training rather than be blocked by a
 * form demanding his employer.
 */
export type TrainerValue = {
  deliveryMode: string;
  trainerType: string;
  trainerStaffId: string;
  externalTrainerName: string;
  externalTrainerOrganisation: string;
  externalTrainerQualifications: string;
  provider: string;
};

export const emptyTrainer = (): TrainerValue => ({
  deliveryMode: 'internal',
  trainerType: 'internal_staff',
  trainerStaffId: '',
  externalTrainerName: '',
  externalTrainerOrganisation: '',
  externalTrainerQualifications: '',
  provider: '',
});

/** Read a saved record back into the form, whichever kind of trainer it holds. */
export function trainerFrom(row: Record<string, unknown> | null | undefined): TrainerValue {
  if (!row) return emptyTrainer();
  const text = (key: string) => (row[key] == null ? '' : String(row[key]));
  return {
    deliveryMode: text('delivery_mode') || 'internal',
    trainerType: text('trainer_type') || 'internal_staff',
    trainerStaffId: text('trainer_staff_id'),
    externalTrainerName: text('external_trainer_name'),
    externalTrainerOrganisation: text('external_trainer_organisation'),
    externalTrainerQualifications: text('external_trainer_qualifications'),
    provider: text('provider'),
  };
}

/** What to send. The kind not chosen is sent empty rather than left stale. */
export function trainerPayload(v: TrainerValue) {
  const external = v.trainerType === 'external_person';
  return {
    deliveryMode: v.deliveryMode,
    trainerType: v.trainerType,
    trainerStaffId: external ? '' : v.trainerStaffId,
    externalTrainerName: external ? v.externalTrainerName.trim() : '',
    externalTrainerOrganisation: external ? v.externalTrainerOrganisation.trim() : '',
    externalTrainerQualifications: external ? v.externalTrainerQualifications.trim() : '',
    provider: v.provider.trim(),
  };
}

/** The one thing that must be true before this can be saved. */
export function trainerProblem(v: TrainerValue): string | null {
  if (v.trainerType === 'external_person' && !v.externalTrainerName.trim()) {
    return 'Name the trainer who came from outside.';
  }
  return null;
}

type Props = {
  value: TrainerValue;
  onChange: (next: TrainerValue) => void;
  staff: Array<{ id: number; fullName: string }>;
  /** Shown when the trainer is external — a course provider, a supplier. */
  providerLabel?: string;
  disabled?: boolean;
};

export default function TrainerFields({ value, onChange, staff, providerLabel = 'Provider / organisation', disabled }: Props) {
  const set = <K extends keyof TrainerValue>(key: K, next: TrainerValue[K]) => onChange({ ...value, [key]: next });
  const external = value.trainerType === 'external_person';

  return (
    <div className="trainer-fields">
      <fieldset className="choice-set" disabled={disabled}>
        <legend><Users size={13} /> Who ran this training?</legend>
        <div className="choice-row">
          {TRAINING_DELIVERY_MODES.map(mode => (
            <label key={mode} className={`choice ${value.deliveryMode === mode ? 'on' : ''}`}>
              <input type="radio" name="delivery-mode" value={mode}
                checked={value.deliveryMode === mode}
                onChange={() => set('deliveryMode', mode)} />
              <span className="choice-label">{TRAINING_DELIVERY_LABELS[mode]}</span>
              <span className="choice-hint">{TRAINING_DELIVERY_HINTS[mode]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="choice-set" disabled={disabled}>
        <legend><GraduationCap size={13} /> Who delivered it?</legend>
        <div className="choice-row">
          {TRAINER_TYPES.map(type => (
            <label key={type} className={`choice ${value.trainerType === type ? 'on' : ''}`}>
              <input type="radio" name="trainer-type" value={type}
                checked={value.trainerType === type}
                onChange={() => set('trainerType', type)} />
              <span className="choice-label">{TRAINER_TYPE_LABELS[type]}</span>
              <span className="choice-hint">{TRAINER_TYPE_HINTS[type]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="trainer-detail">
        {external ? (
          <>
            <label>
              Trainer&apos;s name<span className="req"> *</span>
              <TextField value={value.externalTrainerName} disabled={disabled}
                onValue={next => set('externalTrainerName', next)}
                placeholder="e.g. Kwame Boateng, application specialist" />
            </label>
            <label>
              Organisation they came from
              <TextField value={value.externalTrainerOrganisation} disabled={disabled}
                onValue={next => set('externalTrainerOrganisation', next)}
                placeholder="e.g. Sysmex West Africa" />
            </label>
            <label>
              What qualifies them to teach it
              <TextField value={value.externalTrainerQualifications} disabled={disabled}
                onValue={next => set('externalTrainerQualifications', next)}
                placeholder="e.g. Certified XN-series engineer" />
            </label>
          </>
        ) : (
          <label>
            <UserCheck size={13} /> Trainer
            <select value={value.trainerStaffId} disabled={disabled}
              onChange={e => set('trainerStaffId', e.target.value)}>
              <option value="">Not recorded</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </label>
        )}
        {/* The provider is asked whichever kind of trainer taught, because a
            course run by a national programme and taught by one of our own
            scientists still has a provider, and the certificate carries it. */}
        {(external || value.deliveryMode === 'external') && (
          <label>
            {providerLabel}
            <TextField value={value.provider} disabled={disabled}
              onValue={next => set('provider', next)}
              placeholder="Who provided or accredited the training" />
          </label>
        )}
      </div>
    </div>
  );
}
