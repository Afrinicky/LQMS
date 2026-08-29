import { useEffect, useState } from 'react';
import { api } from '../services/api';

/**
 * Has the signed-in person a signature on file?
 *
 * Nothing in this system may be signed without one — the server refuses, at the
 * single point every signature passes through. This hook lets a screen say so
 * BEFORE somebody fills in a verification form and presses the button, which is
 * the difference between a rule and an ambush.
 *
 * `null` while it is still being read, so a screen can avoid flashing "you
 * cannot sign" at somebody who can.
 */
export function useSignatureOnFile(): { hasSignature: boolean | null; reload: () => void } {
  const [hasSignature, setHasSignature] = useState<boolean | null>(null);
  const [stamp, setStamp] = useState(0);

  useEffect(() => {
    let live = true;
    api<{ hasSignature: boolean }>('/signatures/me')
      .then(r => { if (live) setHasSignature(Boolean(r.hasSignature)); })
      .catch(() => { if (live) setHasSignature(false); });
    return () => { live = false; };
  }, [stamp]);

  return { hasSignature, reload: () => setStamp(n => n + 1) };
}

/** What to tell somebody who has none. Kept identical to the server's wording. */
export const NO_SIGNATURE_HINT =
  'You have no signature on file, so you cannot sign this. Add one under My Portal → My Record → Replace signature '
  + '(or ask Personnel Management to upload it for you), then sign again.';
