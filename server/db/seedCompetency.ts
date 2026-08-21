import type Database from 'better-sqlite3';

/**
 * Starting frameworks and appraisal templates.
 *
 * These are the laboratory's own checklists carried across — the new-hire
 * bench checklist, the annual reverification of existing staff, and the intern
 * assessment — restated as scored elements with the performance criteria that
 * define acceptable work and the method the assessor should use for each.
 *
 * They seed once, keyed on the framework or template code, so a laboratory
 * that edits, renames or retires one keeps its change across upgrades. All
 * three land as drafts: nothing here is in force until somebody with the
 * authority to agree it activates it.
 */

type Element = {
  text: string;
  criteria?: string;
  evidence?: string;
  method?: string;
  critical?: boolean;
  weight?: number;
};

type Group = { title: string; description?: string; elements: Element[] };

type Framework = {
  code: string;
  title: string;
  appliesTo: string;
  purpose: string;
  scope: string;
  validityMonths: number;
  passThreshold: number;
  minimumElementScore: number | null;
  groups: Group[];
};

const OBSERVE = 'direct_observation';
const RECORDS = 'review_of_work_records';
const REPORTING = 'monitoring_recording_reporting';
const MAINTENANCE = 'equipment_maintenance_observation';
const PROBLEM = 'problem_solving_assessment';
const SAMPLES = 'sample_testing';

/** Elements every member of staff is judged on, whatever bench they work. */
const CONDUCT_GROUP: Group = {
  title: 'Quality, safety and conduct',
  description: 'Applies on every bench and to every member of staff.',
  elements: [
    { text: 'Works to the current authorised procedure and knows where to find it', criteria: 'Uses the controlled copy; recognises when a procedure has been superseded.', method: OBSERVE, critical: true },
    { text: 'Keeps complete, legible and contemporaneous records', criteria: 'Worksheets and logs are filled in as work is done, corrections are struck through, initialled and dated, and nothing is overwritten.', method: RECORDS, critical: true },
    { text: 'Runs, reads and records quality control before releasing patient results', criteria: 'Control material is run at the required frequency, results are plotted or logged, and out-of-control runs stop reporting.', method: REPORTING, critical: true },
    { text: 'Applies standard precautions and uses personal protective equipment correctly', criteria: 'Gloves, coat and eye protection worn as the risk assessment requires; hands decontaminated between tasks.', method: OBSERVE, critical: true },
    { text: 'Segregates and disposes of clinical, sharps and chemical waste correctly', criteria: 'Waste goes into the right stream at the point of generation; sharps are never re-sheathed.', method: OBSERVE, critical: true },
    { text: 'Deals with a spill, an exposure or a needlestick according to procedure', criteria: 'Can state the immediate steps, where the spill kit is, and who must be told.', method: PROBLEM },
    { text: 'Maintains patient confidentiality and behaves impartially', criteria: 'Discusses results only with those entitled to them; declares any conflict of interest.', method: OBSERVE, critical: true },
    { text: 'Communicates professionally with clinicians, patients and colleagues', criteria: 'Enquiries and complaints are handled courteously and escalated when they should be.', method: OBSERVE },
    { text: 'Is punctual, reliable and available for the duty roster', criteria: 'Attends as rostered; absence is notified in time for cover to be arranged.', method: RECORDS },
    { text: 'Recognises a nonconformity and raises it rather than working around it', criteria: 'Knows what has to be reported and how to report it.', method: PROBLEM, critical: true },
  ],
};

