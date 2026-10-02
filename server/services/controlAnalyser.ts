/**
 * Which analyser links belong to a control — one rule, used by both screens.
 *
 * THE RULE: a link belongs to a control when it is registered against the
 * INSTRUMENT that control runs on. Not the unit it sits in, not "the only
 * analyser this laboratory owns", and nothing else.
 *
 * It is narrow on purpose. A control run is a statement about one instrument's
 * performance: CLSI C24 has the laboratory keep a mean, a standard deviation
 * and a Levey-Jennings chart for each instrument separately, and ISO 15189 has
 * it demonstrate comparability BETWEEN instruments — neither of which survives
 * a run filed against a machine it was not run on. An accepted run cannot be
 * un-attributed afterwards, so offering the wrong analyser is not a small
 * inconvenience; it is a false record with a real name on it. A haematology
 * analyser was being offered on a GeneXpert control because it was the only
 * link the laboratory had.
 *
 * THE ONE THING THAT IS NOT THE SAME AS "the same equipment row": a laboratory
 * registers one machine twice. "SYSMEX XN-550" is entered for the link and
 * "Sysmex XN550" for the control, and they are the same analyser standing in
 * the same corner of the same room. Refusing that would take a working link
 * away from a bench over a space and a hyphen. So a link also belongs when its
 * instrument is the SAME MACHINE under another spelling — matched on the name
 * with case, spaces and punctuation set aside, or on the asset number where
 * both rows carry one.
 *
 * That distinction is the whole point: two names for one machine, yes; two
 * machines in one room, never.
 */

/** A name with case, spacing and punctuation set aside, for comparing two rows. */
function normalise(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sameMachine(a: unknown, b: unknown): boolean {
  const left = normalise(a);
  return left.length > 0 && left === normalise(b);
}

export interface ControlLinkRow {
  id: number; name: string; mode: string; role: string; state: string;
  equipment_id: number | null; section_id: number | null;
  equipment_name: string | null; equipment_number: string | null;
  last_message_at: string | null; last_error: string | null;
  [key: string]: unknown;
}

/**
 * Every active link on this control's instrument, the ones the bridge will
 * actually open first.
 *
 * Returns nothing at all for a control that does not say which instrument it
 * runs on — a manual method has no analyser, and saying so plainly is better
 * than offering one.
 */
export function linksForControl(db: any, material: any): ControlLinkRow[] {
  if (material?.equipment_id == null) return [];
  const machine = db.prepare('SELECT id, name, equipment_number FROM equipment_items WHERE id = ?')
    .get(material.equipment_id) as any;
  if (!machine) return [];

  let rows: ControlLinkRow[] = [];
  try {
    rows = db.prepare(`SELECT l.*, e.name AS equipment_name, e.equipment_number AS equipment_number
        FROM instrument_links l JOIN equipment_items e ON e.id = l.equipment_id
        WHERE l.is_active = 1
        ORDER BY (l.state IN ('listening','connected','following')) DESC, l.name`).all() as ControlLinkRow[];
  } catch { return []; }

  return rows.filter(l =>
    Number(l.equipment_id) === Number(machine.id)
    || sameMachine(l.equipment_name, machine.name)
    || sameMachine(l.equipment_number, machine.equipment_number));
}
