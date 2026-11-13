/**
 * What this product is called, and where it keeps its data.
 *
 * TransLis is the analyser middleware and result filler of SECHLIMS, packaged
 * to run on its own. It goes to facilities that do not run SECHLIMS, so it
 * carries its own name, its own database and its own accounts — and it is the
 * same engine, imported from the same files, rather than a copy that will
 * drift away from the original within a release or two.
 */
export const PRODUCT = 'TransLis';
export const PRODUCT_LONG = 'TransLis — Analyser Middleware & Result Filler';
export const APP_ID = 'com.nickland.translis';

/** The two accounts this product has, and nothing else. */
export const ADMIN_PROFILE = 'Administrator';
export const STAFF_PROFILE = 'Staff';

/**
 * How this installation receives from its analysers.
 *
 *   lan     — analysers transmit to this host across the laboratory network,
 *             exactly as they transmit to a SECHLIMS host. One installation
 *             serves every bench, and the benches reach it by its address.
 *
 *   direct  — this host IS the analyser's own PC. Results are taken locally,
 *             from a folder the instrument software writes, a socket on this
 *             machine, or a serial converter on it, and go straight out to the
 *             LIS from here. No central installation, one per analyser PC.
 *
 * It is one choice per installation rather than per link, because it describes
 * where the software is standing, and the software can only stand in one place.
 */
export type TransmissionMode = 'lan' | 'direct';

export const MODE_LABEL: Record<TransmissionMode, string> = {
  lan: 'Network (LAN)',
  direct: 'Direct — on the analyser PC',
};

export const MODE_BLURB: Record<TransmissionMode, string> = {
  lan: 'Analysers transmit to this computer across the laboratory network, and benches reach it by its address.',
  direct: 'This computer is the analyser’s own PC. Results are taken from it locally and sent straight to the LIS.',
};

/** The settings keys TransLis stores, alongside those the shared code uses. */
export const SETTING = {
  mode: 'translis_mode',
  retentionDays: 'translis_retention_days',
  lisName: 'translis_lis_name',
  setupComplete: 'translis_setup_complete',
} as const;

/** How long result values are kept before they are purged, unless changed. */
export const DEFAULT_RETENTION_DAYS = 30;
