import { Building2 } from 'lucide-react';
import type { RoutineUnit } from '../../../shared/types/api';

/**
 * Whose unit a routine register is showing.
 *
 * Almost nobody sees this. A routine register belongs to a unit and the unit
 * comes from the reader's own staff record, so for bench staff and unit heads
 * alike the server offers exactly one unit and this renders nothing at all.
 *
 * The administrator, the Quality Manager and the Laboratory Manager are the
 * exception: they answer for every unit's programme, and being pinned to the
 * unit their staff record happens to name meant they could not open, set up or
 * sign off another unit's charts. For them the register says which units it
 * will show, and this is where they say which one.
 */
export default function RegisterUnitPicker({ units, canChooseUnit, sectionId, onPick, hint }: {
  units?: RoutineUnit[] | null;
  canChooseUnit?: boolean;
  sectionId: number | null;
  onPick: (id: number) => void;
  hint?: string;
}) {
  const list = units ?? [];
  if (!canChooseUnit || list.length < 2) return null;
  return (
    <div className="rw-unit-pick">
      <label>
        <span><Building2 size={12} /> Unit</span>
        <select value={sectionId ?? ''} onChange={e => onPick(Number(e.target.value))}>
          {list.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
      <span className="muted">{hint ?? 'You answer for every unit’s routine programme, so you can read and work any of them.'}</span>
    </div>
  );
}
