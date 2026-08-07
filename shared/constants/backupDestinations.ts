/**
 * Where copies of a backup are sent.
 *
 * A laboratory's backups need to exist in more than one place, and which places
 * are available depends on what the institution already has. A hospital with a
 * file server wants a folder on it. One with an IT department may have MinIO or
 * a NAS. One with a cloud budget may want Backblaze or Wasabi. None of these is
 * more "correct" than the others, so the system takes a list of destinations
 * rather than one blessed provider.
 *
 * Four kinds cover almost everything a laboratory will actually have:
 *
 *   folder          another disk on this machine, or a USB drive left plugged in
 *   network         a shared folder on the hospital's own server
 *   s3              anything speaking the S3 protocol — MinIO on your own
 *                   hardware, Backblaze B2, Wasabi, Cloudflare R2, AWS,
 *                   DigitalOcean Spaces, Synology and QNAP NAS boxes
 *   webdav          Nextcloud, ownCloud, and most NAS boxes
 *   google_drive    Google Drive, via a service account
 *
 * The field lists here drive the forms on screen, so adding a provider means
 * describing it once rather than writing another form.
 */

export const DESTINATION_KINDS = ['folder', 'network', 's3', 'webdav', 'google_drive'] as const;
export type DestinationKind = typeof DESTINATION_KINDS[number];

export type DestinationField = {
  key: string;
  label: string;
  /** `secret` fields are write-only: stored, never sent back to a browser. */
  type: 'text' | 'password' | 'path' | 'textarea' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  help?: string;
};

export type DestinationKindDef = {
  kind: DestinationKind;
  label: string;
  /** One line, in the words of somebody who has to choose. */
  tagline: string;
  /** What this is good for, and what it costs. */
  detail: string;
  /** Named examples, so "S3-compatible" means something to a non-specialist. */
  worksWith?: string;
  /** True when the destination is off this machine — i.e. survives it failing. */
  offSite: boolean;
  needsInternet: boolean;
  fields: DestinationField[];
};

export const DESTINATION_KINDS_DEF: DestinationKindDef[] = [
  {
    kind: 'network',
    label: 'Hospital server or shared folder',
    tagline: 'A folder on another machine on your network',
    detail:
      'The simplest way to get backups off this computer. Point it at a shared folder on the hospital server. Nothing to buy, nothing to install, and it keeps working when the internet does not.',
    worksWith: 'Windows shared folders, Samba, a mapped drive, any NAS with file sharing',
    offSite: true,
    needsInternet: false,
    fields: [
      { key: 'path', label: 'Folder path', type: 'path', required: true,
        placeholder: '\\\\hospital-server\\backups\\lims   or   /mnt/hospital/backups',
        help: 'A UNC path on Windows, or a mount point on Linux. This host must already be able to reach it — if it opens in the file manager on this machine, it will work here.' },
    ],
  },
  {
    kind: 'folder',
    label: 'Another folder on this computer',
    tagline: 'A second disk, or a USB drive left plugged in',
    detail:
      'Protects against the system disk failing, but not against the machine being stolen or the building flooding. Worth having as well as an off-site copy, not instead of one.',
    offSite: false,
    needsInternet: false,
    fields: [
      { key: 'path', label: 'Folder path', type: 'path', required: true,
        placeholder: 'D:\\LIMS-Backups   or   /media/backup-drive/lims' },
    ],
  },
  {
    kind: 's3',
    label: 'S3 storage',
    tagline: 'Your own server, or inexpensive cloud storage',
    detail:
      'One setting reaches a great many providers, because they all speak the same protocol. Run MinIO on hardware you already own and it costs nothing; use Backblaze B2 or Wasabi and it is a few dollars a month for a laboratory-sized backup.',
    worksWith: 'MinIO (self-hosted, free), Backblaze B2, Wasabi, Cloudflare R2, AWS S3, DigitalOcean Spaces, Synology and QNAP',
    offSite: true,
    needsInternet: false,
    fields: [
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: true,
        placeholder: 'https://s3.us-west-004.backblazeb2.com',
        help: 'Your provider publishes this. For MinIO on your own server it is that server\'s address, e.g. http://192.168.1.20:9000.' },
      { key: 'region', label: 'Region', type: 'text', placeholder: 'us-east-1',
        help: 'Leave as us-east-1 if your provider does not use regions.' },
      { key: 'bucket', label: 'Bucket', type: 'text', required: true, placeholder: 'sech-lims-backups' },
      { key: 'prefix', label: 'Folder inside the bucket', type: 'text', placeholder: 'backups/',
        help: 'Optional. Keeps backups tidy if the bucket holds other things.' },
      { key: 'accessKeyId', label: 'Access key ID', type: 'text', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'password', required: true },
      { key: 'forcePathStyle', label: 'Use path-style addressing', type: 'checkbox',
        help: 'Needed by MinIO and some NAS boxes. Leave off for the large cloud providers.' },
    ],
  },
  {
    kind: 'webdav',
    label: 'Nextcloud, ownCloud or a NAS',
    tagline: 'Anything that speaks WebDAV',
    detail:
      'If the hospital already runs Nextcloud, or the NAS has WebDAV switched on, this needs nothing more than a username and password.',
    worksWith: 'Nextcloud, ownCloud, Synology, QNAP, Koofr, and most NAS boxes',
    offSite: true,
    needsInternet: false,
    fields: [
      { key: 'url', label: 'WebDAV address', type: 'text', required: true,
        placeholder: 'https://cloud.hospital.org/remote.php/dav/files/lims/Backups',
        help: 'In Nextcloud this is under Settings → WebDAV, at the bottom of the files page.' },
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password or app password', type: 'password', required: true,
        help: 'Use an app password rather than the account password where the server offers one.' },
    ],
  },
  {
    kind: 'google_drive',
    label: 'Google Drive',
    tagline: 'A Drive folder, via a service account',
    detail:
      'Needs a Google Cloud project and a service account, because this host runs unattended and cannot complete a sign-in prompt. Free for the first 15 GB on a normal Google account.',
    offSite: true,
    needsInternet: true,
    fields: [
      { key: 'serviceAccountKey', label: 'Service-account key (paste the whole JSON file)', type: 'textarea', required: true,
        placeholder: '{ "type": "service_account", "project_id": "…", "client_email": "…", "private_key": "…" }' },
      { key: 'folderId', label: 'Destination folder ID', type: 'text',
        placeholder: '1AbC2dEfGhIjKlMnOpQrStUvWxYz',
        help: 'Open the folder in Drive; the ID is the last part of the address bar. Share it with the service account as an Editor.' },
    ],
  },
];

