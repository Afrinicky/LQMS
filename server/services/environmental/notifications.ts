/**
 * Environmental notification dispatch.
 *
 * Channels sit behind one `NotificationChannel` interface — the same plugin
 * pattern as device drivers — so email/SMS/WhatsApp adapters can be added later
 * without changing the escalation logic.
 *
 * Escalation model: each `environmental_escalation_rules` row targets a severity
 * and a `delay_minutes`. When a matching alert has been active (and NOT
 * acknowledged) for at least that delay, one queue entry is created per
 * (alert × rule) and delivered by the worker. A rule with delay 0 notifies
 * immediately; higher delays form the escalation ladder.
 */
type DB = any;

export type NotifyPayload = { channel: string; recipients?: string | null; subject: string; body: string; severity?: string; alertId?: number | null };

export interface NotificationChannel {
  key: string;
  label: string;
  /** Fully working now, or a registered-but-pending adapter. */
  ready: (settings: any) => boolean;
  send: (db: DB, payload: NotifyPayload, settings: any) => Promise<{ ok: boolean; error?: string }>;
}

const inApp: NotificationChannel = {
  key: 'in_app', label: 'In-app / dashboard', ready: () => true,
  async send(db, p) {
    db.prepare('INSERT INTO notifications (user_id, module_key, title, message, status) VALUES (NULL, ?, ?, ?, ?)')
      .run('facilities_safety', p.subject, p.body, 'unread');
    return { ok: true };
  },
};

// Teams/Slack-compatible incoming webhook — works today with just a URL, no deps.
const webhook: NotificationChannel = {
  key: 'webhook', label: 'Webhook (Teams/Slack)', ready: (s) => !!s?.webhook_url,
  async send(_db, p, s) {
    if (!s?.webhook_url) return { ok: false, error: 'No webhook URL configured in settings.' };
    try {
      const res = await fetch(s.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${p.subject}*\n${p.body}` }) });
      return res.ok ? { ok: true } : { ok: false, error: `Webhook responded ${res.status}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
};

// Pending adapters: queued and clearly marked until a relay is installed.
function pending(key: string, label: string, note: string): NotificationChannel {
  return { key, label, ready: () => false, async send() { return { ok: false, error: note }; } };
}

let registry: Map<string, NotificationChannel> | null = null;
export function getChannels(): Map<string, NotificationChannel> {
  if (registry) return registry;
  const list: NotificationChannel[] = [
    inApp, webhook,
    pending('email', 'Email', 'Email relay (SMTP) not configured on this host.'),
    pending('sms', 'SMS', 'SMS gateway not configured on this host.'),
    pending('whatsapp', 'WhatsApp', 'WhatsApp Business API not configured on this host.'),
    pending('teams', 'Microsoft Teams', 'Use the Webhook channel with a Teams incoming-webhook URL.'),
  ];
  registry = new Map(list.map(c => [c.key, c]));
  return registry;
}
export function listChannels(settings: any) {
  return Array.from(getChannels().values()).map(c => ({ key: c.key, label: c.label, ready: c.ready(settings) }));
}

function getSettings(db: DB) { return db.prepare('SELECT * FROM environmental_settings WHERE id = 1').get() as any ?? {}; }
function matchesSeverity(ruleSeverity: string, alertSeverity: string) { return ruleSeverity === 'any' || ruleSeverity === alertSeverity; }

/** Queue any rules due for an alert right now (respects the (alert,rule) unique index). */
export function enqueueForAlert(db: DB, alertId: number) {
  const alert = db.prepare('SELECT * FROM environmental_alerts WHERE id = ?').get(alertId) as any;
  if (!alert || alert.status !== 'active') return;
  const asset = alert.asset_id ? db.prepare('SELECT name, asset_code FROM environmental_assets WHERE id = ?').get(alert.asset_id) as any : null;
  const rules = db.prepare('SELECT * FROM environmental_escalation_rules WHERE is_active = 1').all() as any[];
  const ageMin = (Date.now() - new Date(alert.triggered_at).getTime()) / 60000;
  for (const rule of rules) {
    if (!matchesSeverity(rule.severity, alert.severity)) continue;
    if (ageMin < (rule.delay_minutes ?? 0)) continue;
    const exists = db.prepare('SELECT id FROM environmental_notification_queue WHERE alert_id = ? AND rule_id = ?').get(alertId, rule.id);
    if (exists) continue;
    const subject = `[${alert.severity.toUpperCase()}] ${asset?.name || 'Environmental'} — ${String(alert.alert_type).replace(/_/g, ' ')}`;
    const level = (rule.delay_minutes ?? 0) > 0 ? ` (escalation +${rule.delay_minutes}m)` : '';
    db.prepare('INSERT OR IGNORE INTO environmental_notification_queue (alert_id, rule_id, channel, recipients, subject, body, severity, status, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(alertId, rule.id, rule.channel, rule.recipients ?? null, subject, `${alert.message || ''}${level}`, alert.severity, 'pending', new Date().toISOString());
  }
  processQueue(db);
}

/** Periodic sweep: escalate still-active, unacknowledged alerts and deliver the queue. */
export function escalationSweep(db: DB) {
  const active = db.prepare("SELECT id FROM environmental_alerts WHERE status = 'active'").all() as any[];
  for (const a of active) enqueueForAlert(db, a.id);
  processQueue(db);
}

/** Deliver pending, due queue entries through their channel adapter. */
export function processQueue(db: DB) {
  const settings = getSettings(db);
  const channels = getChannels();
  const now = new Date().toISOString();
  const due = db.prepare("SELECT * FROM environmental_notification_queue WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY id LIMIT 50").all(now) as any[];
  for (const item of due) {
    const channel = channels.get(item.channel);
    if (!channel) { db.prepare("UPDATE environmental_notification_queue SET status = 'failed', error = ? WHERE id = ?").run('Unknown channel', item.id); continue; }
    void channel.send(db, { channel: item.channel, recipients: item.recipients, subject: item.subject, body: item.body, severity: item.severity, alertId: item.alert_id }, settings)
      .then(r => {
        db.prepare('UPDATE environmental_notification_queue SET attempts = attempts + 1, status = ?, error = ?, sent_at = ? WHERE id = ?')
          .run(r.ok ? 'sent' : 'failed', r.error ?? null, r.ok ? new Date().toISOString() : null, item.id);
      })
      .catch(e => db.prepare("UPDATE environmental_notification_queue SET attempts = attempts + 1, status = 'failed', error = ? WHERE id = ?").run((e as Error).message, item.id));
  }
}
