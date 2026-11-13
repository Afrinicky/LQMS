import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Whether this laboratory transmits at all.
 *
 * A facility may run SECHLIMS for quality management alone, in which case it
 * does not speak to an analyser and must not be shown screens that assume it
 * does. The server refuses those routes either way — this is what stops a
 * person finding the buttons first and the refusal second.
 *
 * It is one boolean, readable by anybody signed in, because almost every
 * surface in the product asks it: the sidebar, the Home launchpad, the Settings
 * rail, the Equipment tabs and the analyser panels on the Quality Control
 * bench. Loading it once here is what keeps them agreeing with each other.
 *
 * Optimism while loading is deliberate. The alternative — assuming off until
 * the answer arrives — makes the analyser entries flash out of the sidebar on
 * every page load for the laboratories that do transmit, which is the common
 * case. The guards below wait for `loading` to clear before refusing anything.
 */
type Switch = {
  /** True when SECHLIMS may reach an analyser. */
  enabled: boolean;
  /** True until the first answer has come back. */
  loading: boolean;
  /** Re-read it — called after an administrator changes it. */
  refresh: () => Promise<void>;
};

const TransmissionContext = createContext<Switch | undefined>(undefined);

export function AnalyserTransmissionProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const answer = await api<{ enabled: boolean }>('/analyser-transmission');
      setEnabled(answer.enabled !== false);
    } catch {
      // A host that cannot be asked is not a reason to hide the module: the
      // routes are guarded on the server, and a network blip must not look
      // like somebody switched transmission off.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <TransmissionContext.Provider value={{ enabled, loading, refresh }}>
      {children}
    </TransmissionContext.Provider>
  );
}

/**
 * The switch, for a screen inside the provider.
 *
 * Returns the permissive answer outside it rather than throwing, so a component
 * rendered in isolation — a test, the setup wizard, the login shell — behaves
 * as it did before this hook existed.
 */
export function useAnalyserTransmission(): Switch {
  return useContext(TransmissionContext)
    ?? { enabled: true, loading: false, refresh: async () => {} };
}
