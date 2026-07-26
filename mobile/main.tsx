import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initNativeShell } from './native';
import { initInstallCapture } from './install';
import './mobile.css';

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
