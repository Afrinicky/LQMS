import { useCallback, useEffect, useState } from 'react';

// ==========================================================================
// The laboratory works in two rooms: a dim one at the bench and a bright one
// at a desk by a window. The theme is therefore the reader's own setting,
// remembered on this machine, and applied to the document before the app
// paints so nothing flashes the wrong colour on the way in.
// ==========================================================================

export type Theme = 'dark' | 'light';
const KEY = 'sechlims.theme';

export function storedTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* private window, or storage refused */ }
  return 'dark';
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(KEY, theme); } catch { /* nothing to remember it with */ }
  }, [theme]);

  const toggle = useCallback(() => setTheme(t => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, setTheme, toggle };
}
