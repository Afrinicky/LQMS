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
/**
 * The one request in flight, shared.
 *
 * A bench opens six patients at once and six content scripts ask for the form
 * register in the same second. Answering each one separately asks SECHLIMS the
 * same question six times and gives six tabs six chances to fail; they all wait
 * on the same promise instead.
 */
let contextInFlight = null;

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
/**
 * Is the signed-in session still good?
 *
 * Asked before anybody is signed out. `true` the session is live, `false`
 * SECHLIMS says it is gone, `null` SECHLIMS could not be asked — and the
 * third answer is the important one: a blip on the hospital network must not
 * empty the credential every open tab is working from.
 */
async function sessionAlive(token) {
  const { host } = await settings();
  if (!host || !token) return false;
  try {
    const response = await fetch(`${host}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) return false;
    return response.ok ? true : null;
  } catch {
    return null;
  }
}

async function call(path, { method = 'GET', body, auth = true, retried = false } = {}) {
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
    /*
     * The person's session, not the browser's enrolment — but a refusal is not
     * taken at face value, because this credential is shared by every tab the
     * bench has open. One request that raced a restart used to sign the whole
     * browser out, and the bench would be back at the toolbar typing their
     * password in between patients. So SECHLIMS is asked outright whether the
     * session has ended, and only a straight answer ends it.
     */
    const alive = await sessionAlive(sessionToken);
    if (alive === true && !retried) return call(path, { method, body, auth, retried: true });
    if (alive === null) {
      throw Object.assign(new Error(`SECHLIMS could not be reached at ${host}.`), { code: 'unreachable' });
    }
    if (alive === false) {
      await save({ sessionToken: '', user: null });
      void announceSession();
      throw Object.assign(new Error('Your SECHLIMS session has ended. Sign in again.'), { code: 'signed_out' });
    }
    throw Object.assign(new Error('SECHLIMS refused the request.'), { code: 'refused', status: 401, payload });
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
  if (contextInFlight) return contextInFlight;
  contextInFlight = (async () => {
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
  })();
  try {
    return await contextInFlight;
  } finally {
    contextInFlight = null;
  }
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

/* ============================================================================
   The tabs that are already open
   ----------------------------------------------------------------------------
   Everything below exists because a laboratory works in tabs. Staff filter the
   pending list, open six patients into six tabs, and move between them for the
   rest of the hour. A change made once — signing in, allowing the site, turning
   the bubble on — has to reach all of them, and none of it may require a tab to
   be reloaded or a password to be typed again.
   ========================================================================= */

/**
 * The open tabs the extension is allowed to see, by the origins it holds.
 *
 * Asked for by match pattern first. A browser that will not filter on patterns
 * without the blanket tabs permission — which this extension deliberately does
 * not ask for — is asked for the list instead, and it then carries an address
 * only for the tabs the extension already had permission for, which is exactly
 * the set wanted.
 */
async function allowedTabs() {
  const origins = await grantedOrigins();
  if (!origins.length) return [];
  const mine = tab => tab.id && /^https?:/.test(tab.url || '') && origins.some(origin => originCovers(origin, tab.url));
  try {
    const tabs = await chrome.tabs.query({ url: origins });
    return (tabs || []).filter(tab => tab.id && /^https?:/.test(tab.url || ''));
  } catch {
    try {
      const tabs = await chrome.tabs.query({});
      return (tabs || []).filter(mine);
    } catch {
      return [];
    }
  }
}

/** Say the same thing to every tab, and never mind the ones not listening. */
async function broadcast(message) {
  const tabs = await allowedTabs();
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => null)));
}

/**
 * Who is signed in, as the tabs are allowed to know it.
 *
 * A name and a yes or no. No token leaves this worker — a tab shares the
 * session without ever holding it, which is the whole reason the credential
 * lives here and not in the page.
 */
async function announceSession() {
  const { sessionToken, user } = await settings();
  await broadcast({
    type: 'rf-session',
    signedIn: Boolean(sessionToken),
    user: user ? { fullName: user.fullName || user.username || '' } : null,
  });
}

/**
 * Put the bubble on every tab that should have one.
 *
 * A content script registered now reaches the next page load, not the six tabs
 * already open — so allowing the site, signing in, or turning the bubble back
 * on would appear to do nothing until each tab was reloaded.
 */
async function reachOpenTabs() {
  const { bubbleEnabled } = await settings();
  if (!bubbleEnabled) return { reached: 0 };
  const tabs = await allowedTabs();
  let reached = 0;
  for (const tab of tabs) {
    const outcome = await injectInto(tab.id);
    if (outcome.injected) reached++;
  }
  return { reached, tabs: tabs.length };
}

/**
 * Put the bubble on a page that is already open.
 *
 * A content script registered now does not appear in a tab loaded a minute
 * ago — the browser injects it on the next navigation — so granting a site and
 * seeing nothing happen is the expected behaviour and the most confusing
 * possible one. Injecting into the open tab closes that gap.
 */
async function injectInto(tabId, { reveal = false } = {}) {
  if (!tabId) return { injected: false, reason: 'no tab' };
  // Already there: ask it to look at the page again, and to open itself if this
  // was somebody pressing the button. Injecting again would do nothing at all.
  try {
    const answer = await chrome.tabs.sendMessage(tabId, { type: reveal ? 'rf-show' : 'rf-wake' });
    if (answer?.ok) return { injected: true, reason: 'the filler is already on the page' };
  } catch { /* not there yet — inject it below */ }
  try {
    if (reveal) {
      // Marked as deliberate, so the panel opens on the page the person is
      // standing on rather than waiting to be clicked.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.__sechlimsShowAnyway = true; },
      });
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ['bubble.js'] });
    return { injected: true };
  } catch (error) {
    return { injected: false, reason: error?.message || String(error) };
  }
}

/** Register, then catch up the tabs that were open before the change. */
async function registerAndReach() {
  const outcome = await registerBubble();
  await reachOpenTabs();
  return outcome;
}

chrome.runtime.onInstalled.addListener(() => { void registerAndReach(); });
chrome.runtime.onStartup.addListener(() => { void registerBubble(); });
chrome.permissions.onAdded.addListener(() => { void registerAndReach(); });
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
    const on = Boolean(enabled);
    await save({ bubbleEnabled: on });
    await registerBubble();
    // Turned off means gone now, not gone after every tab has been reloaded.
    if (on) await reachOpenTabs();
    else await broadcast({ type: 'rf-hide' });
    return { enabled: on };
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
    // What the bubble can do has changed, so make sure it is registered — and
    // tell the tabs that are already open, so the six patients the bench opened
    // before signing in start working without being reloaded.
    await registerBubble();
    // Waking each tab tells it the session changed; it reads the page again
    // and starts offering results without anybody reloading anything.
    await reachOpenTabs();
    return { user: payload.user };
  },

  async signOut() {
    await save({ sessionToken: '', user: null });
    contextCache = { at: 0, adapters: [], detection: null };
    await announceSession();
    return { ok: true };
  },

  async adapters({ url, force }) {
    const { sessionToken, user, bubbleEnabled } = await settings();
    // Asked for first, so a page that is waiting on a sign-in can say so
    // instead of reporting that SECHLIMS refused it.
    if (!sessionToken) {
      return { adapters: [], matched: [], detection: contextCache.detection, signedIn: false, bubbleEnabled };
    }
    const list = await adapters({ force });
    return {
      adapters: list,
      matched: url ? await adapterFor(url) : [],
      detection: contextCache.detection,
      signedIn: true,
      user: user ? { fullName: user.fullName || user.username || '' } : null,
      bubbleEnabled,
    };
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

  /** Put the bubble on every tab that is already open. */
  async showOnOpenTabs() {
    return reachOpenTabs();
  },

  /** Put the bubble on the tab in front of the person, now. */
  async showHere({ tabId }) {
    const outcome = await injectInto(tabId, { reveal: true });
    if (!outcome.injected && outcome.reason !== 'already running') {
      throw new Error(`The filler could not be shown on this page: ${outcome.reason}`);
    }
    return outcome;
  },

  async register() {
    return registerAndReach();
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) { sendResponse({ ok: false, error: `Unknown request: ${message?.type}` }); return false; }
  handler(message.payload || message || {})
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({
      ok: false,
      error: error?.message || String(error),
      code: error?.code || null,
      // What SECHLIMS said along with the refusal — which parameters it holds
      // and which fields it could not place them in. A refusal nobody can act
      // on is the fault this whole panel exists to prevent.
      detail: error?.payload || null,
    }));
  return true; // the answer comes later
});

export { registerBubble };
