import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initNativeShell } from './native';
import { initInstallCapture } from './install';
import './mobile.css';

// Last-resort visible error surface. A native WebView has no address bar and no
// error page, so an uncaught exception at startup otherwise leaves a blank
// screen that reads as "the app just closed". This renders the actual error so
// it can be seen and reported, and — crucially — always dismisses the native
// splash screen so the app can never appear stuck behind it.
function showFatal(context: string, err: unknown) {
  try { (window as any).Capacitor?.Plugins?.SplashScreen?.hide?.(); } catch { /* no splash */ }
  const message = err instanceof Error ? (err.stack || err.message) : String(err);
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = '';
  const box = document.createElement('div');
  box.setAttribute('style', 'padding:24px;font:14px/1.5 system-ui,sans-serif;color:#e7eefc;background:#0a1322;min-height:100vh;box-sizing:border-box');
  box.innerHTML =
    '<h2 style="margin:0 0 8px;color:#ff8d9c;font-size:18px">SECH_LIMS Staff couldn’t start</h2>' +
    '<p style="margin:0 0 12px;color:#a8b3c7">Something failed while the app was loading (' + context + '). Please share this with your administrator:</p>' +
    '<pre style="white-space:pre-wrap;word-break:break-word;background:#122038;border:1px solid #22345c;border-radius:8px;padding:12px;color:#dbe6fb;font-size:12px;overflow:auto">' +
    message.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string)) + '</pre>' +
    '<button id="m-reload" style="margin-top:14px;padding:10px 18px;border:0;border-radius:8px;background:#2f6bff;color:#fff;font-weight:600;font-size:14px">Reload</button>';
  root.appendChild(box);
  document.getElementById('m-reload')?.addEventListener('click', () => window.location.reload());
}

// Surface otherwise-silent async failures too (e.g. a rejected native call).
window.addEventListener('error', e => { if (!document.getElementById('root')?.hasChildNodes()) showFatal('runtime error', e.error ?? e.message); });
window.addEventListener('unhandledrejection', e => { if (!document.getElementById('root')?.hasChildNodes()) showFatal('unhandled promise rejection', e.reason); });

try {
  // Capture the PWA install prompt early (before React mounts) so the app can
  // offer its own "Install" button; theme the native status bar / hide splash.
  initInstallCapture();
  void initNativeShell();

  const root = document.getElementById('root');
  if (root) {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  }
} catch (err) {
  showFatal('startup', err);
}
