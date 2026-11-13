import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../../src/services/api';

/**
 * What this installation of TransLis is.
 *
 * The mode is not decoration: it changes what the Analyser Sync page offers
 * and what the workspace says it is doing. On the analyser's own PC a watched
 * export folder is the ordinary arrangement and a network listener is the
 * unusual one; on a laboratory network it is the other way round. A screen
 * that offered both equally would be asking every site to work out which half
 * applies to it.
 */
export type ModeOption = { key: 'lan' | 'direct'; label: string; blurb: string };

export type Installation = {
  mode: 'lan' | 'direct';
  modeLabel: string;
  retentionDays: number;
  lisName: string;
  modes: ModeOption[];
  retention: { overdue: number; retentionDays: number; oldest: string | null };
  network: {
    boundTo: string;
    port: number;
    reachableFromNetwork: boolean;
    /** The mode has been changed and the host has not been restarted yet. */
    restartNeeded: boolean;
  };
};

type Value = {
  installation: Installation | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

const InstallationContext = createContext<Value | undefined>(undefined);

export function InstallationProvider({ children }: { children: React.ReactNode }) {
  const [installation, setInstallation] = useState<Installation | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try { setInstallation(await api<Installation>('/translis/settings')); }
    catch { /* not signed in yet, or the host is still coming up */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <InstallationContext.Provider value={{ installation, loading, refresh }}>
      {children}
    </InstallationContext.Provider>
  );
}

export function useInstallation(): Value {
  return useContext(InstallationContext) ?? { installation: null, loading: false, refresh: async () => {} };
}
