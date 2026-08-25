import type Database from 'better-sqlite3';

/**
 * A starting supplier-evaluation framework, carried across so the module is
 * usable the moment it is opened rather than empty.
 *
 * It restates the laboratory's Supplier Performance Review form (LAB-QMS-07-F1)
 * as ten scored questions on a 1–5 scale, each with the standard that defines
 * an acceptable answer. It seeds once, keyed on the framework code, so a
 * laboratory that edits or retires it keeps its change across upgrades. It
 * lands active so an evaluation can be raised against it straight away.
 */

type Question = { text: string; criteria: string; critical?: boolean };

const FRAMEWORK = {
  code: 'LAB-QMS-07-F1',
  title: 'Supplier Performance Review',
  category: null as string | null,
  purpose: 'Periodic performance review of an approved supplier of reagents, consumables, equipment or services.',
  scope: 'All suppliers whose product or service can affect a laboratory result.',
  maxScore: 5,
  passThreshold: 70,
  minimumElementScore: 2,
  validityMonths: 12,
  group: 'Performance criteria',
  questions: [
    { text: 'Consistency in product quality', criteria: 'Product consistently meets the agreed specifications.' },
    { text: 'Delivery timeliness', criteria: 'Deliveries arrive within the agreed schedule.' },
    { text: 'Completeness and accuracy of deliveries', criteria: 'No shortages, errors or damages on receipt.' },
    { text: 'Packaging and cold-chain compliance', criteria: 'Packaging and, where applicable, cold-chain are intact and evidenced.' },
    { text: 'Communication and responsiveness', criteria: 'Responds promptly and clearly to requests and complaints.' },
    { text: 'Handling of nonconformities, replacements or recalls', criteria: 'Resolves nonconformities, replacements and recalls properly and on time.' },
    { text: 'Provision of required documentation', criteria: 'Supplies COA, MSDS, invoices and delivery notes as required.' },
    { text: 'Reliability of after-sales service / maintenance support', criteria: 'After-sales and maintenance support is dependable.' },
    { text: 'Price stability and transparency', criteria: 'Pricing is stable, transparent and communicated in advance.' },
    { text: 'Professional conduct and cooperation', criteria: 'Conducts business professionally and cooperatively.' },
  ] as Question[],
};

export function seedSupplierEvaluationFrameworks(database: Database.Database) {
  if (database.prepare('SELECT id FROM supplier_eval_frameworks WHERE framework_code = ?').get(FRAMEWORK.code)) return;
  const result = database.prepare(`INSERT INTO supplier_eval_frameworks
    (framework_code, title, category, version_label, purpose, scope, max_score, pass_threshold_percent,
     minimum_element_score, critical_elements_must_pass, validity_months, requires_review, status,
     effective_date, next_review_date)
    VALUES (?, ?, ?, '1.0', ?, ?, ?, ?, ?, 0, ?, 1, 'active', date('now'), date('now', '+1 year'))`)
    .run(FRAMEWORK.code, FRAMEWORK.title, FRAMEWORK.category, FRAMEWORK.purpose, FRAMEWORK.scope,
      FRAMEWORK.maxScore, FRAMEWORK.passThreshold, FRAMEWORK.minimumElementScore, FRAMEWORK.validityMonths);
  const frameworkId = Number(result.lastInsertRowid);
  const group = database.prepare('INSERT INTO supplier_eval_framework_groups (framework_id, group_title, display_order) VALUES (?, ?, 10)')
    .run(frameworkId, FRAMEWORK.group);
  const groupId = Number(group.lastInsertRowid);
  const insert = database.prepare(`INSERT INTO supplier_eval_framework_elements
    (framework_id, group_id, element_code, element_text, performance_criteria, weight, is_critical, display_order)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)`);
  let order = 0, n = 0;
  for (const q of FRAMEWORK.questions) {
    n++;
    insert.run(frameworkId, groupId, `Q${String(n).padStart(2, '0')}`, q.text, q.criteria, q.critical ? 1 : 0, order += 10);
  }
}
