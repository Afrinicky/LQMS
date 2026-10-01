import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sechlims.theme';
/** When this device last chose for itself, so a later laboratory-wide default wins. */
const CHOSEN_AT_KEY = 'sechlims.theme.at';
/** The laboratory's own default, kept so the sign-in screen is themed too. */
const DEFAULT_KEY = 'sechlims.theme.default';

/** The choice lives in localStorage, so it survives a restart with no network
 *  and no database round-trip — the application is offline-first. */
function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

function readKey(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeKey(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode — the session still themes correctly */ }
}

export function resolveInitialTheme(): Theme {
  const laboratory = readKey(DEFAULT_KEY);
  return readStored() ?? (laboratory === 'dark' ? 'dark' : 'light');
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0A1322' : '#FFFFFF');
}

type ThemeValue = { theme: Theme; setTheme: (t: Theme) => void; toggleTheme: () => void };

const ThemeContext = createContext<ThemeValue>({ theme: 'light', setTheme: () => {}, toggleTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme);

  useEffect(() => { applyTheme(theme); }, [theme]);

  /**
   * The laboratory's own default, for a device that has never chosen — and for
   * one whose choice is older than the administrator's.
   *
   * A theme is a per-device preference and stays one: this never overrules a
   * person who picked after the laboratory last decided. It exists because a
   * new machine, or a machine somebody toggled months ago and forgot, had no
   * way of being told what this laboratory actually runs on.
   */
  useEffect(() => {
    let cancelled = false;
    api<{ defaultTheme: Theme; setAt: string | null }>('/system/appearance')
      .then(({ defaultTheme, setAt }) => {
        if (cancelled) return;
        writeKey(DEFAULT_KEY, defaultTheme);
        const chosenAt = readKey(CHOSEN_AT_KEY);
        const deviceIsStale = !chosenAt || (setAt !== null && setAt > chosenAt);
        if (deviceIsStale && defaultTheme !== theme) setThemeState(defaultTheme);
      })
      .catch(() => { /* offline, or signed out — the device keeps what it has */ });
    return () => { cancelled = true; };
    // Read once per mount: a laboratory default that fought the toggle on every
    // render would be a theme nobody could change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writeKey(STORAGE_KEY, t);
    writeKey(CHOSEN_AT_KEY, new Date().toISOString());
  }, []);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [setTheme, theme]);
  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
