/**
 * Settings for this browser: where SECHLIMS is, whether this browser is
 * enrolled, and which sites the filler may show itself on.
 *
 * Site permission is asked for here rather than assumed at install, so the
 * extension can see a page only where somebody has said it may.
 */
const $ = id => document.getElementById(id);

const ask = (type, payload) => new Promise(resolve => {
  chrome.runtime.sendMessage({ type, payload }, response => {
    if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
    resolve(response || { ok: false, error: 'No answer from the extension.' });
  });
});

function say(message, kind = 'error') {
  $('error').classList.toggle('hidden', kind !== 'error' || !message);
  $('notice').classList.toggle('hidden', kind !== 'notice' || !message);
  if (kind === 'error') $('error').textContent = message || '';
  else $('notice').textContent = message || '';
}

const ALL_SITES = ['http://*/*', 'https://*/*'];
let state = null;

async function paint() {
  const response = await ask('state');
  if (!response.ok) { say(response.error); return; }
  state = response.data;

  $('host').value = state.host || '';
  $('device-state').textContent = state.enrolled ? 'Enrolled' : 'Not enrolled';
  $('device-state').className = `chip ${state.enrolled ? 'ok' : 'warn'}`;
  $('bubble-state').textContent = state.bubbleEnabled ? 'On' : 'Off';
  $('bubble-state').className = `chip ${state.bubbleEnabled ? 'ok' : 'warn'}`;
  $('toggle-bubble').textContent = state.bubbleEnabled ? 'Turn the bubble off' : 'Turn the bubble on';
  $('sites').textContent = state.sites?.length ? state.sites.join(', ') : 'none';
  $('packaged').textContent = state.packagedHost ? `Packaged for ${state.packagedHost}` : '';
  $('allow-sechlims').disabled = !state.host;
}

$('save-host').addEventListener('click', async () => {
  say('');
  const response = await ask('setHost', { host: $('host').value });
  if (!response.ok) { say(response.error); return; }
  say('Address saved.', 'notice');
  await paint();
});

$('enrol').addEventListener('click', async () => {
  say('');
  const response = await ask('enrol', { pairingCode: $('pairing').value.trim() });
  if (!response.ok) { say(response.error); return; }
  $('pairing').value = '';
  say(response.data.note || 'This browser is enrolled.', 'notice');
  await paint();
});

async function allow(origins) {
  say('');
  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) { say('Permission was not given, so the filler will not appear there.'); return; }
    say('Allowed. Reload any open result form to see the bubble.', 'notice');
    await paint();
  } catch (error) {
    say(`That site could not be allowed: ${error.message}`);
  }
}

$('allow-sechlims').addEventListener('click', () => {
  if (!state?.host) return;
  try { allow([`${new URL(state.host).origin}/*`]); } catch { say('That SECHLIMS address cannot be read as a web address.'); }
});

$('allow-all').addEventListener('click', () => allow(ALL_SITES));

$('allow-site').addEventListener('click', () => {
  const raw = $('site').value.trim();
  if (!raw) { say('Type the address of the site first.'); return; }
  try { void allow([`${new URL(raw).origin}/*`]); $('site').value = ''; }
  catch { say('That is not a web address this browser recognises.'); }
});

$('clear-sites').addEventListener('click', async () => {
  const held = await chrome.permissions.getAll();
  const origins = (held.origins || []).filter(origin => /^https?:/.test(origin));
  if (!origins.length) { say('There are no allowed sites to remove.'); return; }
  await chrome.permissions.remove({ origins });
  say('Removed. The bubble will not appear until a site is allowed again.', 'notice');
  await paint();
});

$('toggle-bubble').addEventListener('click', async () => {
  const response = await ask('setBubbleEnabled', { enabled: !state?.bubbleEnabled });
  if (!response.ok) { say(response.error); return; }
  await paint();
});

void paint();
