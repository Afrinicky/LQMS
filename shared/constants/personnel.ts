/**
 * The vocabulary of the Master Personnel Register.
 *
 * These lists were declared twice — once in Personnel Management and once in
 * Settings — which is how a register edited in one place could offer a category
 * the other did not recognise. One declaration, both screens.
 */
export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const PERSONNEL_CATEGORIES = ['STAFF', 'INTERN', 'NSS', 'LOCUM', 'STUDENT', 'CONTRACTOR'] as const;
export const APPOINTMENT_TYPES = ['FULL TIME', 'PART TIME', 'CONTRACT', 'INTERN', 'NSS', 'LOCUM'] as const;
export const NATIONAL_ID_TYPES = ['GHANA CARD', 'PASSPORT', 'VOTER ID', 'DRIVERS LICENCE', 'OTHER'] as const;
export const CADRES = ['Scientist', 'Technician', 'Assistant', 'Other'] as const;
export const AVAILABILITY_STATUSES = ['available', 'on_leave', 'transferred', 'inactive', 'unavailable'] as const;

/**
 * Why somebody left the laboratory.
 *
 * Retirement is one of these, not the name for all of them. An intern whose
 * placement ended, a scientist transferred to another facility and a dismissal
 * are different events, and the register has to be able to say which.
 */
export const EXIT_REASONS = [
  'Retirement',
  'Resignation',
  'Transfer to another facility',
  'End of contract',
  'End of internship / national service',
  'Secondment ended',
  'Study leave',
  'Dismissal',
  'Deceased',
  'Other',
] as const;
export type ExitReason = typeof EXIT_REASONS[number];

/** The shape of the staff add/edit form, and its empty value. */
export type StaffFormValues = {
  employeeNo: string; surname: string; middleName: string; firstName: string; initials: string;
  dateOfBirth: string; gender: string; designation: string; jobTitle: string;
  professionalRegulator: string; professionalLicence: string; licenceExpiryDate: string;
  qualifications: string; sectionId: string; unit: string; personnelCategory: string;
  appointmentType: string; appointmentDate: string; nationalIdType: string; nationalIdNumber: string;
  emergencyContact: string; phone: string; email: string; staffFileLocation: string; positionId: string;
  cadre: string; professionalRank: string; availabilityStatus: string;
};

export const emptyStaffForm = (): StaffFormValues => ({
  employeeNo: '', surname: '', middleName: '', firstName: '', initials: '', dateOfBirth: '', gender: '',
  designation: '', jobTitle: '', professionalRegulator: '', professionalLicence: '', licenceExpiryDate: '',
  qualifications: '', sectionId: '', unit: '', personnelCategory: 'STAFF', appointmentType: 'FULL TIME',
  appointmentDate: '', nationalIdType: 'GHANA CARD', nationalIdNumber: '', emergencyContact: '', phone: '',
  email: '', staffFileLocation: '', positionId: '', cadre: '', professionalRank: '', availabilityStatus: 'available',
});

/** Fill the form from a register row, so "Edit" opens on what is on record. */
export function staffFormFrom(s: Record<string, unknown>): StaffFormValues {
  const str = (k: string) => (s[k] == null ? '' : String(s[k]));
  return {
    ...emptyStaffForm(),
    employeeNo: str('employeeNo'), surname: str('surname'), middleName: str('middleName'), firstName: str('firstName'),
    initials: str('initials'), dateOfBirth: str('dateOfBirth'), gender: str('gender'), designation: str('designation'),
    jobTitle: str('jobTitle'), professionalRegulator: str('professionalRegulator'), professionalLicence: str('professionalLicence'),
    licenceExpiryDate: str('licenceExpiryDate'), qualifications: str('qualifications'), sectionId: str('sectionId'),
    unit: str('unit'), personnelCategory: str('personnelCategory') || 'STAFF',
    appointmentType: str('appointmentType') || 'FULL TIME', appointmentDate: str('appointmentDate'),
    nationalIdType: str('nationalIdType') || 'GHANA CARD', nationalIdNumber: str('nationalIdNumber'),
    emergencyContact: str('emergencyContact'), phone: str('phone'), email: str('email'),
    staffFileLocation: str('staffFileLocation'), positionId: '',
    cadre: str('cadre'), professionalRank: str('professionalRank'),
    availabilityStatus: str('availabilityStatus') || 'available',
  };
}

/** Years of service, shown in the register. */
export function yearsOfService(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '—';
  const yrs = (Date.now() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  return yrs >= 0 ? `${yrs.toFixed(1)} yrs` : '—';
}