const FRAMEWORKS: Framework[] = [
  {
    code: 'CF-NEWHIRE',
    title: 'Bench competency — newly appointed staff',
    appliesTo: 'new_hire',
    purpose: 'Establish that a newly appointed member of staff can carry out the examinations of each bench to the required standard before working unsupervised, and identify the training needed where they cannot.',
    scope: 'All newly appointed laboratory staff during induction, across every bench they will be rostered to. Elements that do not apply to the post are marked not applicable and excluded from the score.',
    validityMonths: 6,
    passThreshold: 75,
    minimumElementScore: 2,
    groups: [
      {
        title: 'Pre-examination and specimen handling',
        elements: [
          { text: 'Receives, checks and accepts or rejects specimens against the acceptance criteria', criteria: 'Identity, request, container, volume and condition are all checked; rejections are recorded and communicated.', method: OBSERVE, critical: true },
          { text: 'Confirms patient identity before phlebotomy and labels at the bedside', criteria: 'Two identifiers used; tubes labelled in the patient\'s presence, never in advance.', method: OBSERVE, critical: true },
          { text: 'Performs venepuncture and capillary sampling safely and competently', criteria: 'Correct order of draw, correct tube for the examination, patient comfort and safety maintained.', method: OBSERVE },
          { text: 'Registers the request and assigns the laboratory number correctly', criteria: 'Demographics, requesting location and clinical details entered without transcription error.', method: REPORTING },
          { text: 'Stores, preserves and transports specimens at the right temperature and within stability limits', criteria: 'Knows the storage condition and the time limit for each specimen type.', method: OBSERVE, critical: true },
          { text: 'Centrifuges and aliquots specimens correctly', criteria: 'Correct speed and time; balanced loads; aliquots labelled to match the primary tube.', method: OBSERVE },
          { text: 'Uses pipettes correctly and knows when they were last checked', criteria: 'Correct technique and tip; volume verified against the pipette check record.', method: MAINTENANCE },
        ],
      },
      {
        title: 'Haematology and blood transfusion',
        elements: [
          { text: 'Performs a full blood count and reviews the analyser output', criteria: 'Recognises flags, knows which results require a film review, and acts on them.', method: OBSERVE },
          { text: 'Estimates haemoglobin and interprets the result against reference intervals', criteria: 'Method performed correctly; critical values recognised and escalated.', method: OBSERVE, critical: true },
          { text: 'Prepares, stains and reads a peripheral blood film', criteria: 'Film is well spread and stained; morphology reported accurately.', method: SAMPLES },
          { text: 'Prepares thick and thin films and reports malaria parasite microscopy', criteria: 'Films fit for purpose; species and parasite density reported correctly.', method: SAMPLES, critical: true },
          { text: 'Performs sickling screening and interprets the result', criteria: 'Reagent prepared correctly and within its expiry; result confirmed where required.', method: OBSERVE },
          { text: 'Performs haemoglobin electrophoresis and interprets the pattern', criteria: 'Run conditions correct; bands identified against the control.', method: OBSERVE },
          { text: 'Performs ABO and Rh D grouping and resolves discrepancies', criteria: 'Forward and reverse grouping agree; a discrepancy is investigated, never overridden.', method: OBSERVE, critical: true },
          { text: 'Performs compatibility testing and issues blood safely', criteria: 'Correct technique, correct controls, and the issue record completed in full.', method: OBSERVE, critical: true },
          { text: 'Performs clotting and bleeding time investigations', criteria: 'Timing and endpoint judged correctly; result recorded with the method used.', method: OBSERVE },
          { text: 'Prepares reagents and working solutions and records their preparation', criteria: 'Preparation, lot, date and expiry recorded; solutions labelled.', method: RECORDS },
        ],
      },
      {
        title: 'Clinical chemistry',
        elements: [
          { text: 'Prepares and handles specimens for chemistry examinations', criteria: 'Separation time respected; haemolysed or unsuitable specimens identified.', method: OBSERVE, critical: true },
          { text: 'Performs renal function examinations and interprets the results', criteria: 'Calibration and controls acceptable before patient results are reported.', method: OBSERVE },
          { text: 'Performs liver function examinations and interprets the results', criteria: 'Calibration and controls acceptable before patient results are reported.', method: OBSERVE },
          { text: 'Performs the lipid profile and interprets the results', criteria: 'Fasting status confirmed where the method requires it.', method: OBSERVE },
          { text: 'Performs urine biochemistry, including strip testing', criteria: 'Strips in date and stored correctly; timing observed; result read against the correct chart.', method: OBSERVE },
          { text: 'Prepares reagents and dilutions accurately', criteria: 'Calculation correct and shown; dilution recorded on the worksheet.', method: RECORDS },
          { text: 'Operates and maintains the chemistry analyser', criteria: 'Start-up, maintenance and shutdown performed and logged.', method: MAINTENANCE, critical: true },
        ],
      },
      {
        title: 'Microbiology and parasitology',
        elements: [
          { text: 'Receives, stores and processes microbiology specimens', criteria: 'Specimen integrity maintained; delay-sensitive specimens prioritised.', method: OBSERVE },
          { text: 'Performs urine microscopy and reports the findings', criteria: 'Deposit prepared correctly; cells, casts, crystals and organisms reported accurately.', method: SAMPLES },
          { text: 'Performs stool wet mount and identifies parasites', criteria: 'Preparation adequate; ova, cysts and trophozoites identified correctly.', method: SAMPLES, critical: true },
          { text: 'Performs Gram staining and interprets the smear', criteria: 'Reagents in date; control smear acceptable; morphology and reaction reported correctly.', method: SAMPLES, critical: true },
          { text: 'Performs Ziehl-Neelsen staining and reports acid-fast bacilli', criteria: 'Positive and negative controls run alongside; grading reported to the required scale.', method: SAMPLES, critical: true },
          { text: 'Inoculates culture media and reads growth', criteria: 'Aseptic technique maintained; plates labelled, incubated and read at the right time.', method: OBSERVE },
          { text: 'Performs and reads antimicrobial susceptibility testing', criteria: 'Inoculum density and disc placement correct; zones measured and interpreted against the current breakpoints.', method: OBSERVE },
        ],
      },
      {
        title: 'Serology and immunology',
        elements: [
          { text: 'Performs rapid diagnostic tests to the manufacturer\'s instructions', criteria: 'Kit in date and at room temperature; volume and timing observed exactly.', method: OBSERVE, critical: true },
          { text: 'Runs and interprets kit controls before reporting', criteria: 'The control line or well is checked on every device; an invalid test is repeated, not reported.', method: REPORTING, critical: true },
          { text: 'Performs hepatitis B and C screening and reports the result', criteria: 'Result read within the stated window and recorded with the lot number.', method: OBSERVE },
          { text: 'Performs syphilis screening and reports the result', criteria: 'Result read within the stated window; reactive results confirmed as procedure requires.', method: OBSERVE },
          { text: 'Performs HIV testing to the national algorithm', criteria: 'Algorithm followed in the correct order; confidentiality maintained throughout.', method: OBSERVE, critical: true },
          { text: 'Performs malaria rapid diagnostic testing', criteria: 'Buffer volume and reading time observed; invalid results repeated.', method: OBSERVE },
          { text: 'Performs pregnancy testing and reports the result', criteria: 'Specimen suitable; result read within the stated window.', method: OBSERVE },
        ],
      },
      CONDUCT_GROUP,
    ],
  },
  {
    code: 'CF-REVERIFY',
    title: 'Periodic competency reverification — laboratory staff',
    appliesTo: 'existing_staff',
    purpose: 'Confirm at defined intervals that staff already working unsupervised remain competent in the examinations they are authorised to perform, and identify refresher training where performance has drifted.',
    scope: 'All staff performing examinations, assessed against the work they are authorised for. The assessment covers observation of routine work, review of records, objective sample performance and problem solving.',
    validityMonths: 12,
    passThreshold: 80,
    minimumElementScore: 2,
    groups: [
      {
        title: 'Specimen handling and processing',
        elements: [
          { text: 'Applies specimen acceptance and rejection criteria consistently', criteria: 'Rejection decisions match the criteria and are recorded with the reason.', method: OBSERVE, critical: true },
          { text: 'Handles, stores and preserves specimens within stability limits', criteria: 'Storage conditions and time limits observed and evidenced by the records.', method: RECORDS },
          { text: 'Maintains specimen identity and traceability from receipt to report', criteria: 'Every aliquot and worksheet traces back to the primary specimen.', method: RECORDS, critical: true },
        ],
      },
      {
        title: 'Examination procedure',
        elements: [
          { text: 'Performs the authorised examination procedure as written', criteria: 'Observed performance matches the current procedure at every step.', method: OBSERVE, critical: true, weight: 2 },
          { text: 'Prepares reagents, calibrators and controls correctly and within expiry', criteria: 'Lot, preparation date and expiry recorded; expired material is not used.', method: OBSERVE, critical: true },
          { text: 'Uses measuring equipment within its calibration and verification status', criteria: 'Checks the status before use; equipment out of calibration is not used.', method: MAINTENANCE, critical: true },
        ],
      },
      {
        title: 'Quality control testing and recording',
        elements: [
          { text: 'Runs internal quality control at the required frequency', criteria: 'Control runs are complete for the period under review.', method: RECORDS, critical: true },
          { text: 'Evaluates control results against the rules in force before reporting', criteria: 'Rule violations are identified; patient results are held until the run is in control.', method: REPORTING, critical: true, weight: 2 },
          { text: 'Records corrective action taken on an out-of-control run', criteria: 'Cause, action and re-run are documented and the run is closed out.', method: RECORDS },
          { text: 'Participates in external quality assessment and acts on the returns', criteria: 'Rounds submitted on time; unsatisfactory performance investigated and documented.', method: RECORDS },
        ],
      },
      {
        title: 'Results recording, interpretation and reporting',
        elements: [
          { text: 'Records and transcribes results without error', criteria: 'Sampled records match the analyser or worksheet output exactly.', method: REPORTING, critical: true, weight: 2 },
          { text: 'Interprets results against reference intervals and clinical decision limits', criteria: 'Abnormal patterns recognised; interpretive comments are appropriate.', method: PROBLEM },
          { text: 'Identifies critical results and escalates them within the required time', criteria: 'Notification is made, read back and recorded with the time and the recipient.', method: RECORDS, critical: true, weight: 2 },
          { text: 'Reviews and releases reports within the authorised scope', criteria: 'Only results the person is authorised to release are released.', method: REPORTING, critical: true },
          { text: 'Amends a released report correctly when a correction is needed', criteria: 'The original is retained, the amendment is flagged, and the requester is informed.', method: PROBLEM },
        ],
      },
      {
        title: 'Equipment maintenance and function checks',
        elements: [
          { text: 'Performs daily, weekly and monthly maintenance as scheduled', criteria: 'Maintenance logs are complete and signed for the period.', method: MAINTENANCE, critical: true },
          { text: 'Performs and records function checks before use', criteria: 'Temperature, timing and performance checks recorded and within limits.', method: MAINTENANCE },
          { text: 'Recognises a malfunction, takes the equipment out of use and reports it', criteria: 'Faulty equipment is labelled and quarantined; the fault is logged.', method: PROBLEM, critical: true },
        ],
      },
      {
        title: 'Problem solving',
        elements: [
          { text: 'Investigates an unexpected or implausible result before reporting it', criteria: 'Checks specimen integrity, controls and history rather than releasing or repeating blindly.', method: PROBLEM, critical: true, weight: 2 },
          { text: 'Resolves an out-of-control quality control run systematically', criteria: 'Works through control, calibration, reagent and instrument causes in a sensible order.', method: PROBLEM, weight: 2 },
          { text: 'Responds correctly to an interruption to service — power, water, reagent or staff', criteria: 'Knows the contingency arrangement and who to inform.', method: PROBLEM },
        ],
      },
      {
        title: 'Objective sample performance',
        description: 'Performance against material with a known answer, recorded in the sample performance section of the assessment.',
        elements: [
          { text: 'Result on proficiency testing or interlaboratory comparison material is acceptable', criteria: 'Falls within the acceptance limits of the scheme.', method: SAMPLES, critical: true, weight: 2 },
          { text: 'Result on a re-examined, split or blind sample agrees with the reference result', criteria: 'Agrees within the allowable difference for the examination.', method: SAMPLES, critical: true, weight: 2 },
        ],
      },
      CONDUCT_GROUP,
    ],
  },
  {
    code: 'CF-INTERN',
    title: 'Competency assessment — interns and attachés',
    appliesTo: 'intern_attachee',
    purpose: 'Assess the progress of interns, students and attachés through the benches, direct their supervised training, and record what they may and may not do unsupervised.',
    scope: 'Interns, students and attachés for the duration of their placement. Nothing in this framework authorises unsupervised work; the level of supervision is recorded on each assessment.',
    validityMonths: 3,
    passThreshold: 60,
    minimumElementScore: null,
    groups: [
      {
        title: 'Pre-examination and specimen handling',
        elements: [
          { text: 'Receives and checks specimens against the request under supervision', criteria: 'Identity and suitability checked; queries raised with the supervisor.', method: OBSERVE },
          { text: 'Labels, registers and stores specimens correctly', criteria: 'Labelling and registration complete and legible.', method: OBSERVE, critical: true },
          { text: 'Uses pipettes and basic laboratory equipment correctly', criteria: 'Technique correct; equipment cleaned and returned.', method: OBSERVE },
          { text: 'Prepares reagents and working solutions under supervision', criteria: 'Calculation checked by the supervisor before use.', method: OBSERVE },
        ],
      },
      {
        title: 'Haematology and blood transfusion',
        elements: [
          { text: 'Estimates haemoglobin under supervision', method: OBSERVE },
          { text: 'Prepares and stains blood films', criteria: 'Film well spread; staining acceptable.', method: SAMPLES },
          { text: 'Prepares thick and thin films and examines for malaria parasites', method: SAMPLES },
          { text: 'Performs sickling screening under supervision', method: OBSERVE },
          { text: 'Performs ABO and Rh D grouping under supervision', criteria: 'Result always confirmed by the supervisor before use.', method: OBSERVE, critical: true },
          { text: 'Observes and assists with compatibility testing', criteria: 'Understands why each step matters; does not issue blood.', method: OBSERVE },
        ],
      },
      {
        title: 'Clinical chemistry',
        elements: [
          { text: 'Performs urine strip testing and reads the result correctly', method: OBSERVE },
          { text: 'Prepares specimens for chemistry examinations', method: OBSERVE },
          { text: 'Assists with renal and liver function examinations', method: OBSERVE },
          { text: 'Performs reagent dilutions accurately with the calculation shown', method: RECORDS },
        ],
      },
      {
        title: 'Microbiology and parasitology',
        elements: [
          { text: 'Prepares wet mounts for urine and stool examination', method: SAMPLES },
          { text: 'Performs urine microscopy under supervision', method: SAMPLES },
          { text: 'Identifies common intestinal parasites', method: SAMPLES },
          { text: 'Performs Gram staining and reads the smear under supervision', method: SAMPLES },
          { text: 'Performs Ziehl-Neelsen staining under supervision', method: SAMPLES },
        ],
      },
      {
        title: 'Serology and immunology',
        elements: [
          { text: 'Performs rapid diagnostic tests to the manufacturer\'s instructions under supervision', method: OBSERVE, critical: true },
          { text: 'Checks the kit control and recognises an invalid result', method: REPORTING, critical: true },
          { text: 'Records the kit lot number and expiry with the result', method: RECORDS },
        ],
      },
      {
        title: 'Professional conduct and safety',
        elements: [
          { text: 'Applies standard precautions and uses personal protective equipment correctly', method: OBSERVE, critical: true },
          { text: 'Segregates and disposes of waste correctly', method: OBSERVE, critical: true },
          { text: 'Keeps legible, contemporaneous records of work performed', method: RECORDS },
          { text: 'Maintains patient confidentiality at all times', method: OBSERVE, critical: true },
          { text: 'Is punctual and attends the placement as scheduled', method: RECORDS },
          { text: 'Asks for help rather than proceeding when unsure', criteria: 'Recognises the limit of their own competence.', method: PROBLEM, critical: true },
          { text: 'Shows a constructive attitude to patients, clinicians and colleagues', method: OBSERVE },
        ],
      },
    ],
  },
];

