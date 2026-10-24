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
  $('page').classList.remove('hidden');
  $('packaged').textContent = state.host ? new URL(state.host).host : 'SECHLIMS';

  if (!state.host) say('Set the SECHLIMS address in Settings before enrolling this browser.');
  await paintPage();
}

/**
 * Why the bubble is, or is not, on the page in front of you.
 *
 * The extension used to answer that question with silence: no bubble, no
 * reason, nothing to act on. It now walks the same steps the bubble does and
 * shows where the chain breaks, with the one button that would mend it.
 */
let fixAction = null;

async function paintPage() {
  const tab = await activeTab();
  const response = await ask('diagnose', { url: tab?.url || '', tabId: tab?.id ?? null });
  const list = $('steps');
  const fix = $('fix');

  if (!response.ok) {
    list.innerHTML = `<li class="bad"><span class="mark">!</span><span><strong>Could not check this page</strong><small>${escapeHtml(response.error)}</small></span></li>`;
    fix.classList.add('hidden');
    return;
  }

  const steps = response.data.steps || [];
  list.innerHTML = steps.map(step => `
    <li class="${step.ok ? 'good' : 'bad'}">
      <span class="mark">${step.ok ? '✓' : '!'}</span>
      <span><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.detail || '')}</small></span>
    </li>`).join('');

  const broken = steps.find(step => !step.ok && step.fix);
  fixAction = broken?.fix ?? null;
  const labels = {
    allow: 'Show the filler on this site',
    inject: 'Show the filler on this page now',
    settings: 'Open settings',
    enrol: 'Enter a pairing code',
    signin: 'Sign in',
    teach: 'Teach this form',
  };
  if (fixAction && labels[fixAction]) {
    fix.textContent = labels[fixAction];
    fix.classList.remove('hidden');
  } else {
    fix.classList.add('hidden');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Allow this site, then put the bubble on the tab without waiting for a reload. */
async function allowThisSite() {
  const tab = await activeTab();
  const origin = tab ? originOf(tab.url) : null;
  if (!origin) { say('The filler works on http and https pages.'); return; }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { say('The filler cannot appear on a site it has not been allowed on.'); return; }
  await ask('register');
  const shown = await ask('showHere', { tabId: tab.id });
  say(shown.ok ? 'Allowed. The bubble is on this page now.' : `Allowed, but: ${shown.error}`, shown.ok ? 'notice' : 'error');
  await paint();
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

$('fix').addEventListener('click', async () => {
  say('');
  if (fixAction === 'allow') { await allowThisSite(); return; }
  if (fixAction === 'inject') {
    const tab = await activeTab();
    const shown = await ask('showHere', { tabId: tab?.id ?? null });
    if (!shown.ok) { say(shown.error); return; }
    say('The filler is on this page.', 'notice');
    await paintPage();
    return;
  }
  if (fixAction === 'settings' || fixAction === 'enrol' || fixAction === 'signin') {
    if (fixAction === 'settings') { chrome.runtime.openOptionsPage(); return; }
    $(fixAction === 'enrol' ? 'pairing' : 'username')?.focus();
    return;
  }
  if (fixAction === 'teach') { $('capture').click(); }
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
