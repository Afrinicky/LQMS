import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

declare global {
  interface Window { __SECH_LIMS_RENDERER_STARTED__?: boolean }
}

console.log('[renderer] main.tsx loaded');
window.__SECH_LIMS_RENDERER_STARTED__ = true;

const root = document.getElementById('root');
console.log('[renderer] root element found?', Boolean(root));

if (!root) {
  document.body.innerHTML = `
    <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#F6F8FC;min-height:100vh;">
      <h1 style="color:#1B3A6B;margin:0 0 12px;">SECH_LIMS by Nickland</h1>
      <p style="color:#DC2626;font-weight:600;">Startup error: #root element is missing from index.html.</p>
      <p style="color:#5F6F89;">This is an installer/packaging defect. Reinstall the application, or contact support.</p>
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
      <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#F6F8FC;min-height:100vh;">
        <h1 style="color:#1B3A6B;margin:0 0 12px;">SECH_LIMS by Nickland</h1>
        <p style="color:#DC2626;font-weight:600;">React failed to mount.</p>
        <pre style="background:#fff;border:1px solid #DDE3F0;border-radius:8px;padding:16px;white-space:pre-wrap;color:#172033;">${String(err)}</pre>
        <p style="color:#5F6F89;">Open View &rarr; Toggle Developer Tools and check the Console tab for the full stack trace.</p>
      </div>`;
  }
}

window.addEventListener('error', (e) => {
  console.error('[renderer] window.onerror', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandledrejection', e.reason);
});
