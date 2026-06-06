export type SetupStatus = { setupComplete: boolean; adminExists: boolean; hostMode: boolean };
export type ApiUser = { id: number; username: string; fullName: string; roleId: number; roleName?: string; staffId?: number | null; isActive: boolean };
export type SystemModule = { id: number; key: string; label: string; path: string; enabled: boolean; alertsPaused: boolean };
export type Position = { id: number; title: string; description?: string; reportsToPositionId?: number | null; isActive: boolean; archivedAt?: string | null };
export type Staff = { id: number; employeeNo?: string; fullName: string; email?: string; phone?: string; isActive: boolean };
export type DashboardSummary = { documents: number; actionsOpen: number; staff: number; modulesEnabled: number; latestBackup?: string | null };
