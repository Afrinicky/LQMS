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

let contextCache = { at: 0, adapters: [], detection: null };

/* ============================================================================
   Settings
   ========================================================================= */
async function settings() {
  const stored = await STORE.get(['host', 'deviceToken', 'sessionToken', 'user', 'bubbleEnabled', 'registration']);
  return {
    host: (stored.host || DEFAULT_HOST || '').replace(/\/+$/, ''),
    deviceToken: stored.deviceToken || '',
    sessionToken: stored.sessionToken || '',
    user: stored.user || null,
    bubbleEnabled: stored.bubbleEnabled !== false,
    registration: stored.registration || null,
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
  contextCache = {
    at: Date.now(),
    adapters: context.adapters || [],
    // How to recognise an identifier, as SECHLIMS defines it. Without this the
    // page scans with nothing to recognise anything BY, and finds no barcode
    // on a page that prints one in bold.
    detection: context.detection || null,
  };
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

/** Does an allowed origin cover this address? */
function originCovers(origin, url) {
  try {
    const pattern = String(origin).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${pattern}$`).test(url);
  } catch { return false; }
}

/**
 * Put the bubble on the sites it is allowed on.
 *
 * Registration FAILING used to be indistinguishable from the bubble simply not
 * being wanted: the call was fired and forgotten, and a browser that refused
 * the match pattern left no trace anywhere a person could look. The outcome is
 * now kept, and the popup reports it.
 */
async function registerBubble() {
  const origins = await grantedOrigins();
  const { bubbleEnabled } = await settings();
  try { await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }); } catch { /* not registered yet */ }

  if (!origins.length || !bubbleEnabled) {
    await save({ registration: { at: Date.now(), origins: [], error: null } });
    return { registered: 0 };
  }
  try {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      matches: origins,
      js: ['bubble.js'],
      runAt: 'document_idle',
      allFrames: false,
      persistAcrossSessions: true,
    }]);
    await save({ registration: { at: Date.now(), origins, error: null } });
    return { registered: origins.length };
  } catch (error) {
    await save({ registration: { at: Date.now(), origins, error: error?.message || String(error) } });
    return { registered: 0, error: error?.message || String(error) };
  }
}

/**
 * Put the bubble on a page that is already open.
 *
 * A content script registered now does not appear in a tab loaded a minute
 * ago — the browser injects it on the next navigation — so granting a site and
 * seeing nothing happen is the expected behaviour and the most confusing
 * possible one. Injecting into the open tab closes that gap.
 */
async function injectInto(tabId) {
  if (!tabId) return { injected: false, reason: 'no tab' };
  // Already there but keeping quiet, because the page is not one it knows:
  // ask it to show itself. Injecting again would do nothing at all.
  try {
    const answer = await chrome.tabs.sendMessage(tabId, { type: 'rf-show' });
    if (answer?.ok) return { injected: true, reason: 'asked the filler already on the page to show itself' };
  } catch { /* not there yet — inject it below */ }
  try {
    // Marked as deliberate, so the bubble shows itself and says what it found
    // even on a page no form is configured for — which is the page somebody
    // asking "why is it not here?" is most likely to be standing on.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.__sechlimsShowAnyway = true; },
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['bubble.js'] });
    return { injected: true };
  } catch (error) {
    return { injected: false, reason: error?.message || String(error) };
  }
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
    const { host, deviceToken, sessionToken, user, bubbleEnabled, registration } = await settings();
    const origins = await grantedOrigins();
    return {
      host,
      enrolled: Boolean(deviceToken),
      signedIn: Boolean(sessionToken),
      user,
      bubbleEnabled,
      sites: origins,
      registration,
      packagedHost: DEFAULT_HOST,
    };
  },

  async setHost({ host }) {
    const cleaned = String(host || '').trim().replace(/\/+$/, '');
    await save({ host: cleaned });
    contextCache = { at: 0, adapters: [], detection: null };
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
    contextCache = { at: 0, adapters: [], detection: null };
    // What the bubble can do has changed, so make sure it is registered.
    await registerBubble();
    return { user: payload.user };
  },

  async signOut() {
    await save({ sessionToken: '', user: null });
    contextCache = { at: 0, adapters: [], detection: null };
    return { ok: true };
  },

  async adapters({ url, force }) {
    const list = await adapters({ force });
    return { adapters: list, matched: url ? await adapterFor(url) : [], detection: contextCache.detection };
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

  /**
   * Why is there no bubble on this page?
   *
   * Asked by the popup, answered in the order the answers actually matter. Each
   * step either passes or returns the one thing that would fix it — because "it
   * does not appear" is not a fault anybody can act on, and until now it was
   * all the extension would say.
   */
  async diagnose({ url, tabId }) {
    const { host, deviceToken, sessionToken, bubbleEnabled, registration } = await settings();
    const steps = [];
    const step = (key, label, ok, detail, fix) => { steps.push({ key, label, ok, detail, fix }); return ok; };

    const address = String(url || '');
    const web = /^https?:/.test(address);
    step('page', 'This page can carry the filler', web,
      web ? address.split('?')[0] : 'The filler works on http and https pages only.', null);

    step('host', 'A SECHLIMS address is set', Boolean(host), host || 'Not set.', host ? null : 'settings');
    step('device', 'This browser is enrolled', Boolean(deviceToken),
      deviceToken ? 'Enrolled.' : 'No pairing code has been entered.', deviceToken ? null : 'enrol');
    step('signin', 'Somebody is signed in', Boolean(sessionToken),
      sessionToken ? 'Signed in.' : 'Sign in to read pending results.', sessionToken ? null : 'signin');
    step('enabled', 'The bubble is turned on', bubbleEnabled,
      bubbleEnabled ? 'On.' : 'Turned off in Settings.', bubbleEnabled ? null : 'settings');

    const origins = await grantedOrigins();
    const allowed = web && origins.some(origin => originCovers(origin, address));
    step('site', 'This site is allowed', allowed,
      allowed ? 'Allowed.' : 'The filler can only see a site it has been allowed on.', allowed ? null : 'allow');

    if (registration?.error) {
      step('registered', 'The browser accepted the registration', false, registration.error, 'allow');
    }

    let forms = [];
    let matched = [];
    let reachable = true;
    try {
      forms = await adapters({ force: true });
      matched = forms.filter(a => a.isActive && urlMatches(a.urlPattern, a.urlMatchMode, address));
    } catch (error) {
      reachable = false;
      step('reach', 'SECHLIMS answered', false, error?.message || String(error), 'settings');
    }
    if (reachable) {
      step('reach', 'SECHLIMS answered', true, `${forms.length} form(s) configured.`, null);
      step('form', 'A form is configured for this page', matched.length > 0,
        matched.length ? matched.map(a => a.name).join(', ')
          : 'No active form adapter matches this address. Teach this form, or add one in SECHLIMS.',
        matched.length ? null : 'teach');
    }

    let running = false;
    let reading = null;
    if (tabId) {
      try {
        reading = await chrome.tabs.sendMessage(tabId, { type: 'rf-state' });
        running = Boolean(reading?.ok);
      } catch { running = false; }
    }
    step('running', 'The filler is running on this tab', running,
      running ? 'Running.' : 'Not on this tab yet — it loads on the next visit, or show it now.',
      running ? null : 'inject');

    // What it made of the page, which is the answer somebody actually wants
    // when they ask why nothing is being offered.
    if (reading?.ok) {
      const read = reading.state || {};
      step('read', 'It can read this page',
        Boolean(read.identifier) && read.fields > 0,
        read.identifier
          ? `${read.identifierLabel || 'Sample'} ${read.identifier} · ${read.fields} result field(s)${read.status ? ` · ${read.status}` : ''}`
          : `${read.fields || 0} result field(s), but nothing on the page identifies the sample.`,
        null);
    }

    return { steps, ok: steps.every(s => s.ok), matched: matched.map(a => ({ code: a.adapterCode, name: a.name })) };
  },

  /** Put the bubble on the tab in front of the person, now. */
  async showHere({ tabId }) {
    const outcome = await injectInto(tabId);
    if (!outcome.injected && outcome.reason !== 'already running') {
      throw new Error(`The filler could not be shown on this page: ${outcome.reason}`);
    }
    return outcome;
  },

  async register() {
    return registerBubble();
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
