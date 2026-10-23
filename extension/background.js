/**
 * The extension's one privileged part: it talks to SECHLIMS, holds the
 * credentials, and decides which pages the bubble appears on.
 *
 * Nothing in the page ever sees a token. The bubble that laboratory staff
 * actually use runs in the page and asks this worker for everything —
 * verification, a fill plan, the outcome — so a hostile page can read nothing
 * out of the extension but the answers to the questions it was going to be
 * shown anyway.
 *
 * Two credentials, as SECHLIMS issues them. The DEVICE token says this browser
 * was enrolled by an administrator; the SESSION token says who is signed in.
 * Both are withdrawable from SECHLIMS, and a refusal says which one failed.
 */
import { DEFAULT_HOST } from './config.js';

const STORE = chrome.storage.local;
const CONTENT_SCRIPT_ID = 'sechlims-result-filler-bubble';
/** How long the form register is trusted before it is asked for again. */
const CONTEXT_TTL_MS = 5 * 60 * 1000;

let contextCache = { at: 0, adapters: [] };

/* ============================================================================
   Settings
   ========================================================================= */
async function settings() {
  const stored = await STORE.get(['host', 'deviceToken', 'sessionToken', 'user', 'bubbleEnabled']);
  return {
    host: (stored.host || DEFAULT_HOST || '').replace(/\/+$/, ''),
    deviceToken: stored.deviceToken || '',
    sessionToken: stored.sessionToken || '',
    user: stored.user || null,
    bubbleEnabled: stored.bubbleEnabled !== false,
  };
}

const save = (values) => STORE.set(values);

/* ============================================================================
   Talking to SECHLIMS
   ========================================================================= */
