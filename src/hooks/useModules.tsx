import { createContext, useContext, useEffect, useState } from 'react';
import { getModules } from '../services/api';
import type { SystemModule } from '../../shared/types/api';
const ModuleContext = createContext<{ modules: SystemModule[]; refresh: () => Promise<void>; isEnabled: (key: string) => boolean } | undefined>(undefined);
export function ModuleProvider({ children }: { children: React.ReactNode }) {
  const [modules, setModules] = useState<SystemModule[]>([]);
  async function refresh() { setModules(await getModules().catch(() => [])); }
  useEffect(() => { void refresh(); }, []);
  const isEnabled = (key: string) => key === 'settings' || modules.find(m => m.key === key)?.enabled !== false;
  return <ModuleContext.Provider value={{ modules, refresh, isEnabled }}>{children}</ModuleContext.Provider>;
}
export function useModules() { const ctx = useContext(ModuleContext); if (!ctx) throw new Error('useModules must be used inside ModuleProvider'); return ctx; }
