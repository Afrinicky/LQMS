/**
 * The test catalogue vocabulary, shared by the server and the bench screens.
 *
 * Two ideas that keep the menu honest:
 *
 *   PANEL / PROFILE   a request a clinician makes as one thing — Renal Function,
 *                     Liver Function, a Full Blood Count — but which the
 *                     laboratory measures as several component tests. Each
 *                     component is a test in its own right (its own sample,
 *                     method, analyser and result), so the panel is a grouping
 *                     over real tests, not a test that pretends its parts do
 *                     not exist.
 *
 *   AUTOMATION        how the test is performed. Not every test runs on an
 *                     analyser — some are manual, some semi-automated — so an
 *                     instrument is linked only where one is actually used
 *                     (ISO 15189:2022 §5.3, §6.4: equipment used for examinations
 *                     is identified and controlled).
 */

export const AUTOMATION_LEVELS = ['manual', 'semi_automated', 'automated'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

export const AUTOMATION_LABELS: Record<AutomationLevel, string> = {
  manual: 'Manual',
  semi_automated: 'Semi-automated',
  automated: 'Automated',
};

export const AUTOMATION_HINTS: Record<AutomationLevel, string> = {
  manual: 'Performed by hand — no analyser. Microscopy, manual ESR, rapid tests, gram stains.',
  semi_automated: 'An instrument assists but the operator drives it — a semi-auto analyser, a reader.',
  automated: 'Run on an analyser end to end. Link the analyser so QC, calibration and maintenance follow it.',
};

/** Whether an analyser is expected for this automation level. */
export function automationUsesEquipment(level?: string | null): boolean {
  return level === 'semi_automated' || level === 'automated';
}
