import type {
  ActivityOccurrence, MyDeclarations, MyTasks, NotificationRecord, UserTaskQueueItem,
} from '../../../shared/types/api';
import type { PortalTaskTarget } from './PortalTaskDrawer';

/**
 * Turning an alert into the thing it is about.
 *
 * An alert is never the work. It is a pointer: "attestation required", "action
 * due", "today: fridge temperature". The portal used to follow that pointer by
 * navigating — the alert's `action_url` names a module, a tab and a record to
 * focus — which threw the reader out of their portal to do a job the portal was
 * already holding for them, often twice over, since the same attestation sits
 * in their task list.
 *
 * So the pointer is resolved here instead. Every alert carries `record_type`
 * and `record_id`; the portal has already loaded this person's attestations,
 * declarations, actions, tasks and today's activities, so in the common case
 * the record the alert names is sitting in memory and the matching completion
 * panel opens over the portal with nothing fetched at all.
 *
 * When the record is not one of those — an equipment calibration, an inventory
 * batch, an IQC run — no amount of mapping will let the portal perform it, and
 * the answer is the alert reader (`kind: 'alert'`), which at least keeps the
 * reading and the acknowledging here. That is a deliberate floor, not a gap:
 * the resolver never returns "navigate".
 */

export type NotificationSources = {
  tasks: MyTasks | null;
  declarations: MyDeclarations;
  queue: UserTaskQueueItem[];
  /** Today's activities for this person — their own list and the ones they watch. */
  occurrences: ActivityOccurrence[];
};

/**
 * What record an alert is about.
 *
 * Normally stated outright on the notification. Older rows, and a few producers
 * that only ever set a link, carry it solely inside `action_url` as
 * `?focus=<type>:<id>`, so that is read as a fallback — the alternative is those
 * alerts falling to the reader for want of a value they do in fact carry.
 */
function subjectOf(n: NotificationRecord): { type: string; id: number } | null {
  if (n.record_type && n.record_id != null && String(n.record_id) !== '') {
    return { type: n.record_type, id: Number(n.record_id) };
  }
  const focus = n.action_url?.split('focus=')[1]?.split('&')[0];
  if (!focus) return null;
  const [type, id] = decodeURIComponent(focus).split(':');
  if (!type || !id) return null;
  return { type, id: Number(id) };
}

export function resolveNotificationTarget(n: NotificationRecord, s: NotificationSources): PortalTaskTarget {
  const subject = subjectOf(n);
  const fallback: PortalTaskTarget = { kind: 'alert', notification: n };
  if (!subject || !Number.isFinite(subject.id)) return fallback;
  const { type, id } = subject;

  switch (type) {
    case 'document_attestations': {
      // The attestation must still be owed by this reader. One already signed —
      // or belonging to somebody else — is history, and the reader gets the
      // alert rather than a signature panel for a signature already given.
      const att = (s.tasks?.pendingAttestations ?? []).find(a => Number(a.id) === id);
      if (!att) return fallback;
      return {
        kind: 'attestation',
        attestationId: Number(att.id),
        documentId: Number(att.document_id ?? 0),
        versionId: Number(att.document_version_id ?? 0),
        title: att.title || att.document_code || 'Controlled document',
      };
    }

    case 'ethical_declaration_forms':
    case 'staff_declarations': {
      const d = s.declarations.pending.find(x => Number(x.id) === id);
      return d ? { kind: 'declaration', declaration: d } : fallback;
    }

    case 'actions': {
      const a = (s.tasks?.assignedActions ?? []).find(x => Number(x.id) === id);
      if (!a) return fallback;
      return { kind: 'action', id: Number(a.id), title: a.title, description: a.description, status: a.status, dueDate: a.due_date };
    }

    case 'user_task_queue': {
      const t = s.queue.find(x => Number(x.id) === id);
      if (!t) return fallback;
      return { kind: 'queueTask', id: Number(t.id), title: t.title, description: t.description, status: t.status };
    }

    case 'activity_occurrences': {
      const o = s.occurrences.find(x => Number(x.id) === id);
      return o ? { kind: 'occurrence', occurrence: o } : fallback;
    }

    case 'documents':
      return { kind: 'document', documentId: id, title: n.title };

    default:
      return fallback;
  }
}
