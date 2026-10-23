/**
 * The toolbar panel.
 *
 * The bubble on the form is where the work happens; this is the housekeeping
 * behind it — which SECHLIMS, which browser, who is signed in, and whether the
 * filler is allowed to show itself on the site in front of you. It is also
 * where an administrator starts teaching the extension a form it does not know.
 */
const $ = id => document.getElementById(id);

const ask = (type, payload) => new Promise(resolve => {
  chrome.runtime.sendMessage({ type, payload }, response => {
    if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
    resolve(response || { ok: false, error: 'No answer from the extension.' });
  });
});

function say(message, kind = 'error') {
  const error = $('error');
  const notice = $('notice');
  error.classList.toggle('hidden', kind !== 'error' || !message);
  notice.classList.toggle('hidden', kind !== 'notice' || !message);
  if (kind === 'error') error.textContent = message || '';
  else notice.textContent = message || '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.origin}/*` : null;
  } catch { return null; }
}

let state = null;

async function paint() {
  const response = await ask('state');
  if (!response.ok) { say(response.error); return; }
  state = response.data;

  $('host-line').textContent = state.host || 'No address set';
  $('state-host').textContent = state.host || '—';

  const device = $('state-device');
  device.textContent = state.enrolled ? 'Enrolled' : 'Not enrolled';
  device.className = `chip ${state.enrolled ? 'ok' : 'warn'}`;

  const user = $('state-user');
  user.textContent = state.signedIn ? (state.user?.fullName || state.user?.username || 'Yes') : 'No';
  user.className = `chip ${state.signedIn ? 'ok' : 'warn'}`;

  $('enrol').classList.toggle('hidden', state.enrolled || !state.host);
  $('signin').classList.toggle('hidden', !state.enrolled || state.signedIn);
  $('page').classList.toggle('hidden', !state.enrolled || !state.signedIn);
  $('packaged').textContent = state.host ? new URL(state.host).host : 'SECHLIMS';

  if (!state.host) { say('Set the SECHLIMS address in Settings before enrolling this browser.'); return; }
  if (state.enrolled && state.signedIn) await paintPage();
}

async function paintPage() {
  const tab = await activeTab();
  const origin = tab ? originOf(tab.url) : null;
  const granted = origin ? await chrome.permissions.contains({ origins: [origin] }) : false;

  $('allow-site').classList.toggle('hidden', !origin || granted);
  $('allow-site').dataset.origin = origin || '';

  const response = await ask('adapters', { url: tab?.url || '' });
  if (!response.ok) { $('page-form').textContent = '—'; say(response.error); return; }

  const matched = response.data.matched || [];
  $('page-form').textContent = matched.length ? matched[0].name : 'Not a known result form';
  $('page-note').textContent = !origin
    ? 'The filler works on http and https pages.'
    : !granted
      ? 'Allow this site and the bubble appears on its result-entry forms by itself.'
      : matched.length
        ? 'The bubble is on this page, bottom right.'
        : 'Nothing here matches a configured form. Teach it, and an administrator can enable it in SECHLIMS.';
}

/* ============================================================================
   Actions
   ========================================================================= */
$('enrol-go').addEventListener('click', async () => {
  say('');
  const code = $('pairing').value.trim();
  if (!code) { say('Enter the pairing code.'); return; }
  const response = await ask('enrol', { pairingCode: code });
  if (!response.ok) { say(response.error); return; }
  say(response.data.note || 'This browser is enrolled.', 'notice');
  await paint();
});

$('signin-go').addEventListener('click', async () => {
  say('');
  const response = await ask('signIn', { username: $('username').value.trim(), password: $('password').value });
  if (!response.ok) { say(response.error); return; }
  $('password').value = '';
  await paint();
});

$('signout').addEventListener('click', async () => { await ask('signOut'); await paint(); });
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('allow-site').addEventListener('click', async () => {
  const origin = $('allow-site').dataset.origin;
  if (!origin) return;
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { say('The filler cannot appear on a site it has not been allowed on.'); return; }
  const tab = await activeTab();
  if (tab?.id) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['bubble.js'] }); } catch { /* it loads on the next visit */ }
  }
  say('Allowed. The bubble appears on this site’s result forms.', 'notice');
  await paint();
});

/**
 * Teach the extension a form.
 *
 * The capture tool runs in the page, the administrator clicks the sample field
 * and each parameter, and what comes back is saved in SECHLIMS as an INACTIVE
 * draft. Nothing is ever filled from a captured form until somebody has
 * reviewed it.
 */
$('capture').addEventListener('click', async () => {
  say('');
  const tab = await activeTab();
  if (!tab?.id) { say('Open the form in a tab first.'); return; }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
    window.close();
  } catch (error) {
    say(`The capture tool could not be opened on this page: ${error.message}`);
  }
});

void paint();
