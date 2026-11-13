/**
 * The two kinds of unit a laboratory has.
 *
 * A CLINICAL unit is a bench: Haematology, Biochemistry, Microbiology, the
 * Blood Bank, Phlebotomy. It has a test menu, equipment, stock and staff, and
 * every laboratory professional belongs to exactly one.
 *
 * An ADMINISTRATIVE unit is an office: the Quality Office, the Stores, the
 * front desk. It has no test menu, because it performs no tests. What it does
 * have is the work of one module, which is why each one names the module its
 * services are drawn from rather than carrying a service list of its own.
 *
 * Most administrative units are PSEUDO units — an appointment and a filing
 * cabinet inside somebody else's floor space rather than a unit with a door.
 * A pseudo unit is left out when the laboratory counts its units, so the
 * Quality Office does not inflate a figure that is meant to describe benches.
 * A facility with a real, separate quality office clears the flag and it
 * counts like anything else.
 */

export const UNIT_KINDS = ['clinical', 'administrative'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const UNIT_KIND_LABELS: Record<UnitKind, string> = {
  clinical: 'Clinical unit',
  administrative: 'Administrative / support unit',
};

/**
 * The modules an administrative unit can draw its services from.
 *
 * `metrics` are counted live by the server for the unit's profile; `links`
 * are where the work itself is done, so the unit's page is a way in to its
 * module rather than a second copy of it.
 */
export type AdminUnitService = {
  module: string;
  label: string;
  /** The post that heads a unit of this kind, matched on title. */
  headPosition: string;
  links: Array<{ label: string; path: string }>;
};

export const ADMIN_UNIT_SERVICES: AdminUnitService[] = [
  {
    module: 'documents',
    label: 'Quality management',
    headPosition: 'Quality Manager',
    links: [
      { label: 'Document control', path: '/documents' },
      { label: 'Nonconformities & CAPA', path: '/nc-capa' },
      { label: 'Internal assessments', path: '/assessments' },
      { label: 'Management review', path: '/organisation' },
    ],
  },
  {
    module: 'supplier_inventory',
    label: 'Stores and inventory',
    headPosition: 'Stores Officer',
    links: [
      { label: 'Stock control', path: '/inventory' },
      { label: 'Suppliers', path: '/inventory?tab=Suppliers' },
      { label: 'Storage conditions', path: '/inventory?tab=Storage' },
    ],
  },
  {
    module: 'customer_focus',
    label: 'Customer service',
    headPosition: 'Customer Service Officer',
    links: [
      { label: 'Feedback', path: '/customer-focus' },
      { label: 'Complaints', path: '/complaints' },
      { label: 'Communication log', path: '/information-management' },
    ],
  },
  {
    module: 'facilities_safety',
    label: 'Facilities and safety',
    headPosition: 'Safety Manager',
    links: [
      { label: 'Safety incidents', path: '/facilities-safety' },
      { label: 'Risk register', path: '/risk' },
      { label: 'Decontamination', path: '/facilities-safety?tab=Decontamination' },
    ],
  },
  {
    module: 'poct',
    label: 'Point-of-care testing',
    headPosition: 'POCT Officer',
    links: [
      { label: 'POCT sites and devices', path: '/poct' },
      { label: 'POCT quality control', path: '/poct?tab=Quality%20control' },
    ],
  },
];

export function adminUnitService(module: unknown): AdminUnitService | null {
  return ADMIN_UNIT_SERVICES.find(s => s.module === String(module ?? '')) ?? null;
}

/** The access levels a cross-unit working permission can carry. */
export const UNIT_GRANT_LEVEL_LABELS: Record<string, string> = {
  view: 'View only',
  contribute: 'Record work',
  manage: 'Manage',
  full: 'Full',
};
