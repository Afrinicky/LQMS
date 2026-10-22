import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Users2, FileCode2 } from 'lucide-react';
import TextField from '../../components/ui/TextField';
import { Notice } from '../../components/ui/Feedback';
import { errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import {
  AUDIENCE_GROUP_SOURCES, CHANNEL_LABELS, COMMUNICATION_CHANNELS,
  COMMUNICATION_CONFIDENTIALITY, COMMUNICATION_TYPES, COMMUNICATION_TYPE_LABELS,
  COMM_FEATURE, type CommunicationType,
} from '../../../shared/constants/communications';
import type { CommunicationAudience, CommunicationTemplate } from '../../../shared/types/api';
import { badge, loadAudiences, post, pretty, put, typeLabel, useCommunicationWorkspace } from './communicationData';

/**
 * The configuration behind the hub: who may be addressed, and what the
 * laboratory's standard communications say.
 *
 * An audience is deliberately a RULE rather than a list wherever it can be.
 * "All laboratory staff" written out as forty names is wrong the day somebody
 * joins, and nobody notices until a notice misses them. A rule is resolved
 * against the register every time it is used, so the audience follows the
 * organisation. A fixed list and a list of external addresses are both kept
 * for the cases a rule cannot express.
 *
 * A template is the laboratory's own wording for a communication it sends
 * repeatedly, together with its default audience, channel, approval
 * requirement and confidentiality — so a staff notice is addressed and
 * classified the same way every time, by whoever happens to be writing it.
 */

const AUDIENCE_RULE_KINDS = [
  { key: 'laboratory_staff', label: 'All laboratory staff', needsRef: false },
  { key: 'all_users', label: 'All SECH_LIMS users', needsRef: false },
  { key: 'unit_leads', label: 'Unit heads and those acting for them', needsRef: false },
  { key: 'position_match', label: 'Positions whose title contains…', needsRef: true, refLabel: 'Title contains' },
  { key: 'stakeholder_group', label: 'A stakeholder type', needsRef: true, refLabel: 'Stakeholder type' },
  { key: 'section', label: 'One unit', needsRef: true, refLabel: 'Unit id' },
  { key: 'department', label: 'One department', needsRef: true, refLabel: 'Department id' },
  { key: 'role', label: 'One access profile', needsRef: true, refLabel: 'Access profile id' },
  { key: 'position', label: 'One position', needsRef: true, refLabel: 'Position id' },
] as const;

const EMPTY_AUDIENCE = {
  audienceCode: '', audienceName: '', description: '',
  source: 'organisation_rule', ruleKind: 'laboratory_staff', ruleRef: '',
  staffIds: '', addresses: '',
};

const EMPTY_TEMPLATE = {
  templateCode: '', templateName: '', communicationType: 'memo' as CommunicationType,
  subject: '', body: '', defaultAudienceKind: '', defaultAudienceRef: '',
  defaultChannel: 'in_app', requiresApproval: false, requiresAcknowledgement: false,
  confidentiality: 'internal',
};

export default function CommunicationAdmin() {
  const { can } = usePermissions();
  const { templates, reload } = useCommunicationWorkspace(true);
  const [audiences, setAudiences] = useState<CommunicationAudience[]>([]);
  const [audienceForm, setAudienceForm] = useState({ ...EMPTY_AUDIENCE });
  const [templateForm, setTemplateForm] = useState({ ...EMPTY_TEMPLATE });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mayCreate = can(COMM_FEATURE.admin, 'create');
  const mayEdit = can(COMM_FEATURE.admin, 'edit');

  const load = useCallback(async () => {
    try { setAudiences(await loadAudiences()); }
    catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function ruleFor(form: typeof EMPTY_AUDIENCE): unknown {
    if (form.source === 'staff_list') {
      return { staffIds: form.staffIds.split(/[,\s]+/).map(Number).filter(Number.isFinite) };
    }
    if (form.source === 'external_list') {
      return { addresses: form.addresses.split(/[,\n]+/).map(s => s.trim()).filter(Boolean) };
    }
    const kind = form.ruleKind;
    if (kind === 'position_match') return { kind, match: form.ruleRef };
    if (kind === 'stakeholder_group') return { kind, stakeholderType: form.ruleRef };
    if (['section', 'department', 'role', 'position'].includes(kind)) return { kind, ref: form.ruleRef };
    return { kind };
  }

  async function submitAudience(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      await post('/communications/audiences', {
        audienceCode: audienceForm.audienceCode || undefined,
        audienceName: audienceForm.audienceName,
        description: audienceForm.description || null,
        source: audienceForm.source,
        rule: ruleFor(audienceForm),
      });
      setNotice(`Audience “${audienceForm.audienceName}” is available to senders.`);
      setAudienceForm({ ...EMPTY_AUDIENCE });
      await load();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function toggleAudience(row: CommunicationAudience) {
    setBusy(true); setError(null);
    try {
      await put(`/communications/audiences/${row.id}`, { isActive: row.is_active !== 1 });
      await load();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function submitTemplate(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      await post('/communications/templates', {
        templateCode: templateForm.templateCode || undefined,
        templateName: templateForm.templateName,
        communicationType: templateForm.communicationType,
        subject: templateForm.subject,
        body: templateForm.body,
        defaultAudienceKind: templateForm.defaultAudienceKind || null,
        defaultAudienceRef: templateForm.defaultAudienceRef || null,
        defaultChannel: templateForm.defaultChannel,
        requiresApproval: templateForm.requiresApproval,
        requiresAcknowledgement: templateForm.requiresAcknowledgement,
        confidentiality: templateForm.confidentiality,
      });
      setNotice(`Template “${templateForm.templateName}” is available in the compose screen.`);
      setTemplateForm({ ...EMPTY_TEMPLATE });
      await reload();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  async function toggleTemplate(row: CommunicationTemplate) {
    setBusy(true); setError(null);
    try {
      await put(`/communications/templates/${row.id}`, { isActive: row.is_active !== 1 });
      await reload();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  const ruleKind = AUDIENCE_RULE_KINDS.find(k => k.key === audienceForm.ruleKind);

  return (
    <div className="comm-admin">
      {error && <Notice kind="error">{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}

      <section>
        <h3><Users2 size={15} /> Audiences</h3>
        <p className="cc-hint">
          A rule-based audience resolves against the register every time it is used, so it follows the
          organisation instead of going stale. The count below is who it reaches today.
        </p>

        {mayCreate && (
          <form className="form-grid" onSubmit={submitAudience}>
            <label>Name
              <TextField value={audienceForm.audienceName} onValue={v => setAudienceForm({ ...audienceForm, audienceName: v })}
                required placeholder="e.g. Night shift" />
            </label>
            <label>Code
              <TextField value={audienceForm.audienceCode} onValue={v => setAudienceForm({ ...audienceForm, audienceCode: v })}
                placeholder="Derived from the name if left blank" />
            </label>
            <label>How members are decided
              <select value={audienceForm.source} onChange={e => setAudienceForm({ ...audienceForm, source: e.target.value })}>
                {AUDIENCE_GROUP_SOURCES.map(s => <option key={s} value={s}>{
                  s === 'organisation_rule' ? 'A rule over the organisation' :
                  s === 'staff_list' ? 'A fixed list of staff' : 'A list of external addresses'
                }</option>)}
              </select>
            </label>

            {audienceForm.source === 'organisation_rule' && <>
              <label>Rule
                <select value={audienceForm.ruleKind} onChange={e => setAudienceForm({ ...audienceForm, ruleKind: e.target.value })}>
                  {AUDIENCE_RULE_KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </label>
              {ruleKind?.needsRef && (
                <label>{'refLabel' in ruleKind ? ruleKind.refLabel : 'Value'}
                  <TextField value={audienceForm.ruleRef} onValue={v => setAudienceForm({ ...audienceForm, ruleRef: v })} required />
                </label>
              )}
            </>}

            {audienceForm.source === 'staff_list' && (
              <label>Staff ids
                <TextField value={audienceForm.staffIds} onValue={v => setAudienceForm({ ...audienceForm, staffIds: v })}
                  placeholder="Comma-separated, e.g. 4, 11, 23" />
              </label>
            )}
            {audienceForm.source === 'external_list' && (
              <label>Addresses
                <TextField as="textarea" rows={3} value={audienceForm.addresses}
                  onValue={v => setAudienceForm({ ...audienceForm, addresses: v })}
                  placeholder="One per line — email addresses, telephone numbers or handles" />
              </label>
            )}

            <label>Description
              <TextField value={audienceForm.description} onValue={v => setAudienceForm({ ...audienceForm, description: v })}
                placeholder="What this audience is for" />
            </label>
            <button type="submit" disabled={busy}>Add audience</button>
          </form>
        )}

        <table className="data-table">
          <thead><tr><th>Code</th><th>Name</th><th>Members today</th><th>Decided by</th><th>Description</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {audiences.map(a => (
              <tr key={a.id}>
                <td>{a.audience_code}</td>
                <td>{a.audience_name}</td>
                <td>{a.member_count ?? 0}</td>
                <td>{a.source === 'organisation_rule' ? 'A rule over the organisation'
                  : a.source === 'staff_list' ? 'A fixed list of staff' : 'External addresses'}</td>
                <td>{a.description || '—'}</td>
                <td>{badge(a.is_active === 1 ? 'active' : 'inactive')}</td>
                <td>{mayEdit && (
                  <button type="button" disabled={busy} onClick={() => void toggleAudience(a)}>
                    {a.is_active === 1 ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}</td>
              </tr>
            ))}
            {audiences.length === 0 && <tr><td colSpan={7}>No audiences configured.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3><FileCode2 size={15} /> Templates</h3>
        <p className="cc-hint">
          Standard wording, with the audience, channel, approval requirement and confidentiality the
          communication should carry. A sender picks one and it fills the compose screen.
        </p>

        {mayCreate && (
          <form className="form-grid" onSubmit={submitTemplate}>
            <label>Name
              <TextField value={templateForm.templateName} onValue={v => setTemplateForm({ ...templateForm, templateName: v })}
                required placeholder="e.g. Reagent shortage notice" />
            </label>
            <label>Code
              <TextField value={templateForm.templateCode} onValue={v => setTemplateForm({ ...templateForm, templateCode: v })}
                placeholder="Derived from the name if left blank" />
            </label>
            <label>Type
              <select value={templateForm.communicationType}
                onChange={e => setTemplateForm({ ...templateForm, communicationType: e.target.value as CommunicationType })}>
                {COMMUNICATION_TYPES.map(t => <option key={t} value={t}>{COMMUNICATION_TYPE_LABELS[t]}</option>)}
              </select>
            </label>
            <label>Default channel
              <select value={templateForm.defaultChannel} onChange={e => setTemplateForm({ ...templateForm, defaultChannel: e.target.value })}>
                {COMMUNICATION_CHANNELS.map(c => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
              </select>
            </label>
            <label>Default audience
              <select value={templateForm.defaultAudienceRef}
                onChange={e => setTemplateForm({
                  ...templateForm,
                  defaultAudienceRef: e.target.value,
                  defaultAudienceKind: e.target.value ? 'audience_group' : '',
                })}>
                <option value="">— none —</option>
                {audiences.filter(a => a.is_active === 1).map(a => (
                  <option key={a.audience_code} value={a.audience_code}>{a.audience_name}</option>
                ))}
              </select>
            </label>
            <label>Confidentiality
              <select value={templateForm.confidentiality} onChange={e => setTemplateForm({ ...templateForm, confidentiality: e.target.value })}>
                {COMMUNICATION_CONFIDENTIALITY.map(c => <option key={c} value={c}>{pretty(c)}</option>)}
              </select>
            </label>
            <label className="cc-check">
              <input type="checkbox" checked={templateForm.requiresApproval}
                onChange={e => setTemplateForm({ ...templateForm, requiresApproval: e.target.checked })} />
              <span>Requires approval</span>
            </label>
            <label className="cc-check">
              <input type="checkbox" checked={templateForm.requiresAcknowledgement}
                onChange={e => setTemplateForm({ ...templateForm, requiresAcknowledgement: e.target.checked })} />
              <span>Requires acknowledgement</span>
            </label>
            <label>Subject
              <TextField value={templateForm.subject} onValue={v => setTemplateForm({ ...templateForm, subject: v })} required />
            </label>
            <label>Body
              <TextField as="textarea" rows={5} value={templateForm.body}
                onValue={v => setTemplateForm({ ...templateForm, body: v })} />
            </label>
            <button type="submit" disabled={busy}>Add template</button>
          </form>
        )}

        <table className="data-table">
          <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Subject</th><th>Audience</th><th>Channel</th><th>Approval</th><th>Ack</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {templates.map(t => (
              <tr key={t.id}>
                <td>{t.template_code}</td>
                <td>{t.template_name}</td>
                <td>{typeLabel(t.communication_type)}</td>
                <td>{t.subject}</td>
                <td>{t.default_audience_ref || '—'}</td>
                <td>{CHANNEL_LABELS[(t.default_channel ?? 'in_app') as keyof typeof CHANNEL_LABELS] ?? pretty(t.default_channel)}</td>
                <td>{t.requires_approval === 1 ? 'Required' : '—'}</td>
                <td>{t.requires_acknowledgement === 1 ? 'Required' : '—'}</td>
                <td>{badge(t.is_active === 1 ? 'active' : 'inactive')}</td>
                <td>{mayEdit && (
                  <button type="button" disabled={busy} onClick={() => void toggleTemplate(t)}>
                    {t.is_active === 1 ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}</td>
              </tr>
            ))}
            {templates.length === 0 && <tr><td colSpan={10}>No templates configured.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
