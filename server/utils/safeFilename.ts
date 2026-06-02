import crypto from 'node:crypto';
import path from 'node:path';
export function safeStoredFilename(originalName: string) {
  const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
}