type TemplateItem = { section: string; title: string; description?: string; measure?: string; weight: number };

const APPRAISAL_TEMPLATE = {
  code: 'APT-GENERAL',
  title: 'Annual performance appraisal — laboratory staff',
  description: 'The standard annual review for laboratory staff. Delivery against agreed objectives carries the greatest weight, with technical practice, quality and compliance, and contribution to the team assessed alongside it. The member of staff rates themselves first; the appraiser rates independently; a second-level reviewer moderates before the record closes.',
  maxScore: 5,
  items: [
    { section: 'delivery', title: 'Achievement of objectives agreed for the period', description: 'Progress against each objective set at the last review.', measure: 'Objectives achieved in full, on time and to the agreed measure.', weight: 3 },
    { section: 'delivery', title: 'Workload and turnaround', description: 'Volume of work handled and its timeliness.', measure: 'Agreed turnaround times met without backlog carried to colleagues.', weight: 2 },
    { section: 'delivery', title: 'Reliability and availability', description: 'Attendance, punctuality and cover for the roster.', measure: 'Rostered duties covered; absence notified in time for cover.', weight: 1 },

    { section: 'competency', title: 'Technical knowledge of the examinations performed', description: 'Understanding of the principles, limitations and interferences of the methods in use.', measure: 'Explains the method and its limitations without prompting.', weight: 2 },
    { section: 'competency', title: 'Accuracy and standard of technical work', description: 'The quality of the work produced day to day.', measure: 'Work is right first time; errors are rare and self-detected.', weight: 3 },
    { section: 'competency', title: 'Problem solving and judgement', description: 'Handling of unexpected results, faults and interruptions.', measure: 'Investigates properly before escalating; escalates when they should.', weight: 2 },
    { section: 'competency', title: 'Currency of competency assessment and authorisation', description: 'Whether required assessments and authorisations are current.', measure: 'All required assessments completed and in date.', weight: 1 },

    { section: 'quality_compliance', title: 'Adherence to procedures and quality control', description: 'Working to the authorised procedure and running control as required.', measure: 'No avoidable departures from procedure over the period.', weight: 3 },
    { section: 'quality_compliance', title: 'Record keeping and documentation', description: 'Completeness and legibility of records produced.', measure: 'Records are complete, contemporaneous and traceable.', weight: 2 },
    { section: 'quality_compliance', title: 'Safety, biosafety and use of protective equipment', description: 'Personal and shared safety practice.', measure: 'No safety breaches; hazards reported promptly.', weight: 2 },
    { section: 'quality_compliance', title: 'Confidentiality, impartiality and professional conduct', description: 'Handling of patient information and of competing interests.', measure: 'Declarations current; no breach of confidentiality.', weight: 2 },
    { section: 'quality_compliance', title: 'Contribution to improvement and to corrective action', description: 'Raising nonconformities and following through on actions assigned.', measure: 'Assigned actions closed on time with evidence.', weight: 1 },

    { section: 'leadership', title: 'Teamwork and cooperation', description: 'Working with colleagues across benches and shifts.', measure: 'Supports colleagues; handovers are complete.', weight: 2 },
    { section: 'leadership', title: 'Communication with clinicians, patients and colleagues', measure: 'Enquiries handled professionally; information passed on accurately.', weight: 1 },
    { section: 'leadership', title: 'Training, mentoring and supervision of others', description: 'Contribution to the development of interns and junior colleagues.', measure: 'Training delivered or supervision provided as assigned.', weight: 1 },
    { section: 'leadership', title: 'Initiative and personal development', description: 'Continuing professional development and improvement work undertaken.', measure: 'Development plan from the last review completed.', weight: 1 },
  ] as TemplateItem[],
};

