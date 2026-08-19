import { API_BASE, getToken } from './api';

/**
 * Opening a stored file the way its own application would.
 *
 * The old helpers fetched the bytes and pushed the blob URL into a new tab.
 * That is right for a PDF or an image, which the browser renders, and wrong for
 * a Word or Excel file, which it cannot: the tab either downloaded a file with
 * a machine-generated name and no extension — so nothing on the machine knew
 * what to open it with — or silently did nothing at all.
 *
 * So: anything the browser renders is shown; anything Office owns is delivered
 * as a real, correctly named file, which is what makes a double-click land in
 * Word rather than in a text editor.
 *
 * Controlled documents do not come through here — they have a version to save
 * back to, and get the full Office handoff instead (components/OfficeHandoff).
 */
const BROWSER_RENDERS = /^(application\/pdf|image\/|text\/plain|text\/html)/;

export async function openStoredFile(fileId: number, fileName?: string | null, mime?: string | null): Promise<void> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/files/${fileId}/raw`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  const blob = await res.blob();
  const type = mime || blob.type || '';
  const name = fileName || `document-${fileId}`;
  const url = URL.createObjectURL(blob);

  if (BROWSER_RENDERS.test(type) || /\.(pdf|png|jpe?g|gif|webp|svg|txt)$/i.test(name)) {
    window.open(url, '_blank');
  } else {
    // Hand it over as a named file so the operating system opens it with the
    // application that owns the extension.
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
