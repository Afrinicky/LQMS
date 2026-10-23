/**
 * The Result Filler, as it appears to the bench.
 *
 * A small round bubble in the corner of any result-entry form SECHLIMS knows
 * about. It reads the identifier off the form, asks SECHLIMS whether that
 * identifier is one it holds results for, shows the answer, and — only then —
 * offers one button. Open the form, glance at the bubble, press Populate.
 *
 * It appears on supported pages by itself and stays through navigation, so
 * nobody has to go looking in the browser's toolbar for it.
 *
 * What it will not do is the point of it:
 *   · no identifier, an ambiguous one, or one that contradicts the record —
 *     nothing is filled and the bubble says why;
 *   · a field it cannot find exactly once is never guessed at;
 *   · a box that already has something in it is left alone unless the person
 *     says otherwise;
 *   · and it fills. It does not save, authorise or release anything.
 *
 * Everything privileged happens in the background worker. This script holds no
 * token and sees no credential; it asks questions and renders answers inside a
 * shadow root, so neither the page's styles nor its scripts can reach in.
 */
(() => {
  if (window.__sechlimsResultFillerMounted) return;
  window.__sechlimsResultFillerMounted = true;

  const HOST_ID = 'sechlims-result-filler';
  const POSITION_KEY = 'rf_bubble_position';
  const RECHECK_MS = 1_500;

  /* ==========================================================================
     Talking to the background worker
     ======================================================================= */
  const ask = (type, payload) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type, payload }, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'The extension was reloaded. Refresh this page.' });
          return;
        }
        resolve(response || { ok: false, error: 'No answer from the extension.' });
      });
    } catch {
      resolve({ ok: false, error: 'The extension is not available on this page.' });
    }
  });

  /* ==========================================================================
     Reading the page
     ======================================================================= */
  const norm = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const visible = el => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  const FILLABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), select, textarea';

  function isFillable(el) {
    return Boolean(el) && !el.disabled && !el.readOnly && visible(el);
  }

  function textOf(el) {
    if (!el) return '';
    if ('value' in el && el.tagName !== 'BUTTON') return String(el.value ?? '').trim();
    return String(el.textContent ?? '').trim();
  }

  /** The control a visible label points at. */
  function controlForLabel(labelText) {
    const wanted = norm(labelText);
    if (!wanted) return { element: null, reason: 'no label given' };
    const labels = Array.from(document.querySelectorAll('label'));
    const matches = labels.filter(label => {
      const text = norm(label.textContent);
      return text === wanted || text.startsWith(wanted);
    });
    for (const label of matches) {
      const target = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector(FILLABLE);
      const sibling = target || (label.parentElement ? label.parentElement.querySelector(FILLABLE) : null);
      if (isFillable(sibling)) return { element: sibling, reason: null };
    }
    return { element: null, reason: matches.length ? 'the label was found but no field belongs to it' : 'no label with that text' };
  }

  /**
   * The control in the row whose label cell reads like this parameter.
   *
   * This is what makes a result grid fillable without anybody configuring a
   * selector for every parameter: the row says "Haemoglobin", so the box in
   * that row is the haemoglobin box. A label cell that carries its unit —
   * "Haemoglobin (g/dL)" — still matches, because the comparison is on the
   * parameter rather than on the whole cell.
   */
  function controlInRow(labels, meta) {
    const wanted = labels.map(norm).filter(Boolean);
    if (!wanted.length) return { element: null, reason: 'no row label given' };

    const containers = meta.rowContainer
      ? Array.from(document.querySelectorAll(meta.rowContainer))
      : [document];
    const labelIndex = Math.max(1, Number(meta.rowLabelCell || 1)) - 1;
    const valueIndex = Number(meta.rowValueCell || 0);

    let sawRow = false;
    for (const container of containers) {
      const rows = Array.from(container.querySelectorAll('tr, [role="row"]'));
      for (const row of rows) {
        const cells = Array.from(row.children).filter(cell => /^(TD|TH)$/.test(cell.tagName) || cell.getAttribute('role') === 'cell');
        if (cells.length < 2) continue;
        const labelCell = cells[labelIndex];
        if (!labelCell) continue;
        const cellText = norm(labelCell.textContent);
        if (!cellText) continue;
        const hit = wanted.some(label => cellText === label || cellText.startsWith(label));
        if (!hit) continue;
        sawRow = true;

        const searchOrder = valueIndex > 0 && cells[valueIndex - 1]
          ? [cells[valueIndex - 1]]
          : cells.slice(1).reverse();
        for (const cell of searchOrder) {
          const control = Array.from(cell.querySelectorAll(FILLABLE)).find(isFillable);
          if (control) return { element: control, reason: null };
        }
      }
    }
    return { element: null, reason: sawRow ? 'the row was found but holds no field to fill' : 'no row with that label' };
  }

  /** One field, found exactly once — or not used at all. */
  function resolveControl(spec, meta) {
    const kind = spec.selectorKind || 'row';
    const selector = String(spec.selector || '').trim();
    if (!selector) return { element: null, reason: 'no selector configured' };

    try {
      if (kind === 'css' || kind === 'name' || kind === 'id') {
        const query = kind === 'css' ? selector
          : kind === 'name' ? `[name="${CSS.escape(selector)}"]`
          : `#${CSS.escape(selector)}`;
        const found = Array.from(document.querySelectorAll(query)).filter(isFillable);
        if (found.length === 1) return { element: found[0], reason: null };
        if (found.length > 1) return { element: null, reason: `${found.length} fields match that selector, so none was filled` };
        return { element: null, reason: 'no field matches that selector' };
      }
      if (kind === 'label') return controlForLabel(selector);
      return controlInRow([selector, ...(spec.aliases || [])], meta);
    } catch (error) {
      return { element: null, reason: `that selector could not be read: ${error.message}` };
    }
  }

  /**
   * Put a value in, the way the page's own framework will notice.
   *
   * Assigning to `.value` is invisible to React, Vue and anything else holding
   * its own copy of the field's state: the box shows the number and the form
   * saves what the person last typed. The native setter plus the two events is
   * what makes the framework agree with the screen.
   */
  function setValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    if (element instanceof HTMLSelectElement) {
      const wanted = norm(value);
      const option = Array.from(element.options).find(o => norm(o.value) === wanted || norm(o.textContent) === wanted);
      if (!option) return false;
      element.value = option.value;
    } else if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function flash(element, tone) {
    const previous = element.style.boxShadow;
    element.style.transition = 'box-shadow .25s ease';
    element.style.boxShadow = tone === 'ok' ? '0 0 0 2px #2DB7B2' : '0 0 0 2px #D97706';
    setTimeout(() => { element.style.boxShadow = previous; }, 1400);
  }

  /* ==========================================================================
     The identifier on the form
     ======================================================================= */
  function readIdentifiers(adapter) {
    const out = {};
    for (const spec of adapter.identifiers || []) {
      const found = resolveControl({ selectorKind: spec.selectorKind, selector: spec.selector }, adapter);
      let value = found.element ? textOf(found.element) : '';
      if (!value && spec.selectorKind === 'css') {
        // A form that shows its sample number as text rather than in a box.
        const node = document.querySelector(spec.selector);
        if (node) value = String(node.textContent ?? '').trim();
      }
      if (value) out[spec.kind || 'sample'] = value;
    }
    return out;
  }

  /** Is this page actually the form, or only its address? */
  function formPresent(adapter) {
    const selector = String(adapter.formSelector || '').trim();
    if (!selector) return true;
    try { return Boolean(document.querySelector(selector)); } catch { return false; }
  }

  /* ==========================================================================
     The bubble
     ======================================================================= */
  const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483000; font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif;
  color: #16202E; }
