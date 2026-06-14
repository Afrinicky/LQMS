import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';

/** EmptyState — consistent placeholder for empty lists/tables. */
export default function EmptyState({
  title = 'Nothing here yet',
  message,
  icon,
  action,
}: {
  title?: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="es-ico">{icon ?? <Inbox size={26} />}</span>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  );
}
