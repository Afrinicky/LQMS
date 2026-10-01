import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';

export type Theme = 'light' | 'dark';
export type Accent = 'blue' | 'teal' | 'indigo' | 'green' | 'slate';
export type Density = 'comfortable' | 'compact';
export type Scale = '100' | '110' | '125';
export type SidebarDefault = 'expanded' | 'collapsed';

/** How this device is set up to look. Every field has a laboratory default. */
export type Appearance = {
  theme: Theme;
  accent: Accent;
  density: Density;
  scale: Scale;
  sidebar: SidebarDefault;
};

export const APPEARANCE_FALLBACK: Appearance = {
  theme: 'light', accent: 'blue', density: 'comfortable', scale: '100', sidebar: 'expanded',
};

const ALLOWED: { [K in keyof Appearance]: readonly Appearance[K][] } = {
  theme: ['light', 'dark'],
  accent: ['blue', 'teal', 'indigo', 'green', 'slate'],
  density: ['comfortable', 'compact'],
  scale: ['100', '110', '125'],
  sidebar: ['expanded', 'collapsed'],
};

/** Per-device, so it survives a restart with no network and no database
 *  round-trip — the application is offline-first. */
const KEY = 'sechlims.appearance';
/** When this device last chose for itself, so a later laboratory answer wins. */
const CHOSEN_AT_KEY = 'sechlims.appearance.at';
/** The old single-value key, so an upgrade does not lose somebody's theme. */
const LEGACY_THEME_KEY = 'sechlims.theme';

function readKey(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode — the session still looks right */ }
}

/** Only values this build knows, so a downgrade cannot leave the UI unstyled. */
function clean(raw: unknown, base: Appearance): Appearance {
  const given = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const name of Object.keys(ALLOWED) as Array<keyof Appearance>) {
    const value = String(given[name] ?? '');
    if ((ALLOWED[name] as readonly string[]).includes(value)) (out as Record<string, string>)[name] = value;
  }
  return out;
}

export function resolveInitialAppearance(): Appearance {
  let stored: unknown = null;
  try { stored = JSON.parse(readKey(KEY) ?? 'null'); } catch { stored = null; }
  const legacy = readKey(LEGACY_THEME_KEY);
  const base: Appearance = legacy === 'dark' || legacy === 'light'
    ? { ...APPEARANCE_FALLBACK, theme: legacy as Theme }
    : APPEARANCE_FALLBACK;
  return clean(stored, base);
}

/** Everything the look depends on lives on <html>, so CSS alone decides it. */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  root.setAttribute('data-theme', a.theme);
  root.setAttribute('data-accent', a.accent);
  root.setAttribute('data-density', a.density);
  root.setAttribute('data-scale', a.scale);
  root.style.colorScheme = a.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', a.theme === 'dark' ? '#0A1322' : '#FFFFFF');
}

/** Kept for callers that only care about light or dark. */
export function resolveInitialTheme(): Theme { return resolveInitialAppearance().theme; }
export function applyTheme(theme: Theme) { applyAppearance({ ...resolveInitialAppearance(), theme }); }

type ThemeValue = {
  theme: Theme;
  appearance: Appearance;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  /** Change one or more parts of how this device looks. */
  setAppearance: (next: Partial<Appearance>) => void;
};

const ThemeContext = createContext<ThemeValue>({
  theme: 'light', appearance: APPEARANCE_FALLBACK,
  setTheme: () => {}, toggleTheme: () => {}, setAppearance: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [appearance, setState] = useState<Appearance>(resolveInitialAppearance);

  useEffect(() => { applyAppearance(appearance); }, [appearance]);

  /**
   * The laboratory's own answer, for a device that has never chosen — and for
   * one whose choice is older than the administrator's.
   *
   * These stay per-device preferences: this never overrules somebody who picked
   * after the laboratory last decided. It exists because a new machine, or one
   * somebody adjusted months ago and forgot, had no way of being told what this
   * laboratory actually runs on.
   */
  useEffect(() => {
    let cancelled = false;
    api<Partial<Appearance> & { setAt: string | null }>('/system/appearance')
      .then(answer => {
        if (cancelled) return;
        const chosenAt = readKey(CHOSEN_AT_KEY);
        const deviceIsStale = !chosenAt || (answer.setAt !== null && answer.setAt > chosenAt);
        if (!deviceIsStale) return;
        setState(current => clean(answer, current));
      })
      .catch(() => { /* offline, or signed out — the device keeps what it has */ });
    return () => { cancelled = true; };
    // Read once per mount: a laboratory answer that fought the toggle on every
    // render would be a theme nobody could change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setAppearance = useCallback((next: Partial<Appearance>) => {
    setState(current => {
      const merged = clean({ ...current, ...next }, current);
      writeKey(KEY, JSON.stringify(merged));
      writeKey(CHOSEN_AT_KEY, new Date().toISOString());
      return merged;
    });
  }, []);

  const setTheme = useCallback((t: Theme) => setAppearance({ theme: t }), [setAppearance]);
  const toggleTheme = useCallback(
    () => setAppearance({ theme: appearance.theme === 'dark' ? 'light' : 'dark' }),
    [setAppearance, appearance.theme],
  );

  const value = useMemo(
    () => ({ theme: appearance.theme, appearance, setTheme, toggleTheme, setAppearance }),
    [appearance, setTheme, toggleTheme, setAppearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
