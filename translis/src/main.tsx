import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
// The SECHLIMS stylesheet, unchanged. TransLis is the same product's
// middleware standing on its own, and it should look like it.
import '../../src/styles/app.css';

const root = document.getElementById('root');

if (!root) {
  document.body.innerHTML = `
    <div style="padding:48px;font-family:Inter,Segoe UI,Arial,sans-serif;">
      <h1 style="margin:0 0 12px;">TransLis</h1>
      <p style="color:#CE3A3A;font-weight:600;">Startup error: the #root element is missing.</p>
      <p>This is a packaging defect. Reinstall the application.</p>
    </div>`;
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