export const kindDef = (kind: string): DestinationKindDef | undefined =>
  DESTINATION_KINDS_DEF.find(d => d.kind === kind);

/** Fields that are stored but never sent back to a browser. */
export const secretFieldsOf = (kind: string): string[] =>
  (kindDef(kind)?.fields ?? []).filter(f => f.type === 'password' || f.type === 'textarea').map(f => f.key);

export type BackupDestination = {
  id: number;
  kind: DestinationKind;
  name: string;
  enabled: boolean;
  /** Secrets are replaced with null on the way out; a stored one shows as `hasSecret`. */
  config: Record<string, unknown>;
  hasSecret: boolean;
  lastResult: 'success' | 'failed' | null;
  lastAttemptAt: string | null;
  lastMessage: string | null;
  pending: number;
};

/** A short description of where a destination actually points, for the list. */
export function describeDestination(d: Pick<BackupDestination, 'kind' | 'config'>): string {
  const c = d.config ?? {};
  switch (d.kind) {
    case 'folder':
    case 'network':
      return String(c.path ?? '—');
    case 's3': {
      const where = [c.bucket, c.prefix].filter(Boolean).join('/');
      return `${where} at ${String(c.endpoint ?? '')}`.trim();
    }
    case 'webdav':
      return String(c.url ?? '—');
    case 'google_drive':
      return c.folderName ? `Drive folder "${c.folderName}"` : (c.folderId ? `Drive folder ${c.folderId}` : 'Google Drive');
    default:
      return '—';
  }
}

/**
 * What is missing before a destination can be saved. Returns field labels rather
 * than keys, because the message goes straight to the person filling the form.
 */
export function missingFields(kind: string, config: Record<string, unknown>, hasStoredSecret = false): string[] {
  const def = kindDef(kind);
  if (!def) return ['a known destination type'];
  return def.fields
    .filter(f => f.required)
    .filter(f => {
      const value = String(config[f.key] ?? '').trim();
      if (value) return false;
      // A secret already on file does not have to be retyped to save an edit.
      return !(hasStoredSecret && (f.type === 'password' || f.type === 'textarea'));
    })
    .map(f => f.label);
}
