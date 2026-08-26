/**
 * Pre-populated Code of Conduct & ethical declaration templates.
 *
 * These are the laboratory's standing declarations carried in the product so a
 * quality manager can set one up in a couple of clicks instead of drafting and
 * uploading a document. Setting up a declaration copies the template's text
 * onto a real declaration form; the copy is editable, so a laboratory that
 * amends the wording keeps its change on that form. The signed record then
 * carries the exact wording every member of staff agreed to.
 *
 * The vocabulary here (form types, statuses) is what the server validates
 * against and the page renders, so a term means one thing everywhere.
 */

/** The kinds of declaration a form can be. */
export const DECLARATION_FORM_TYPES = [
  'code_of_conduct',
  'impartiality',
  'confidentiality',
  'conflict_of_interest',
  'adherence',
  'other',
] as const;

export const DECLARATION_FORM_TYPE_LABELS: Record<string, string> = {
  code_of_conduct: 'Code of Conduct',
  impartiality: 'Declaration of Impartiality',
  confidentiality: 'Declaration of Confidentiality',
  conflict_of_interest: 'Declaration of Conflict of Interest',
  adherence: 'Declaration of Adherence',
  other: 'Other declaration',
};

export const DECLARATION_STATUSES = ['draft', 'active', 'obsolete'] as const;
export const DECLARATION_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  obsolete: 'Obsolete',
};

export type DeclarationTemplate = {
  /** Stable key, stored on the form so the source template is traceable. */
  key: string;
  formType: (typeof DECLARATION_FORM_TYPES)[number];
  title: string;
  purpose: string;
  reviewFrequencyMonths: number;
  requiresAnnualReaffirmation: boolean;
  /** The declaration itself — the statements every member of staff agrees to. */
  bodyContent: string;
  /** The line a person affirms when they sign. */
  acknowledgementStatement: string;
};

/**
 * The starting set. Each is written to stand on its own as the signed record,
 * with the numbered undertakings a member of staff commits to.
 */
