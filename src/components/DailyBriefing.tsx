import { useNavigate } from 'react-router-dom';
import { CalendarClock, CheckCircle2, ClipboardList, Clock, Sunrise, X } from 'lucide-react';
import { useDutyReminders } from '../hooks/useDutyReminders';
import { CATEGORY_LABELS, frequencyPhrase, type ActivityCategory } from '../../shared/constants/activities';

/**
 * The start-of-day briefing.
 *
 * The laboratory's description of this was precise: the person signs in in the
 * morning and is told everything they are on duty to do that day — temperature
 * charting, humidity, the equipment checks, the weekly reagent change, the
 * monthly clean. So this is a read of the day, not a task manager: it lists,
 * it groups by how often the work comes round, and it gets out of the way.
 *
 * It opens once per calendar day, only when there is something to say, and only
 * for somebody who has not switched it off. A briefing that appears every time
 * you navigate is a briefing people learn to close without reading.
 */
export default function DailyBriefing() {
  const { data, briefingOpen, dismissBriefing } = useDutyReminders();
  const navigate = useNavigate();
  if (!briefingOpen || !data) return null;

  const open = data.mine.filter(o => o.status === 'pending' || o.status === 'in_progress');
  const mySchedules = data.scheduleTasks.filter(t => t.isMine);
  const totalMinutes = open.reduce((sum, o) => sum + (o.estimated_minutes ?? 0), 0);

  // Group by cadence so the day reads the way people think about it: the things
  // that happen every day, then this week's, then this month's.
  const groups: Array<{ title: string; items: typeof open }> = [
    { title: 'Every day', items: open.filter(o => o.frequency === 'daily' || o.frequency === 'per_shift') },
    { title: 'This week', items: open.filter(o => o.frequency === 'weekly' || o.frequency === 'fortnightly') },
    { title: 'This month', items: open.filter(o => o.frequency === 'monthly') },
    { title: 'Periodic', items: open.filter(o => ['quarterly', 'biannual', 'annual', 'custom_days'].includes(String(o.frequency))) },
  ].filter(group => group.items.length > 0);

  const firstName = (data.duty.sectionName && data.greetingName) ? data.greetingName.split(/[.\s]/)[0] : data.greetingName;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="briefing-backdrop" role="dialog" aria-modal="true" aria-label="Your day">
      <div className="briefing card">
        <button type="button" className="briefing-close" onClick={dismissBriefing} aria-label="Close">
          <X size={18} />
        </button>

        <header className="briefing-head">
          <span className="briefing-ico"><Sunrise size={22} /></span>
          <div>
            <h2>{greeting}{firstName ? `, ${firstName}` : ''}</h2>
            <p>
              {data.duty.onDuty
                ? <>You are on duty{data.duty.shiftLabel ? ` — ${data.duty.shiftLabel}` : ''}{data.duty.sectionName ? ` in ${data.duty.sectionName}` : ''}{data.duty.benchName ? `, ${data.duty.benchName} bench` : ''}.</>
                : <>You are not on the duty roster today.</>}
            </p>
          </div>
        </header>

        {open.length > 0 && (
          <p className="briefing-lede">
            <ClipboardList size={14} /> {open.length} thing{open.length === 1 ? '' : 's'} to do
            {totalMinutes > 0 && <> · about {totalMinutes} minutes in total</>}
          </p>
        )}

        {groups.map(group => (
          <section key={group.title} className="briefing-group">
            <h3>{group.title}</h3>
            <ul>
              {group.items.map(item => (
                <li key={item.id}>
                  <span className="bg-dot" />
                  <span className="bg-name">{item.activity_name}</span>
                  <span className="bg-meta">
                    {CATEGORY_LABELS[(item.category ?? 'other') as ActivityCategory] ?? item.category}
                    {item.section_name ? ` · ${item.section_name}` : ''}
                    {item.estimated_minutes ? ` · ${item.estimated_minutes} min` : ''}
                    {' · '}{frequencyPhrase(item.frequency ?? 'daily', item.interval_days ?? null)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {mySchedules.length > 0 && (
          <section className="briefing-group">
            <h3><CalendarClock size={13} /> Rosters and schedules you owe</h3>
            <ul>
              {mySchedules.map(task => (
                <li key={`${task.kind}:${task.month}:${task.sectionId ?? 0}`}>
                  <span className={`bg-dot ${task.status === 'overdue' ? 'crit' : 'warn'}`} />
                  <span className="bg-name">{task.kindLabel} — {task.monthLabel}{task.sectionName ? ` (${task.sectionName})` : ''}</span>
                  <span className="bg-meta">{task.message}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {open.length === 0 && mySchedules.length === 0 && (
          <div className="di-clear">
            <CheckCircle2 size={18} />
            <span>Nothing is scheduled for you today.</span>
          </div>
        )}

        {data.counts.missed > 0 && (
          <p className="briefing-missed">
            <Clock size={13} /> {data.counts.missed} activit{data.counts.missed === 1 ? 'y was' : 'ies were'} missed recently. They are on the register for the unit to pick up.
          </p>
        )}

        <footer className="briefing-foot">
          <button type="button" onClick={dismissBriefing}>Start my day</button>
          <button type="button" className="secondary" onClick={() => { dismissBriefing(); navigate('/my-portal'); }}>
            Open my portal
          </button>
        </footer>
      </div>
    </div>
  );
}
