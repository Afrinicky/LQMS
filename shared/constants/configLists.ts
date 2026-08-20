/**
 * Configurable dropdown lists ("picklists").
 *
 * A laboratory should not have to accept the vocabulary the software shipped
 * with. Equipment categories, criticality grades, the condition an item
 * arrived in — these are the laboratory's own words, and they belong in
 * Settings, not hard-coded. This registry names the lists that are safe to
 * open up: display vocabularies, not the enums that drive logic (a run is
 * still `in_control | warning | out_of_control`, and no setting changes that).
 *
 * One list is special. An equipment category is not just a label — it decides
 * whether the item carries IQC and EQA. So each category option is pinned to a
 * behavioural ARCHETYPE (see shared/constants/equipment.ts); the label is the
 * laboratory's, the behaviour is the standard's.
 */
import { EQUIPMENT_ARCHETYPES, EQUIPMENT_CATEGORY_LABELS } from './equipment.js';

export type ConfigListDef = {
  key: string;
  label: string;
  description: string;
  /** Options carry a required archetype the laboratory chooses from this set. */
  archetypeOf?: readonly string[];
  /** The built-in options seeded for this list. value doubles as the stored code. */
  seed: { value: string; label: string; extra?: Record<string, unknown> }[];
};

export const CONFIG_LISTS: ConfigListDef[] = [
  {
    key: 'equipment_category',
    label: 'Equipment categories',
    description: 'What kind of equipment an item is. The archetype pinned to each category decides which quality activities apply — only diagnostic analysers and point-of-care devices carry IQC and EQA.',
    archetypeOf: EQUIPMENT_ARCHETYPES,
    seed: EQUIPMENT_ARCHETYPES.map(a => ({ value: a, label: EQUIPMENT_CATEGORY_LABELS[a], extra: { archetype: a } })),
  },
  {
    key: 'inventory_category',
    label: 'Stock item categories',
    description: 'What kind of thing a stock item is. Reagents, controls and calibrators carry lot verification before use; the rest are ordinary consumables. Add the categories this laboratory actually orders.',
    seed: [
      { value: 'reagent', label: 'Reagent' },
      { value: 'control_material', label: 'Control material' },
      { value: 'calibrator', label: 'Calibrator' },
      { value: 'culture_media', label: 'Culture media' },
      { value: 'stain', label: 'Stain / dye' },
      { value: 'consumable', label: 'Consumable' },
      { value: 'glassware', label: 'Glassware' },
      { value: 'ppe', label: 'PPE' },
      { value: 'blood_bank', label: 'Blood bank supply' },
      { value: 'cleaning', label: 'Cleaning / disinfectant' },
      { value: 'stationery', label: 'Stationery' },
      { value: 'other', label: 'Other' },
    ],
  },
  {
    key: 'inventory_unit',
    label: 'Stock units of measure',
    description: 'How a stock item is counted — the unit that appears on the register and on every issue.',
    seed: [
      { value: 'each', label: 'Each' },
      { value: 'box', label: 'Box' },
      { value: 'pack', label: 'Pack' },
      { value: 'vial', label: 'Vial' },
      { value: 'bottle', label: 'Bottle' },
      { value: 'kit', label: 'Kit' },
      { value: 'test', label: 'Test' },
      { value: 'ml', label: 'Millilitre (mL)' },
      { value: 'l', label: 'Litre (L)' },
      { value: 'g', label: 'Gram (g)' },
      { value: 'roll', label: 'Roll' },
    ],
  },
  {
    key: 'equipment_criticality',
    label: 'Equipment criticality grades',
    description: 'How critical an item is to the service, used to prioritise maintenance and contingency.',
    seed: [
      { value: 'critical', label: 'Critical' },
      { value: 'key', label: 'Key' },
      { value: 'non_critical', label: 'Non-critical' },
    ],
  },
  {
    key: 'equipment_condition',
    label: 'Equipment condition on receipt',
    description: 'The state an item was in when the laboratory took delivery of it.',
    seed: [
      { value: 'new', label: 'New' },
      { value: 'used', label: 'Used' },
      { value: 'reconditioned', label: 'Reconditioned' },
      { value: 'refurbished', label: 'Refurbished' },
    ],
  },
];

export function configListDef(key: string): ConfigListDef | undefined {
  return CONFIG_LISTS.find(l => l.key === key);
}

export type ConfigOption = {
  id: number;
  list_key: string;
  value: string;
  label: string;
  extra: Record<string, unknown> | null;
  sort_order: number;
  is_active: number;
  is_system: number;
};