export function seedCompetencyFrameworks(database: Database.Database) {
  const frameworkExists = database.prepare('SELECT id FROM competency_frameworks WHERE framework_code = ?');
  const insertFramework = database.prepare(`INSERT INTO competency_frameworks
    (framework_code, title, applies_to, version_label, purpose, scope, max_score, pass_threshold_percent,
     minimum_element_score, critical_elements_must_pass, validity_months, requires_technical_review,
     requires_staff_acknowledgement, status, is_default)
    VALUES (?, ?, ?, '1.0', ?, ?, 4, ?, ?, 1, ?, 1, 1, 'draft', 1)`);
  const insertGroup = database.prepare('INSERT INTO competency_framework_groups (framework_id, group_title, group_description, display_order) VALUES (?, ?, ?, ?)');
  const insertElement = database.prepare(`INSERT INTO competency_framework_elements
    (framework_id, group_id, element_code, element_text, performance_criteria, expected_evidence, default_method, weight, is_critical, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const framework of FRAMEWORKS) {
    if (frameworkExists.get(framework.code)) continue;
    const result = insertFramework.run(framework.code, framework.title, framework.appliesTo, framework.purpose,
      framework.scope, framework.passThreshold, framework.minimumElementScore, framework.validityMonths);
    const frameworkId = Number(result.lastInsertRowid);
    let groupOrder = 0;
    let elementOrder = 0;
    let elementNumber = 0;
    for (const group of framework.groups) {
      const groupResult = insertGroup.run(frameworkId, group.title, group.description ?? null, groupOrder += 10);
      const groupId = Number(groupResult.lastInsertRowid);
      for (const element of group.elements) {
        elementNumber++;
        insertElement.run(frameworkId, groupId, `E${String(elementNumber).padStart(2, '0')}`, element.text,
          element.criteria ?? null, element.evidence ?? null, element.method ?? OBSERVE,
          element.weight ?? 1, element.critical ? 1 : 0, elementOrder += 10);
      }
    }
  }

  if (!database.prepare('SELECT id FROM appraisal_templates WHERE template_code = ?').get(APPRAISAL_TEMPLATE.code)) {
    const result = database.prepare(`INSERT INTO appraisal_templates
      (template_code, title, applies_to, version_label, description, max_score, self_assessment_required,
       second_level_review_required, objectives_required, status, is_default)
      VALUES (?, ?, 'all_staff', '1.0', ?, ?, 1, 1, 1, 'draft', 1)`)
      .run(APPRAISAL_TEMPLATE.code, APPRAISAL_TEMPLATE.title, APPRAISAL_TEMPLATE.description, APPRAISAL_TEMPLATE.maxScore);
    const templateId = Number(result.lastInsertRowid);
    const insertItem = database.prepare(`INSERT INTO appraisal_template_items
      (template_id, section, item_title, item_description, success_measure, weight, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let order = 0;
    for (const item of APPRAISAL_TEMPLATE.items) {
      insertItem.run(templateId, item.section, item.title, item.description ?? null, item.measure ?? null, item.weight, order += 10);
    }
  }
}