.fab { width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: grab; position: relative;
  display: flex; align-items: center; justify-content: center; color: #fff; touch-action: none;
  background: radial-gradient(circle at 30% 25%, #2A5CA8, #16284B); box-shadow: 0 8px 22px rgba(10, 22, 44, .34);
  transition: transform .12s ease, box-shadow .12s ease; }
.fab:hover { transform: scale(1.06); }
.fab:active { cursor: grabbing; }
.fab .ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,.18); }
.fab .dot { position: absolute; top: 3px; right: 3px; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid #16284B; background: #94A3B8; }
.fab .dot.ok { background: #16A34A; }
.fab .dot.warn { background: #D97706; }
.fab .dot.crit { background: #DC2626; }
.fab .dot.busy { background: #38BDF8; animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

.panel { width: 376px; max-width: 94vw; max-height: 78vh; display: flex; flex-direction: column;
  background: #fff; border: 1px solid #D5DEEC; border-radius: 16px; overflow: hidden;
  box-shadow: 0 18px 46px rgba(10, 22, 44, .28); }
.hd { display: flex; align-items: center; gap: 10px; padding: 11px 12px; cursor: grab; touch-action: none;
  background: linear-gradient(90deg, #16284B, #1B3A6B); color: #EAF1FF; }
.hd:active { cursor: grabbing; }
.hd .av { width: 32px; height: 32px; border-radius: 50%; flex: 0 0 auto; display: flex; align-items: center;
  justify-content: center; background: radial-gradient(circle at 30% 25%, #2A5CA8, #13315F); }
.hd .ti { flex: 1; min-width: 0; line-height: 1.2; }
.hd .ti strong { display: block; font-size: 13px; font-weight: 650; }
.hd .ti small { display: block; font-size: 10.5px; color: #A8BEE2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hd button { background: transparent; border: 0; color: #CFE0FF; cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
.hd button:hover { background: rgba(255,255,255,.14); }

.body { padding: 12px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; background: #F7F9FC; }
.row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.row span { color: #64748B; min-width: 74px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
.row strong { font-weight: 650; word-break: break-word; }
.card { background: #fff; border: 1px solid #E2E8F0; border-radius: 11px; padding: 10px 11px; display: flex;
  flex-direction: column; gap: 7px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px;
  font-size: 10.5px; font-weight: 700; letter-spacing: .02em; background: #EEF2F7; color: #475569; }
.chip.ok { background: #DCFCE7; color: #15803D; }
.chip.warn { background: #FEF3C7; color: #B45309; }
.chip.crit { background: #FEE2E2; color: #B91C1C; }
.chip.idle { background: #EEF2F7; color: #64748B; }
.msg { font-size: 11.5px; line-height: 1.5; color: #475569; margin: 0; }
.msg.crit { color: #B91C1C; }
.msg.warn { color: #B45309; }
.results { list-style: none; margin: 0; padding: 0; max-height: 148px; overflow-y: auto;
  border: 1px solid #E2E8F0; border-radius: 9px; background: #fff; }
.results li { display: flex; justify-content: space-between; gap: 8px; padding: 4px 9px; font-size: 11.5px;
  border-bottom: 1px solid #F1F5F9; }
.results li:last-child { border-bottom: 0; }
.results li b { font-weight: 600; color: #0F172A; }
.results li em { font-style: normal; color: #64748B; font-variant-numeric: tabular-nums; }
.results li .flag { font-weight: 700; margin-left: 4px; }
.results li .flag.alert { color: #B91C1C; }
.results li .flag.quiet { color: #94A3B8; font-weight: 400; }
select.pick { width: 100%; font: inherit; font-size: 11.5px; padding: 5px 7px; border: 1px solid #CBD5E1;
  border-radius: 8px; background: #fff; }
.ft { padding: 10px 12px; border-top: 1px solid #E2E8F0; background: #fff; display: flex; flex-direction: column; gap: 8px; }
.btn { font: inherit; font-size: 12.5px; font-weight: 600; padding: 9px 14px; border-radius: 10px; cursor: pointer;
  border: 1px solid #1B3A6B; background: #1B3A6B; color: #fff; display: flex; align-items: center;
  justify-content: center; gap: 7px; width: 100%; }
.btn:hover:not(:disabled) { background: #16284B; }
.btn:disabled { opacity: .45; cursor: default; }
.btn.ghost { background: #fff; color: #1B3A6B; }
.btn.ghost:hover:not(:disabled) { background: #EEF3FB; }
.btn.warn { background: #B45309; border-color: #B45309; }
.btn.warn:hover:not(:disabled) { background: #92400E; }
.pair { display: flex; gap: 8px; }
.note { font-size: 10.5px; color: #94A3B8; text-align: center; margin: 0; }
.hidden { display: none !important; }
`;

  const ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M10 3v7.5L5.6 18A2.5 2.5 0 0 0 7.8 21h8.4a2.5 2.5 0 0 0 2.2-3L14 10.5V3"/><path d="M7 15h10"/></svg>`;
  const CLOSE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

  /* ==========================================================================
     State
     ======================================================================= */
  const state = {
    adapter: null,
    identifiers: {},
    verdict: null,
    busy: false,
    open: false,
    error: null,
    notice: null,
    chosenId: '',
    held: [],          // fields whose boxes already had something in them
    heldPlan: null,
    lastUrl: location.href,
    lastIdentifier: '',
  };

  let shadow = null;
  let elements = {};

  function mount() {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.all = 'initial';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <button class="fab" title="SECHLIMS Result Filler" part="fab">
        <span class="ring"></span><span class="dot idle"></span>${ICON}
      </button>
      <div class="panel hidden">
        <div class="hd">
          <span class="av">${ICON}</span>
          <span class="ti"><strong>SECHLIMS Result Filler</strong><small class="form-name">Checking this page…</small></span>
          <button class="close" title="Close">${CLOSE}</button>
        </div>
        <div class="body"></div>
        <div class="ft"></div>
      </div>`;

    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    elements = {
      host, wrap,
      fab: wrap.querySelector('.fab'),
      dot: wrap.querySelector('.dot'),
      panel: wrap.querySelector('.panel'),
      header: wrap.querySelector('.hd'),
      formName: wrap.querySelector('.form-name'),
      body: wrap.querySelector('.body'),
      footer: wrap.querySelector('.ft'),
      close: wrap.querySelector('.close'),
    };

    elements.fab.addEventListener('click', event => { if (!dragged) { event.stopPropagation(); toggle(true); } });
    elements.close.addEventListener('click', () => toggle(false));
    draggable(elements.fab);
    draggable(elements.header);
    restorePosition();
  }

  function unmount() {
    document.getElementById(HOST_ID)?.remove();
    shadow = null;
    elements = {};
  }

  /* ---- where it sits, and where the person left it ----------------------- */
  let dragged = false;
  function place(x, y) {
    const wrap = elements.wrap;
    if (!wrap) return;
    const maxX = Math.max(8, window.innerWidth - 80);
    const maxY = Math.max(8, window.innerHeight - 80);
    wrap.style.left = `${Math.min(Math.max(8, x), maxX)}px`;
    wrap.style.top = `${Math.min(Math.max(8, y), maxY)}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  }

  function restorePosition() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); } catch { saved = null; }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) place(saved.x, saved.y);
    else place(window.innerWidth - 84, window.innerHeight - 96);
  }

  function draggable(handle) {
    let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true; dragged = false;
      startX = event.clientX; startY = event.clientY;
      const rect = elements.wrap.getBoundingClientRect();
      originX = rect.left; originY = rect.top;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
      place(originX + dx, originY + dy);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      const rect = elements.wrap.getBoundingClientRect();
      try { localStorage.setItem(POSITION_KEY, JSON.stringify({ x: rect.left, y: rect.top })); } catch { /* private window */ }
      setTimeout(() => { dragged = false; }, 60);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /**
   * Keep whatever is showing inside the window.
   *
   * The bubble lives in a corner, and the panel is twenty times its size: left
   * at the bubble's own position it opens off the bottom of the screen, which
   * is how a tool that works perfectly looks broken.
   */
  function clampIntoView() {
    const wrap = elements.wrap;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8));
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  }

  function toggle(open) {
    state.open = open;
    elements.panel?.classList.toggle('hidden', !open);
    elements.fab?.classList.toggle('hidden', open);
    if (open) {
      void refresh();
      // Measured after the panel is laid out, not guessed at from its CSS.
      requestAnimationFrame(clampIntoView);
    } else {
      restorePosition();
    }
  }

  /* ==========================================================================
     Rendering
     ======================================================================= */
  /**
   * ASTM fills its abnormality field on every result, and on a normal one it
   * says N. Painting that red turns a clean count into a wall of alarms.
   */
  function flagTone(flag) {
    const raw = String(flag ?? '').trim().toUpperCase();
    if (!raw || raw === 'N' || raw === 'NORM' || raw === 'NORMAL' || raw === 'NR') return 'quiet';
    return 'alert';
  }

  const TONES = {
    verified: 'ok', near_match: 'warn', already_entered: 'warn',
    ambiguous: 'crit', no_identifier: 'crit', not_found: 'crit', blocked: 'crit', no_results: 'idle',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function setDot() {
    if (!elements.dot) return;
    const tone = state.busy ? 'busy'
      : state.error ? 'crit'
      : state.verdict ? (TONES[state.verdict.status] || 'idle') : 'idle';
    elements.dot.className = `dot ${tone}`;
  }

  function render() {
    setDot();
    if (!elements.panel || !state.open) return;

    elements.formName.textContent = state.adapter ? state.adapter.name : 'No form recognised on this page';

    const verdict = state.verdict;
    const chosen = verdict?.transmissions?.find(t => String(t.id) === String(state.chosenId)) ?? verdict?.transmissions?.[0];
    const identifier = state.identifiers.sample || state.identifiers.request || state.identifiers.qc_lot || state.identifiers.patient || '';

    const parts = [];

    parts.push(`<div class="card">
      <div class="row"><span>Identifier</span><strong>${identifier ? escapeHtml(identifier) : '<em style="color:#B91C1C;font-style:normal">not found on this form</em>'}</strong></div>
      ${verdict ? `<div class="row"><span>Status</span><span class="chip ${TONES[verdict.status] || 'idle'}">${escapeHtml(verdict.label)}</span></div>` : ''}
      ${verdict?.summary ? `<p class="msg ${TONES[verdict.status] === 'crit' ? 'crit' : TONES[verdict.status] === 'warn' ? 'warn' : ''}">${escapeHtml(verdict.summary)}</p>` : ''}
      ${(verdict?.warnings || []).map(w => `<p class="msg warn">${escapeHtml(w)}</p>`).join('')}
    </div>`);

    if (state.error) parts.push(`<p class="msg crit">${escapeHtml(state.error)}</p>`);
    if (state.notice) parts.push(`<p class="msg">${escapeHtml(state.notice)}</p>`);

    if (verdict?.transmissions?.length > 1) {
      parts.push(`<select class="pick">${verdict.transmissions.map(t => `
        <option value="${t.id}" ${String(t.id) === String(chosen?.id) ? 'selected' : ''}>
          ${escapeHtml(t.sampleId || t.id)} · ${escapeHtml(String(t.receivedAt).replace('T', ' ').slice(0, 16))} · ${t.results} result(s)
        </option>`).join('')}</select>`);
    }

    if (chosen?.readings?.length) {
      parts.push(`<div class="card">
        <div class="row"><span>From</span><strong>${escapeHtml(chosen.analyser || 'Analyser')} · ${escapeHtml(String(chosen.receivedAt).replace('T', ' ').slice(0, 16))}</strong></div>
        ${chosen.patient ? `<div class="row"><span>Patient</span><strong>${escapeHtml(chosen.patient)}</strong></div>` : ''}
        <ul class="results">${chosen.readings.map(r => `
          <li><b>${escapeHtml(r.analyte || r.code)}</b><em>${escapeHtml(r.value)}${r.unit ? ` ${escapeHtml(r.unit)}` : ''}${r.flag ? `<span class="flag ${flagTone(r.flag)}">${escapeHtml(r.flag)}</span>` : ''}</em></li>`).join('')}
        </ul>
      </div>`);
    }

    elements.body.innerHTML = parts.join('\n');
    requestAnimationFrame(clampIntoView);
    elements.body.querySelector('.pick')?.addEventListener('change', event => {
      state.chosenId = event.target.value;
      render();
    });

    renderFooter(verdict);
  }

  function renderFooter(verdict) {
    const buttons = [];
    const canFill = Boolean(verdict?.mayFill) && Boolean(state.adapter) && !state.busy;
    const needsAgreement = verdict && (verdict.status === 'near_match' || verdict.status === 'already_entered');

    if (state.held.length) {
      buttons.push(`<p class="msg warn">${state.held.length} field(s) on this form already have a value.</p>`);
      buttons.push(`<div class="pair">
        <button class="btn warn" data-action="overwrite">Overwrite them</button>
        <button class="btn ghost" data-action="keep">Keep what is there</button>
      </div>`);
    } else {
      buttons.push(`<button class="btn" data-action="populate" ${canFill ? '' : 'disabled'}>
        ${state.busy ? 'Working…' : needsAgreement ? 'Confirm and populate results' : 'Populate results'}
      </button>`);
      buttons.push(`<div class="pair">
        <button class="btn ghost" data-action="recheck">Re-check</button>
        <button class="btn ghost" data-action="options">Settings</button>
      </div>`);
    }
    buttons.push('<p class="note">Fills the form only. Review, save and authorise as usual.</p>');

    elements.footer.innerHTML = buttons.join('\n');
    elements.footer.querySelectorAll('button[data-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'populate') void populate({ confirmed: true, overwrite: false });
        if (action === 'overwrite') void fillHeld();
        if (action === 'keep') void keepHeld();
        if (action === 'recheck') void refresh({ force: true });
        if (action === 'options') void ask('openOptions');
      });
    });
  }

  /* ==========================================================================
     The flow
     ======================================================================= */
  async function detectAdapter() {
    const response = await ask('adapters', { url: location.href });
    if (!response.ok) { state.error = response.error; state.adapter = null; return false; }
    const candidates = (response.data.matched || []).filter(formPresent);
    state.adapter = candidates[0] || null;
    state.error = null;
    return Boolean(state.adapter);
  }

  async function refresh({ force = false } = {}) {
    if (!state.adapter && !(await detectAdapter())) { render(); return; }
    state.identifiers = readIdentifiers(state.adapter);
    const identifier = state.identifiers.sample || state.identifiers.request || state.identifiers.qc_lot || state.identifiers.patient || '';

    if (!identifier) {
      state.verdict = { status: 'no_identifier', label: 'No identifier on the form', summary: 'This form carries no sample identifier yet. Enter or scan it, then re-check.', mayFill: false, transmissions: [] };
      state.lastIdentifier = '';
      render();
      return;
    }
    if (!force && identifier === state.lastIdentifier && state.verdict) { render(); return; }

    state.busy = true; state.error = null; state.notice = null; state.held = []; render();
    const response = await ask('verify', {
      adapterCode: state.adapter.adapterCode,
      identifiers: state.identifiers,
      url: location.href,
      title: document.title,
    });
    state.busy = false;
    if (!response.ok) {
      state.error = response.error;
      state.verdict = null;
    } else {
      state.verdict = response.data;
      state.chosenId = response.data.transmissions?.[0]?.id ?? '';
      state.lastIdentifier = identifier;
    }
    render();
  }

  /**
   * Fill the form.
   *
   * The plan is resolved against the page BEFORE anything is written: if a
   * field the mapping calls required cannot be found exactly once, nothing is
   * filled at all and the bubble says which one. A half-filled panel that looks
   * complete is the one outcome worse than no help.
   */
  async function populate({ confirmed, overwrite }) {
    if (!state.adapter || !state.verdict?.mayFill) return;
    state.busy = true; state.error = null; state.notice = null; render();

    const response = await ask('populate', {
      adapterCode: state.adapter.adapterCode,
      identifiers: state.identifiers,
      messageId: state.chosenId || undefined,
      confirmed: Boolean(confirmed),
      url: location.href,
      title: document.title,
    });
    state.busy = false;

    if (!response.ok) { state.error = response.error; render(); return; }
    const plan = response.data;

    const resolved = plan.fields.map(field => ({ field, ...resolveControl(field, plan) }));
    const unresolvedRequired = resolved.filter(entry => !entry.element && entry.field.required);
    if (unresolvedRequired.length) {
      await ask('outcome', {
        fillUid: plan.fillUid, filled: 0, skipped: plan.fields.length, abandoned: false,
        failures: unresolvedRequired.map(entry => `${entry.field.analyte}: ${entry.reason}`),
      });
      state.error = `Stopped before filling anything: ${unresolvedRequired.map(e => e.field.analyte).join(', ')} could not be found on this form (${unresolvedRequired[0].reason}).`;
      render();
      return;
    }

    const failures = resolved.filter(entry => !entry.element).map(entry => `${entry.field.analyte}: ${entry.reason}`);
    const targets = resolved.filter(entry => entry.element);
    const occupied = targets.filter(entry => textOf(entry.element) !== '');
    const free = targets.filter(entry => textOf(entry.element) === '');

    let filled = 0;
    let overwritten = 0;
    for (const entry of free) {
      if (setValue(entry.element, entry.field.value)) { filled++; flash(entry.element, 'ok'); }
      else failures.push(`${entry.field.analyte}: this field would not take the value ${entry.field.value}`);
    }

    const policy = plan.overwritePolicy || 'confirm';
    if (occupied.length && (overwrite || policy === 'allow')) {
      for (const entry of occupied) {
        if (setValue(entry.element, entry.field.value)) { filled++; overwritten++; flash(entry.element, 'warn'); }
      }
    }

    if (occupied.length && !overwrite && policy === 'confirm') {
      // Held, not skipped: the person decides, and the outcome is reported once
      // they have.
      state.held = occupied;
      state.heldPlan = { plan, filled, overwritten, failures };
      state.notice = `${filled} field(s) filled.`;
      render();
      return;
    }

    const skipped = (occupied.length && !overwrite && policy === 'never') ? occupied.length : 0;
    await report(plan, filled, skipped + failures.length, overwritten, failures);
    state.notice = `${filled} field(s) filled${skipped ? `, ${skipped} left as they were` : ''}${failures.length ? `, ${failures.length} not found` : ''}. Review and save as usual.`;
    state.error = failures.length ? failures.join(' · ') : null;
    render();
  }

  async function fillHeld() {
    const context = state.heldPlan;
    if (!context) return;
    let filled = context.filled;
    let overwritten = context.overwritten;
    for (const entry of state.held) {
      if (setValue(entry.element, entry.field.value)) { filled++; overwritten++; flash(entry.element, 'warn'); }
      else context.failures.push(`${entry.field.analyte}: this field would not take the value`);
    }
    await report(context.plan, filled, context.failures.length, overwritten, context.failures);
    state.notice = `${filled} field(s) filled, ${overwritten} overwritten. Review and save as usual.`;
    state.held = []; state.heldPlan = null;
    render();
  }

  async function keepHeld() {
    const context = state.heldPlan;
    if (!context) return;
    await report(context.plan, context.filled, state.held.length + context.failures.length, context.overwritten, context.failures);
    state.notice = `${context.filled} field(s) filled. ${state.held.length} left exactly as they were.`;
    state.held = []; state.heldPlan = null;
    render();
  }

  function report(plan, filled, skipped, overwritten, failures) {
    return ask('outcome', { fillUid: plan.fillUid, filled, skipped, overwritten, failures });
  }

  /* ==========================================================================
     Staying put
     ----------------------------------------------------------------------------
     A result-entry screen is usually one page that changes underneath, so the
     bubble follows the address rather than the load, and re-reads the
     identifier as the person works.
     ======================================================================= */
  async function evaluate() {
    const matched = await detectAdapter();
    if (!matched) {
      if (!state.open) unmount();
      return;
    }
    mount();
    if (state.open) await refresh();
    else {
      state.identifiers = readIdentifiers(state.adapter);
      setDot();
    }
  }

  function watchNavigation() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function patched(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('sechlims:navigated'));
        return result;
      };
    }
    const onMove = () => {
      if (location.href === state.lastUrl) return;
      state.lastUrl = location.href;
      state.verdict = null; state.lastIdentifier = ''; state.held = []; state.notice = null;
      void evaluate();
    };
    window.addEventListener('sechlims:navigated', onMove);
    window.addEventListener('popstate', onMove);
    setInterval(() => {
      onMove();
      // The identifier can arrive after the page does — a barcode scanned into
      // a box that was empty when the bubble appeared.
      if (state.adapter && !state.open) {
        const identifiers = readIdentifiers(state.adapter);
        const next = identifiers.sample || identifiers.request || identifiers.qc_lot || '';
        if (next && next !== state.lastIdentifier) { state.identifiers = identifiers; void refresh(); }
      }
    }, RECHECK_MS);
    window.addEventListener('resize', () => { if (state.open) clampIntoView(); else restorePosition(); });
  }

  void (async () => {
    await evaluate();
    watchNavigation();
  })();
})();
