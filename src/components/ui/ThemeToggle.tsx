import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';

/** One control, two modes. It reads as the mode you will get, not the one you
 *  are in, which is the way a light switch works. */
export function ThemeToggle({ className = 'icon-btn' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={className}
      onClick={toggleTheme}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export default ThemeToggle;
