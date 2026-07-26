import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initNativeShell } from './native';
import './mobile.css';

// Theme the native status bar and dismiss the splash once mounted (no-op in PWA).
void initNativeShell();

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
