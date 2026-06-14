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
    <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#F5F8FF;background:#080D1A;min-height:100vh;">
      <h1 style="color:#F5F8FF;margin:0 0 12px;">SECH_LIMS by Nickland</h1>
      <p style="color:#FF6B7D;font-weight:600;">Startup error: #root element is missing from index.html.</p>
      <p style="color:#A8B3C7;">This is an installer/packaging defect. Reinstall the application, or contact support.</p>
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
      <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;color:#F5F8FF;background:#080D1A;min-height:100vh;">
        <h1 style="color:#F5F8FF;margin:0 0 12px;">SECH_LIMS by Nickland</h1>
        <p style="color:#FF6B7D;font-weight:600;">React failed to mount.</p>
        <pre style="background:#122038;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;white-space:pre-wrap;color:#A8B3C7;">${String(err)}</pre>
        <p style="color:#A8B3C7;">Open View &rarr; Toggle Developer Tools and check the Console tab for the full stack trace.</p>
      </div>`;
  }
}

window.addEventListener('error', (e) => {
  console.error('[renderer] window.onerror', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[renderer] unhandledrejection', e.reason);
});
