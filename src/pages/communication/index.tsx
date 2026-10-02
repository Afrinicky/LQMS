import CommunicationCentre from './CommunicationCentre';
import MemoWorkspace from './MemoWorkspace';
import CommunicationLog from './CommunicationLog';
import CommunicationAdmin from './CommunicationAdmin';

/**
 * The Communication section of Information Management.
 *
 * Four tabs, one import. The host page (InformationManagementPage) adds the tab
 * names to its own permission-filtered tab bar and renders this; which panel
 * appears is decided here so the host page needs to know nothing about how the
 * hub is put together.
 *
 *   Communication          the person's own conversations — messages in, out
 *                          and threaded, with replies and acknowledgements
 *   Memos & Notices        the formal end: drafting, approval, dispatch and
 *                          preparing copies for channels SECH_LIMS cannot reach
 *   Communication Log      the register of everything, with its audit trail
 *   Audiences & Templates  the configuration behind the other three
 */

/** The tab names, in the order the workspace shows them. */
export const COMMUNICATION_TABS = [
  'Communication', 'Memos & Notices', 'Communication Log', 'Audiences & Templates',
] as const;

export type CommunicationTab = (typeof COMMUNICATION_TABS)[number];

export function isCommunicationTab(tab: string): tab is CommunicationTab {
  return (COMMUNICATION_TABS as readonly string[]).includes(tab);
}

export default function CommunicationSection({ tab }: { tab: string }) {
  if (tab === 'Communication') return <CommunicationCentre />;
  if (tab === 'Memos & Notices') return <MemoWorkspace />;
  if (tab === 'Communication Log') return <CommunicationLog />;
  if (tab === 'Audiences & Templates') return <CommunicationAdmin />;
  return null;
}