export const DECLARATION_TEMPLATES: DeclarationTemplate[] = [
  {
    key: 'code_of_conduct',
    formType: 'code_of_conduct',
    title: 'Code of Conduct',
    purpose: 'The standard of professional and ethical behaviour expected of every member of the laboratory, agreed by each person on appointment and reaffirmed periodically.',
    reviewFrequencyMonths: 12,
    requiresAnnualReaffirmation: true,
    bodyContent: `This Code of Conduct sets out the standard of professional and ethical behaviour required of every member of the laboratory, whatever their role or grade. By signing it you undertake to be bound by it.

As a member of this laboratory I undertake to:

1. Act at all times with honesty, integrity and professionalism, and in the best interests of patients and the service they depend on.

2. Carry out my work to the current authorised procedure, and never take a short cut that could affect the quality or safety of a result.

3. Keep complete, legible and contemporaneous records, and never falsify, back-date, or alter a record to misrepresent what was done.

4. Treat every patient, colleague, client and visitor with courtesy, fairness and respect, without discrimination.

5. Maintain the confidentiality of patient information and of the laboratory's affairs, and disclose information only to those entitled to receive it.

6. Act impartially and declare any interest that could influence, or appear to influence, my professional judgement.

7. Work within the limits of my own competence and authorisation, and ask for help rather than proceed when I am unsure.

8. Follow all safety, biosafety and waste-handling requirements, and protect myself, my colleagues and the public from harm.

9. Use the laboratory's equipment, consumables, systems and funds only for their proper purpose, and safeguard them against loss or misuse.

10. Raise any concern about quality, safety, or conduct through the proper channel, and never victimise anyone who does so in good faith.

A breach of this Code may be treated as a disciplinary matter.`,
    acknowledgementStatement: 'I have read and understood this Code of Conduct and undertake to be bound by it in the course of my work.',
  },
  {
    key: 'impartiality',
    formType: 'impartiality',
    title: 'Declaration of Impartiality',
    purpose: 'A commitment that laboratory activities are carried out impartially and free from commercial, financial or other pressures that could compromise professional judgement (ISO 15189:2022 §4.1).',
    reviewFrequencyMonths: 12,
    requiresAnnualReaffirmation: true,
    bodyContent: `The laboratory is committed to carrying out all of its activities impartially. Impartiality means acting objectively and being free from any bias, pressure or interest that could compromise the quality, safety or integrity of the work.

I declare that:

1. I will carry out my duties objectively and will not allow commercial, financial, personal or other pressures to influence my professional judgement or the results I produce.

2. I will not allow any relationship — of family, friendship, employment, or financial interest — to compromise, or appear to compromise, the impartiality of my work.

3. I will not accept any inducement, gift or hospitality that could be seen to influence my judgement or a laboratory decision.

4. I will report to management any situation, relationship or pressure that presents a threat to impartiality, whether it affects me or a colleague.

5. I understand that the release of results and the conduct of examinations must be based solely on sound professional and scientific grounds.`,
    acknowledgementStatement: 'I have read and understood this Declaration of Impartiality and undertake to conduct my work impartially and to declare any threat to impartiality.',
  },
  {
    key: 'confidentiality',
    formType: 'confidentiality',
    title: 'Declaration of Confidentiality',
    purpose: 'A binding undertaking to protect patient information and all information the laboratory holds in confidence (ISO 15189:2022 §4.2).',
    reviewFrequencyMonths: 12,
    requiresAnnualReaffirmation: true,
    bodyContent: `In the course of my work I have access to information about patients, clients, colleagues and the laboratory that is held in confidence. I understand that protecting this information is a condition of my appointment and a legal and ethical duty.

I undertake that:

1. I will treat as strictly confidential all patient information — including identity, results, and clinical details — and all other information the laboratory holds in confidence.

2. I will access, use and disclose confidential information only where it is necessary for my work and only to those entitled to receive it.

3. I will not discuss patient information in public areas, nor remove records or data from the laboratory, except as my duties require and as authorised.

4. I will keep secure any password, access token or credential issued to me, and will not share it or use another person's credential.

5. I will not photograph, copy or transmit confidential information by any personal device or account.

6. I will report any actual or suspected breach of confidentiality without delay.

7. I understand that this duty of confidentiality continues after I leave the laboratory's employment.`,
    acknowledgementStatement: 'I have read and understood this Declaration of Confidentiality and undertake to protect all confidential information, during and after my employment.',
  },
  {
    key: 'conflict_of_interest',
    formType: 'conflict_of_interest',
    title: 'Declaration of Conflict of Interest',
    purpose: 'Disclosure of any interest that could conflict, or appear to conflict, with the person\'s duties to the laboratory and to patients.',
    reviewFrequencyMonths: 12,
    requiresAnnualReaffirmation: true,
    bodyContent: `A conflict of interest arises where a personal, financial or other interest could influence, or could be seen to influence, the way I carry out my duties. Declaring such interests protects both me and the laboratory.

I understand that I must declare, among others:

1. Any financial interest in, or paid relationship with, a supplier, manufacturer, referral laboratory or client of the laboratory.

2. Any outside employment, consultancy or business that relates to the work of the laboratory.

3. Any close personal or family relationship with a colleague, supplier or client where it could affect, or appear to affect, my objectivity.

4. Any gift, hospitality or benefit offered to me in connection with my work.

5. Any other interest that a reasonable person might consider capable of influencing my professional judgement.

I undertake to declare any such interest below, to keep this declaration up to date, and to report promptly any new conflict that arises after signing. I understand that having an interest is not itself wrong; failing to declare it is.`,
    acknowledgementStatement: 'I have read and understood this Declaration of Conflict of Interest. I have declared any interest that applies to me and will report any new conflict promptly.',
  },
  {
    key: 'adherence',
    formType: 'adherence',
    title: 'Declaration of Adherence to the Quality Management System',
    purpose: 'A commitment to work within the laboratory\'s quality management system, procedures and safety requirements.',
    reviewFrequencyMonths: 12,
    requiresAnnualReaffirmation: true,
    bodyContent: `The laboratory operates a quality management system so that its results can be trusted and its work is safe. Every member of staff is part of that system.

I undertake that:

1. I will work in accordance with the laboratory's quality policy, quality manual and authorised procedures.

2. I will use only the current, controlled version of a procedure, form or document, and will not use a superseded or uncontrolled copy.

3. I will run and record quality control as required, and will not release results from a run that is out of control.

4. I will complete records accurately and contemporaneously and maintain the traceability of every specimen and result.

5. I will follow all safety, biosafety, and waste-management requirements and use protective equipment as the risk assessment requires.

6. I will report nonconformities, incidents, and near misses through the proper channel rather than working around them.

7. I will take part in the training, competency assessment and continual improvement activities that the quality system requires of me.`,
    acknowledgementStatement: 'I have read and understood this Declaration of Adherence and undertake to work within the laboratory\'s quality management system.',
  },
];

export function declarationTemplate(key: string): DeclarationTemplate | undefined {
  return DECLARATION_TEMPLATES.find(t => t.key === key);
}
