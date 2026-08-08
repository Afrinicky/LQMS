import {
  LayoutDashboard, LayoutGrid, FileText, Building2, Users, ListChecks, AlertOctagon,
  MessageSquareWarning, ShieldAlert, HeartHandshake, Wrench, ClipboardCheck, Boxes,
  Workflow, Database, TrendingUp, CalendarClock, FileSignature, Gauge, ShieldCheck,
  Thermometer, FlaskConical, Microscope, BadgeCheck, Ruler, Droplets,
  CalendarRange, FolderArchive, Bell, Settings, Home, Activity, Bot, ScanSearch, type LucideIcon,
} from 'lucide-react';

/**
 * Maps module keys (from shared/constants/modules) to thin-line lucide icons,
 * so the sidebar and homepage launchpad share one visual vocabulary.
 */
export const MODULE_ICONS: Record<string, LucideIcon> = {
  home: Home,
  dashboard: LayoutDashboard,
  documents: FileText,
  dennis: Bot,
  organisation: Building2,
  personnel: Users,
  actions: ListChecks,
  nc_capa: AlertOctagon,
  nonconformities: AlertOctagon,
  incidents: ShieldAlert,
  capa: ClipboardCheck,
  complaints: MessageSquareWarning,
  risks: ShieldAlert,
  customer_focus: HeartHandshake,
  equipment: Wrench,
  assessments: ClipboardCheck,
  supplier_inventory: Boxes,
  process_management: Workflow,
  information_management: Database,
  continual_improvement: TrendingUp,
  meetings: CalendarClock,
  management_review: FileSignature,
  quality_indicators: Gauge,
  facilities_safety: ShieldCheck,
  monitoring: Thermometer,
  iqc: FlaskConical,
  eqa: Microscope,
  verification_validation: BadgeCheck,
  measurement_uncertainty: Ruler,
  poct: Activity,
  blood_bank_handover: Droplets,
  monthly_reports: CalendarRange,
  records_reports: FolderArchive,
  notifications: Bell,
  system_audit: ScanSearch,
  settings: Settings,
};

export function moduleIcon(key: string): LucideIcon {
  return MODULE_ICONS[key] ?? LayoutGrid;
}

/**
 * Icons for the top-level NAV_SECTIONS (shared/constants/navigation). Sections
 * that map 1:1 to a module reuse that module's icon; grouped sections get an
 * umbrella icon of their own.
 */
export const SECTION_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  documents_records: FileText,
  organisation: Building2,
  personnel: Users,
  customer_focus: HeartHandshake,
  equipment: Wrench,
  assessments: ClipboardCheck,
  supplier_inventory: Boxes,
  process_management: Activity,
  information_management: Database,
  nonconforming_events: AlertOctagon,
  continual_improvement: TrendingUp,
  facilities_safety: ShieldCheck,
  notifications_reports: Bell,
  system_audit: ScanSearch,
  settings: Settings,
};

export function sectionIcon(key: string): LucideIcon {
  return SECTION_ICONS[key] ?? LayoutGrid;
}
