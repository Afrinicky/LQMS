import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, PenLine, BadgeCheck, ArrowRight } from 'lucide-react';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { usePermissions } from '../hooks/usePermissions';
import { ChangePasswordModal } from './ChangePasswordModal';
import { SignatureModal } from './SignatureModal';

/**
 * The signed-in person, on their own dashboard.
 *
 * Everything here is about *them*: who the system thinks they are, the work
 * assigned to them, and the two self-service actions they actually need. It is
 * deliberately quiet — identity first, a short row of personal numbers, and no
 * decoration competing with the alerts beside it.
 *
 * The personal counts are clickable and lead to the exact list they summarise.
 */
type MyProfile = {
  user: { id: number; username: string; fullName: string; roleName?: string | null };
  staff: {
    employee_no?: string | null; full_name?: string; section_name?: string | null;
    designation?: string | null; job_title?: string | null; primary_position?: string | null;
  } | null;
  positions: { title: string; assignment_type: string; is_active: number }[];
  hasSignature: boolean;
};

type MyWork = {
  myOpenTasks?: number; myDueToday?: number; myOverdueItems?: number;
  myOpenActions?: number; myPendingApprovals?: number; myUnreadNotifications?: number;
};

function initials(name?: string) {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}

export default function DashboardProfileCard() {
  const { user } = useAuth();
  const { canView } = usePermissions();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [work, setWork] = useState<MyWork | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showSignature, setShowSignature] = useState(false);

  useEffect(() => {
    let live = true;
    api<MyProfile>('/personnel/my-profile').then(p => { if (live) setProfile(p); }).catch(() => undefined);
    api<MyWork>('/dashboard/my-work-summary').then(w => { if (live) setWork(w); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const fullName = profile?.user.fullName ?? user?.fullName ?? 'User';
  const role = profile?.user.roleName ?? user?.roleName ?? 'Member';
  const position = profile?.positions.find(p => p.is_active)?.title
    ?? profile?.staff?.primary_position ?? profile?.staff?.job_title ?? profile?.staff?.designation ?? null;

  // Only the counts that lead somewhere this person may actually go.
  const stats = [
    { label: 'Assigned', value: work?.myOpenActions ?? 0, to: '/actions', show: canView('actions') },
    { label: 'Due today', value: work?.myDueToday ?? 0, to: '/notifications', show: canView('notifications') },
    { label: 'Overdue', value: work?.myOverdueItems ?? 0, to: '/notifications', show: canView('notifications'), danger: true },
    { label: 'Approvals', value: work?.myPendingApprovals ?? 0, to: '/notifications', show: canView('notifications') },
  ].filter(s => s.show);

  return (
    <div className="card dash-profile">
      <div className="dp-identity">
        <span className="dp-avatar">{initials(fullName)}</span>
        <div className="dp-who">
          <h3>{fullName}</h3>
          <span className="dp-role">{role}</span>
        </div>
      </div>

      <dl className="dp-facts">
        {position && <div><dt>Position</dt><dd>{position}</dd></div>}
        {profile?.staff?.section_name && <div><dt>Section</dt><dd>{profile.staff.section_name}</dd></div>}
        {profile?.staff?.employee_no && <div><dt>Staff ID</dt><dd>{profile.staff.employee_no}</dd></div>}
        <div>
          <dt>Signature</dt>
          <dd className={profile?.hasSignature ? 'dp-ok' : 'dp-todo'}>
            {profile?.hasSignature ? <><BadgeCheck size={13} /> On file</> : 'Not set up'}
          </dd>
        </div>
      </dl>

      {stats.length > 0 && (
        <div className="dp-stats">
          {stats.map(s => (
            <button key={s.label} type="button" className={`dp-stat${s.danger && s.value > 0 ? ' danger' : ''}`}
              onClick={() => navigate(s.to)} title={`Open ${s.label}`}>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="dp-actions">
        <button type="button" className="secondary" onClick={() => setShowSignature(true)}>
          <PenLine size={14} /> {profile?.hasSignature ? 'Update signature' : 'Add signature'}
        </button>
        <button type="button" className="secondary" onClick={() => setShowPassword(true)}>
          <KeyRound size={14} /> Change password
        </button>
        {!profile?.staff && (
          <span className="dp-hint">
            Your account is not linked to a staff record yet — ask an administrator to link it so your
            tasks, rosters and signatures follow you. <ArrowRight size={12} />
          </span>
        )}
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
      {showSignature && <SignatureModal onClose={() => setShowSignature(false)} />}
    </div>
  );
}