async function call(path, { method = 'GET', body, auth = true } = {}) {
  const { host, deviceToken, sessionToken } = await settings();
  if (!host) throw Object.assign(new Error('No SECHLIMS address is set. Open the extension options.'), { code: 'no_host' });

  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    if (!deviceToken) throw Object.assign(new Error('This browser is not enrolled. Enter a pairing code in the options.'), { code: 'device_missing' });
    headers['x-sechlims-device'] = deviceToken;
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  }

  let response;
  try {
    response = await fetch(`${host}/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (error) {
    throw Object.assign(new Error(`SECHLIMS could not be reached at ${host}.`), { code: 'unreachable', cause: error });
  }

  const payload = await response.json().catch(() => null);
  if (response.status === 401 && payload?.code !== 'device_missing' && payload?.code !== 'device_unknown') {
    // The person's session, not the browser's enrolment.
    await save({ sessionToken: '', user: null });
    throw Object.assign(new Error('Your SECHLIMS session has ended. Sign in again.'), { code: 'signed_out' });
  }
  if (!response.ok) {
    throw Object.assign(new Error(payload?.error || `SECHLIMS refused the request (${response.status}).`), {
      code: payload?.code || 'refused', status: response.status, payload,
    });
  }
  return payload;
}

/* ============================================================================
   Which pages carry a form
   ========================================================================= */
function urlMatches(pattern, mode, url) {
  const target = String(url || '');
  const raw = String(pattern || '').trim();
  if (!raw) return false;
  if (mode === 'exact') return target === raw;
  if (mode === 'contains') return target.toLowerCase().includes(raw.toLowerCase());
  if (mode === 'glob') {
    const escaped = raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try { return new RegExp(`^${escaped}$`, 'i').test(target); } catch { return false; }
  }
  try { return new RegExp(raw, 'i').test(target); } catch { return false; }
}

async function adapters({ force = false } = {}) {
  if (!force && contextCache.adapters.length && Date.now() - contextCache.at < CONTEXT_TTL_MS) {
    return contextCache.adapters;
  }
  const context = await call('/result-filler/context');
  contextCache = { at: Date.now(), adapters: context.adapters || [] };
  return contextCache.adapters;
}

/** The form this page is, or nothing. The page's own marker decides it, not the address. */
async function adapterFor(url) {
  const list = await adapters().catch(() => []);
  const candidates = list.filter(a => a.isActive && urlMatches(a.urlPattern, a.urlMatchMode, url));
  return candidates;
}

/* ============================================================================
   Where the bubble is allowed to appear
   ----------------------------------------------------------------------------
   Registered against the origins an administrator has granted, and re-registered
   whenever that changes. The extension asks for nothing it has not been given:
   on a site with no permission there is no bubble and no script.
   ========================================================================= */
async function grantedOrigins() {
  const held = await chrome.permissions.getAll();
  return (held.origins || []).filter(origin => /^https?:/.test(origin));
}

async function registerBubble() {
  const origins = await grantedOrigins();
  const { bubbleEnabled } = await settings();
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch { /* not registered yet */ }
  if (!origins.length || !bubbleEnabled) return { registered: 0 };
  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: origins,
    js: ['bubble.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
  return { registered: origins.length };
}

chrome.runtime.onInstalled.addListener(() => { void registerBubble(); });
chrome.runtime.onStartup.addListener(() => { void registerBubble(); });
chrome.permissions.onAdded.addListener(() => { void registerBubble(); });
chrome.permissions.onRemoved.addListener(() => { void registerBubble(); });

/* ============================================================================
   What the bubble and the popup may ask for
   ========================================================================= */
const handlers = {
  async state() {
    const { host, deviceToken, sessionToken, user, bubbleEnabled } = await settings();
    const origins = await grantedOrigins();
    return {
      host,
      enrolled: Boolean(deviceToken),
      signedIn: Boolean(sessionToken),
      user,
      bubbleEnabled,
      sites: origins,
      packagedHost: DEFAULT_HOST,
    };
  },

  async setHost({ host }) {
    const cleaned = String(host || '').trim().replace(/\/+$/, '');
    await save({ host: cleaned });
    contextCache = { at: 0, adapters: [] };
    return { host: cleaned };
  },

  async setBubbleEnabled({ enabled }) {
    await save({ bubbleEnabled: Boolean(enabled) });
    await registerBubble();
    return { enabled: Boolean(enabled) };
  },

  async enrol({ pairingCode }) {
    const { host } = await settings();
    if (!host) throw Object.assign(new Error('Set the SECHLIMS address first.'), { code: 'no_host' });
    const response = await fetch(`${host}/api/result-filler/enrol`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response || !response.ok) throw new Error(payload?.error || `SECHLIMS could not be reached at ${host}.`);
    await save({ deviceToken: payload.token, device: payload.device });
    return payload;
  },

  async signIn({ username, password }) {
    const { host } = await settings();
    if (!host) throw Object.assign(new Error('Set the SECHLIMS address first.'), { code: 'no_host' });
    const response = await fetch(`${host}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (!response || !response.ok) throw new Error(payload?.error || 'That username and password were not accepted.');
    await save({ sessionToken: payload.token, user: payload.user });
    contextCache = { at: 0, adapters: [] };
    return { user: payload.user };
  },

  async signOut() {
    await save({ sessionToken: '', user: null });
    contextCache = { at: 0, adapters: [] };
    return { ok: true };
  },

  async adapters({ url, force }) {
    const list = await adapters({ force });
    return { adapters: list, matched: url ? await adapterFor(url) : [] };
  },

  async verify(payload) {
    return call('/result-filler/verify', { method: 'POST', body: payload });
  },

  async populate(payload) {
    return call('/result-filler/populate', { method: 'POST', body: payload });
  },

  async outcome(payload) {
    return call('/result-filler/outcome', { method: 'POST', body: payload });
  },

  async captured(payload) {
    return call('/result-filler/captured', { method: 'POST', body: payload });
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) { sendResponse({ ok: false, error: `Unknown request: ${message?.type}` }); return false; }
  handler(message.payload || message || {})
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error), code: error?.code || null }));
  return true; // the answer comes later
});

export { registerBubble };
