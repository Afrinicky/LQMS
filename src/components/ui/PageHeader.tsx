import WaveBackground from './WaveBackground';
import MedicalLabBackgroundMarks from './MedicalLabBackgroundMarks';

/**
 * PageHeader — reusable section banner with the premium wave + faint medical
 * lab background motifs. Gives every page/section a consistent, branded top.
 */
export default function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="bg-deco">
        <WaveBackground variant="header" />
        <MedicalLabBackgroundMarks />
      </div>
      <div className="ph-inner">
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
          {subtitle && <p className="ph-sub">{subtitle}</p>}
        </div>
        {actions && <div className="ph-actions">{actions}</div>}
      </div>
    </header>
  );
}
