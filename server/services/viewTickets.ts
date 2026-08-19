/**
 * Short-lived tickets for reading one file inline.
 *
 * The document viewer embeds a PDF in an <iframe>. An iframe cannot carry an
 * Authorization header, so the usual answer is to fetch the bytes and point it
 * at a blob: URL — which works, except that a blob: URL has no filename, so the
 * browser's own PDF toolbar titles an accredited SOP with a bare UUID and
 * offers to save it under that name.
 *
 * A ticket buys a URL that ends in the real filename and carries its own
 * authority. It is minted only for somebody already allowed to read that file,
 * names exactly one file, and expires on its own.
 *
 * Held in memory rather than in the schema deliberately: a view ticket has no
 * value once the reader has closed the document, and a host restart is a
 * perfectly good reason for one to stop working.
 */
import crypto from 'node:crypto';

export const VIEW_TICKET_MS = 30 * 60 * 1000;

type Ticket = { fileId: number; userId: number; expires: number };
const tickets = new Map<string, Ticket>();

function sweep() {
  const now = Date.now();
  for (const [token, t] of tickets) if (t.expires < now) tickets.delete(token);
}

export function mintViewTicket(fileId: number, userId: number): string {
  sweep();
  const token = crypto.randomBytes(18).toString('base64url');
  tickets.set(token, { fileId, userId, expires: Date.now() + VIEW_TICKET_MS });
  return token;
}

export function readViewTicket(token: string): Ticket | null {
  sweep();
  const t = tickets.get(token);
  if (!t || t.expires < Date.now()) return null;
  return t;
}
