import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyTheme, storedTheme } from './hooks/useTheme';

declare global {
  interface Window { __SECH_LIMS_RENDERER_STARTED__?: boolean }
}

// The reader's theme is on the document before React paints.
applyTheme(storedTheme());

console.log('[renderer] main.tsx loaded');
window.__SECH_LIMS_RENDERER_STARTED__ = true;

const root = document.getElementById('root');
console.log('[renderer] root element found?', Boolean(root));

if (!root) {
  document.body.innerHTML = `
    <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:var(--boot-text);background:var(--boot-bg);min-height:100vh;">
      <h1 style="margin:0 0 12px;">SECH_LIMS by Nickland</h1>
      <p style="color:#CE3A3A;font-weight:600;">Startup error: #root element is missing from index.html.</p>
      <p style="color:var(--boot-muted);">This is an installer/packaging defect. Reinstall the application, or contact support.</p>
    </div>`;
} else {
  try {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>
    );
    console.log('[renderer] React root render() invoked');
  } catch (err) {
    console.error('[renderer] React root render() threw', err);
    root.innerHTML = `
      <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:var(--boot-text);background:var(--boot-bg);min-height:100vh;">
        <h1 style="margin:0 0 12px;">SECH_LIMS by Nickland</h1>
        <p style="color:#CE3A3A;font-weight:600;">React failed to mount.</p>
        <pre style="background:var(--boot-panel);border-radius:8px;padding:16px;white-space:pre-wrap;color:var(--boot-muted);">${String(err)}</pre>
        <p style="color:var(--boot-muted);">Open View &rarr; Toggle Developer Tools and check the Console tab for the full stack trace.</p>
      </div>`;
  }
}

window.addEventListener('error', (e) => {
  console.error('[renderer] window.onerror', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandledrejection', e.reason);
});

// Register the PWA service worker for browser and mobile clients so the app is
// installable and its shell loads offline. Skipped inside the Electron host
// window (window.sechLims is injected by the preload there) and in dev, where it
// would conflict with Vite HMR. The worker never caches /api — data stays live.
if (
  import.meta.env.PROD &&
  'serviceWorker' in navigator &&
  !window.sechLims &&
  typeof location !== 'undefined' &&
  /^https?:$/.test(location.protocol)
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] service worker registration failed', err);
    });
  });
}
