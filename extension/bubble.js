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
     --------------------------------------------------------------------------
     Not "find the selector I was given" but "read this form". A result page
     prints the things that identify it — the sample barcode in a table cell,
     the folder number under the photograph — and writes the name of each
     parameter beside the box it belongs in. None of that is reachable through
     input elements alone, which is why the first version could not see the
     barcode at all.

     So the page is read three ways, in the order a person would:

       what a COLUMN HEADER says about the cell under it,
       what a CAPTION says about the value beside it,
       and failing both, what the value itself LOOKS like.

     Nothing found this way is trusted on its own. Everything goes to SECHLIMS,
     which decides which identifier it recognises and which reading belongs in
     which box, and says on what grounds.
     ======================================================================= */
  const norm = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const visible = el => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const squash = value => String(value ?? '').replace(/[\u00a0\s]+/g, ' ').trim();

  const FILLABLE = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=date]):not([type=time]):not([type=search]), textarea';
  const ROW = 'tr, [role="row"]';

  /**
   * An element's words, with the gaps the markup implies.
   *
   * `textContent` runs adjacent elements together: a label cell holding
   * `MPV`, `*`, `(Laser Flowcytometry)` and the previous value `0` comes back
   * as `MPV*(Laser Flowcytometry)0`, and the trailing value becomes part of the
   * name. Joining the text nodes keeps them apart, which is what a person
   * reading the cell sees.
   */
  function labelTextOf(element) {
    if (!element) return '';
    const parts = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = squash(walker.currentNode.textContent);
      if (text) parts.push(text);
      if (parts.length > 40) break;
    }
    return parts.join(' ');
  }

  /** The decoration a form puts on a label is not part of its name. */
  function cleanLabel(raw) {
    return squash(raw)
      .replace(/[*\u2020\u2021]+/g, ' ')
      .replace(/\s+0(\.0+)?\s*$/, '')
      .replace(/\s*[:\uff1a]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (!visible(el)) return false;
    if (elements.host && elements.host.contains(el)) return false;
    const name = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
    // A search box on a result page is not a result box.
    return !/search|filter|query|captcha|password/.test(name);
  }

  function textOf(el) {
    if (!el) return '';
    if ('value' in el && el.tagName !== 'BUTTON') return String(el.value ?? '').trim();
    return squash(el.textContent);
  }

  /** The cells of a row, whether the page builds rows from a table or from divs. */
  function cellsOf(row) {
    return Array.from(row.children).filter(cell =>
      /^(TD|TH)$/.test(cell.tagName) || cell.getAttribute('role') === 'cell' || cell.getAttribute('role') === 'columnheader');
  }

  /* ---- identifiers ------------------------------------------------------- */
  let detectionRules = { identifierRules: [], shapes: [] };

  function identifierKindOf(label) {
    const clean = cleanLabel(label).toUpperCase().replace(/[.\u00a0]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 40) return null;
    for (const rule of detectionRules.identifierRules || []) {
      for (const source of rule.patterns) {
        let pattern;
        try { pattern = new RegExp(source); } catch { continue; }
        if (pattern.test(clean)) return { kind: rule.kind, weight: rule.weight };
      }
    }
    return null;
  }

  /** A value that identifies a sample even where nothing labels it. */
  function looksLikeIdentifier(value) {
    const text = squash(value).toUpperCase();
    if (!text || text.length < 5 || text.length > 32) return null;
    if (/^\d{1,2}[-/ ]\d{1,2}[-/ ]\d{2,4}$/.test(text)) return null;
    if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(text)) return null;
    if (/^(NA|N\/A|NIL|NONE|-)$/.test(text)) return null;
    for (const shape of detectionRules.shapes || []) {
      let pattern;
      try { pattern = new RegExp(shape.pattern); } catch { continue; }
      if (pattern.test(text)) return { kind: shape.kind, weight: shape.weight, description: shape.description };
    }
    return null;
  }

  function addIdentifier(found, candidate) {
    const value = squash(candidate.value);
    if (!value || value === '-' || value.length > 64) return;
    // A value the page LABELLED is not also guessed at by its shape: an
    // insurance number that happens to be ten digits long is an insurance
    // number, and offering it as a second sample identifier only wastes a
    // lookup and clutters what the bench is shown.
    if (candidate.source === 'shape') {
      for (const held of found.values()) {
        if (norm(held.value) === norm(value) && held.source !== 'shape') return;
      }
    }
    const key = `${candidate.kind}:${norm(value)}`;
    const held = found.get(key);
    if (held) {
      // The same number printed twice on one page — the barcode appears in
      // Sample Details and again in Sample Remarks — is corroboration.
      held.confidence = Math.min(100, held.confidence + 6);
      if (!held.label && candidate.label) held.label = candidate.label;
      return;
    }
    found.set(key, {
      kind: candidate.kind,
      label: cleanLabel(candidate.label).slice(0, 80),
      value,
      source: candidate.source,
      confidence: Math.min(100, candidate.confidence),
    });
  }

  /** Column header above a cell: how a sample barcode is printed on every LIS. */
  function identifiersFromTables(found) {
    for (const table of document.querySelectorAll('table')) {
      if (elements.host && elements.host.contains(table)) continue;
      const rows = Array.from(table.querySelectorAll(ROW));
      if (rows.length < 2) continue;
      const headerCells = cellsOf(rows[0]);
      if (!headerCells.length) continue;
      const headers = headerCells.map(cell => cleanLabel(labelTextOf(cell)));
      const interesting = headers.map(identifierKindOf);
      if (!interesting.some(Boolean)) continue;

      for (const row of rows.slice(1, 12)) {
        const cells = cellsOf(row);
        if (cells.length !== headers.length) continue;
        interesting.forEach((rule, column) => {
          if (!rule) return;
          const cell = cells[column];
          const value = squash(labelTextOf(cell));
          if (!value) return;
          addIdentifier(found, {
            kind: rule.kind, label: headers[column], value,
            source: 'header', confidence: rule.weight,
          });
        });
      }
    }
  }

  /** A caption and the value beside it: `NHIA No. 29366816`. */
  function identifiersFromCaptions(found) {
    const captions = document.querySelectorAll('b, strong, label, th, td, span, div, dt, p');
    for (const caption of captions) {
      if (elements.host && elements.host.contains(caption)) continue;
      const own = squash(Array.from(caption.childNodes)
        .filter(node => node.nodeType === 3)
        .map(node => node.textContent).join(' '));
      const whole = squash(caption.textContent);
      const label = own || whole;
      if (!label || label.length > 40) continue;
      const rule = identifierKindOf(label);
      if (!rule) continue;

      // The value is whatever follows the caption: the rest of its own text,
      // the next cell, or the next node along.
      const candidates = [];
      if (whole.length > label.length) candidates.push(whole.slice(label.length));
      const sibling = caption.nextElementSibling;
      if (sibling) candidates.push(squash(sibling.textContent));
      let node = caption.nextSibling;
      while (node && candidates.length < 4) {
        if (node.nodeType === 3 && squash(node.textContent)) candidates.push(squash(node.textContent));
        node = node.nextSibling;
      }
      if (caption.htmlFor) {
        const target = document.getElementById(caption.htmlFor);
        if (target) candidates.push(textOf(target));
      }

      for (const candidate of candidates) {
        const value = squash(candidate).replace(/^[:\-\u2013\s]+/, '');
        if (!value || value.length > 64) continue;
        if (identifierKindOf(value)) continue;
        addIdentifier(found, { kind: rule.kind, label, value, source: 'caption', confidence: rule.weight - 4 });
        break;
      }
    }
  }

  /** A box somebody types the sample number into, where the form has one. */
  function identifiersFromInputs(found) {
    for (const input of document.querySelectorAll('input, select')) {
      if (!isFillable(input) && input.tagName !== 'SELECT') continue;
      const value = textOf(input);
      if (!value) continue;
      const names = [input.name, input.id, input.placeholder, input.getAttribute('aria-label')].filter(Boolean);
      let rule = null;
      let label = '';
      for (const name of names) {
        rule = identifierKindOf(String(name).replace(/[_\-]+/g, ' '));
        if (rule) { label = String(name); break; }
      }
      if (!rule) {
        const row = input.closest(ROW);
        const first = row ? cellsOf(row)[0] : null;
        if (first) { rule = identifierKindOf(labelTextOf(first)); label = cleanLabel(labelTextOf(first)); }
      }
      if (!rule) continue;
      addIdentifier(found, { kind: rule.kind, label, value, source: 'input', confidence: rule.weight });
    }
  }

  /** Nothing labelled it, but it is shaped like a sample number. */
  function identifiersFromShape(found) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (elements.host && elements.host.contains(node.parentElement)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return squash(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let seen = 0;
    while (walker.nextNode() && seen < 4_000) {
      seen++;
      const text = squash(walker.currentNode.textContent);
      if (text.length > 64) continue;
      const shape = looksLikeIdentifier(text);
      if (!shape) continue;
      addIdentifier(found, { kind: shape.kind, label: '', value: text, source: 'shape', confidence: shape.weight });
    }
  }

  function detectIdentifiers() {
    const found = new Map();
    // Labelled first, guessed last, so a guess never displaces a label.
    identifiersFromTables(found);
    identifiersFromCaptions(found);
    identifiersFromInputs(found);
    identifiersFromShape(found);
    const rank = { sample: 0, request: 1, patient: 2, other: 3 };
    return Array.from(found.values())
      .sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || b.confidence - a.confidence)
      .slice(0, 24);
  }

  /* ---- the result fields ------------------------------------------------- */

  /** What the form calls the box: the row it sits in, its label, or its name. */
  function labelForControl(control) {
    const row = control.closest(ROW);
    if (row) {
      const cells = cellsOf(row);
      const inputs = cells.flatMap(cell => Array.from(cell.querySelectorAll(FILLABLE)).filter(isFillable));
      if (inputs.length <= 1 && cells.length) {
        const label = cleanLabel(labelTextOf(cells[0]));
        if (label) return { label, row, cells };
      }
    }
    if (control.id) {
      const tag = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      const label = tag ? cleanLabel(labelTextOf(tag)) : '';
      if (label) return { label, row, cells: row ? cellsOf(row) : [] };
    }
    const wrapping = control.closest('label');
    if (wrapping) {
      const label = cleanLabel(labelTextOf(wrapping).replace(textOf(control), ''));
      if (label) return { label, row, cells: row ? cellsOf(row) : [] };
    }
    // A container a few levels up that holds this one box and some words.
    let node = control.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const inputs = Array.from(node.querySelectorAll(FILLABLE)).filter(isFillable);
      if (inputs.length !== 1) break;
      const label = cleanLabel(labelTextOf(node).replace(textOf(control), ''));
      if (label && label.length <= 80) return { label, row, cells: row ? cellsOf(row) : [] };
    }
    const previous = control.previousElementSibling;
    const label = previous ? cleanLabel(labelTextOf(previous)) : '';
    return { label, row, cells: row ? cellsOf(row) : [] };
  }

  /** The unit beside a result box, where the form offers one. */
  function unitNear(control, row) {
    const scope = row || control.parentElement;
    if (!scope) return null;
    for (const select of scope.querySelectorAll('select')) {
      const value = squash(select.options?.[select.selectedIndex]?.textContent ?? select.value);
      if (!value) continue;
      if (/^select\b/i.test(value) || /^--/.test(value)) return null;
      return value;
    }
    return null;
  }

  /** The reference range printed beside the box, kept for the record only. */
  function referenceNear(cells, labelCell) {
    for (let i = cells.length - 1; i > labelCell; i--) {
      const text = squash(cells[i].textContent);
      if (!text || text.length > 120) continue;
      if (/\d/.test(text) && /[-\u2013]|to\b|</.test(text)) return text;
    }
    return null;
  }

  /** Every box on this page that takes a result, with what the form calls it. */
  let fieldHandles = new Map();

  function detectFields() {
    fieldHandles = new Map();
    const fields = [];
    const controls = Array.from(document.querySelectorAll(FILLABLE)).filter(isFillable);

    for (const control of controls) {
      const { label, row, cells } = labelForControl(control);
      if (!label) continue;
      // A box whose label names an identifier is not a result box.
      if (identifierKindOf(label)) continue;
      // Nor is a free-text remark or a signature.
      if (/remark|comment|note|reason|signature|verified|checked/i.test(label)) continue;
      if (label.length > 90) continue;

      const index = fields.length;
      fieldHandles.set(index, control);
      fields.push({
        index,
        label,
        unit: unitNear(control, row),
        referenceText: cells.length ? referenceNear(cells, 0) : null,
        current: textOf(control),
        kind: control.tagName === 'SELECT' ? 'select' : 'text',
      });
      if (fields.length >= 300) break;
    }
    return fields;
  }

  /** One pass over the page: what identifies it, and what it is asking for. */
  function scanPage() {
    return { identifiers: detectIdentifiers(), fields: detectFields() };
  }

  /**
   * Put a value in, the way the page's own framework will notice.
   *
   * Assigning to `.value` is invisible to React, Vue and anything else holding
   * its own copy of the field's state: the box shows the number and the form
   * saves what the person last typed. The native setter plus the events is what
   * makes the framework agree with the screen. A plain PHP page needs none of
   * it and is unharmed by it.
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
    element.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  function flash(element, tone) {
    const previous = element.style.boxShadow;
    element.style.transition = 'box-shadow .25s ease';
    element.style.boxShadow = tone === 'ok' ? '0 0 0 2px #2DB7B2' : '0 0 0 2px #D97706';
    setTimeout(() => { element.style.boxShadow = previous; }, 1400);
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
    /** What the last scan of the page found. */
    scan: { identifiers: [], fields: [] },
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
    /** The signature of the last page state scanned, so a re-scan is cheap. */
    lastShape: '',
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
    const sample = verdict?.matchedOn ?? primaryIdentifier();
    const patient = state.scan.identifiers.find(i => i.kind === 'patient');

    const parts = [];

    // What the page was read as, first: the bench should be able to see that
    // the right sample was picked up before looking at anything else.
    parts.push(`<div class="card">
      <div class="row"><span>${escapeHtml(sample?.label || 'Sample')}</span><strong>${sample?.value
        ? escapeHtml(sample.value)
        : '<em style="color:#B91C1C;font-style:normal">no sample identifier found on this page</em>'}</strong></div>
      ${patient ? `<div class="row"><span>${escapeHtml(patient.label || 'Patient')}</span><strong>${escapeHtml(patient.value)}</strong></div>` : ''}
      <div class="row"><span>Read</span><strong>${state.scan.fields.length} result field(s)</strong></div>
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
    // The rules for recognising an identifier come from SECHLIMS, so the page
    // and the server can never disagree about what a barcode looks like.
    if (response.data.detection) detectionRules = response.data.detection;
    const candidates = (response.data.matched || []).filter(formPresent);
    state.adapter = candidates[0] || null;
    state.error = null;
    return Boolean(state.adapter);
  }

  /** The identifier a fill would be filed against, as the page gave it. */
  function primaryIdentifier() {
    return state.scan.identifiers.find(i => i.kind === 'sample')
      ?? state.scan.identifiers.find(i => i.kind === 'request')
      ?? state.scan.identifiers.find(i => i.kind === 'patient')
      ?? null;
  }

  /** Enough of the page's state to notice it has changed, without re-reading it. */
  function pageShape() {
    const identifiers = state.scan.identifiers.map(i => `${i.kind}=${i.value}`).join('|');
    return `${location.href}#${identifiers}#${state.scan.fields.length}`;
  }

  async function refresh({ force = false } = {}) {
    if (!state.adapter && !(await detectAdapter())) { render(); return; }

    state.scan = scanPage();
    const identifier = primaryIdentifier();
    const shape = pageShape();

    if (!identifier) {
      state.verdict = {
        status: 'no_identifier',
        label: 'No identifier on the page',
        summary: state.scan.fields.length
          ? 'This page carries result fields but nothing that identifies the sample. Nothing will be filled.'
          : 'Nothing on this page identifies a sample yet.',
        mayFill: false, transmissions: [],
      };
      state.lastShape = shape;
      render();
      return;
    }
    if (!force && shape === state.lastShape && state.verdict) { render(); return; }

    state.busy = true; state.error = null; state.notice = null; state.held = []; render();
    const response = await ask('verify', {
      adapterCode: state.adapter.adapterCode,
      detectedIdentifiers: state.scan.identifiers,
      detectedFields: state.scan.fields,
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
      state.lastShape = shape;
      state.lastIdentifier = identifier.value;
    }
    render();
  }

  /**
   * Fill the form.
   *
   * The page is read AGAIN first. Between the bubble appearing and the button
   * being pressed a person may have opened a panel, switched sample or had the
   * page reload a section under them, and filling a plan built against the page
   * as it used to be is how a number lands in the wrong box.
   */
  async function populate({ confirmed, overwrite }) {
    if (!state.adapter || !state.verdict?.mayFill) return;
    state.busy = true; state.error = null; state.notice = null; render();

    state.scan = scanPage();
    const response = await ask('populate', {
      adapterCode: state.adapter.adapterCode,
      detectedIdentifiers: state.scan.identifiers,
      detectedFields: state.scan.fields,
      messageId: state.chosenId || undefined,
      confirmed: Boolean(confirmed),
      url: location.href,
      title: document.title,
    });
    state.busy = false;

    if (!response.ok) { state.error = response.error; render(); return; }
    const plan = response.data;
    const entries = plan.mode === 'detected' ? resolveAssignments(plan) : resolveConfigured(plan);

    const unresolvedRequired = entries.filter(entry => !entry.element && entry.required);
    if (unresolvedRequired.length) {
      await ask('outcome', {
        fillUid: plan.fillUid, filled: 0, skipped: entries.length, abandoned: false,
        failures: unresolvedRequired.map(entry => `${entry.label}: ${entry.reason}`),
      });
      state.error = `Stopped before filling anything: ${unresolvedRequired.map(e => e.label).join(', ')} could not be found on this form (${unresolvedRequired[0].reason}).`;
      render();
      return;
    }

    const failures = entries.filter(entry => !entry.element).map(entry => `${entry.label}: ${entry.reason}`);
    for (const left of plan.unmatched || []) {
      failures.push(`${left.analyte || left.code}: this form has no field for it`);
    }
    const targets = entries.filter(entry => entry.element);
    const occupied = targets.filter(entry => textOf(entry.element) !== '');
    const free = targets.filter(entry => textOf(entry.element) === '');

    let filled = 0;
    let overwritten = 0;
    for (const entry of free) {
      if (setValue(entry.element, entry.value)) { filled++; flash(entry.element, 'ok'); }
      else failures.push(`${entry.label}: this field would not take the value ${entry.value}`);
    }

    const policy = plan.overwritePolicy || 'confirm';
    if (occupied.length && (overwrite || policy === 'allow')) {
      for (const entry of occupied) {
        if (setValue(entry.element, entry.value)) { filled++; overwritten++; flash(entry.element, 'warn'); }
      }
    }

    if (occupied.length && !overwrite && policy === 'confirm') {
      state.held = occupied;
      state.heldPlan = { plan, filled, overwritten, failures };
      state.notice = `${filled} field(s) filled.`;
      render();
      return;
    }

    const skipped = (occupied.length && !overwrite && policy === 'never') ? occupied.length : 0;
    await report(plan, filled, skipped + failures.length, overwritten, failures);
    state.notice = `${filled} field(s) filled${skipped ? `, ${skipped} left as they were` : ''}${failures.length ? `, ${failures.length} not filled` : ''}. Review and save as usual.`;
    state.error = failures.length ? failures.join(' · ') : null;
    render();
  }

  /**
   * A plan SECHLIMS built against the page's own fields.
   *
   * The handles are the ones this scan created, so no selector is resolved and
   * nothing can be mistaken for something else: assignment 7 is the box the
   * scanner labelled 7 and no other.
   */
  function resolveAssignments(plan) {
    return (plan.assignments || []).map(assignment => {
      const element = fieldHandles.get(assignment.index);
      return {
        label: assignment.fieldLabel || assignment.analyte,
        value: assignment.value,
        required: Boolean(assignment.required),
        element: element && isFillable(element) ? element : null,
        reason: element ? 'that field is no longer editable' : 'that field is no longer on the page',
      };
    });
  }

  /** A plan built from configured selectors, for a form that reads as nothing. */
  function resolveConfigured(plan) {
    return (plan.fields || []).map(field => {
      const found = resolveControl(field, plan);
      return {
        label: field.analyte || field.sourceCode,
        value: field.value,
        required: Boolean(field.required),
        element: found.element,
        reason: found.reason || 'not found',
      };
    });
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
      // Everything else is a name on the page, which the scanner already read.
      const wanted = [selector, ...(spec.aliases || [])].map(norm);
      for (const [index, control] of fieldHandles) {
        const field = state.scan.fields[index];
        if (!field) continue;
        const label = norm(field.label);
        if (wanted.some(want => want && (label === want || label.startsWith(want)))) {
          return { element: control, reason: null };
        }
      }
      return { element: null, reason: 'no field on this page carries that name' };
    } catch (error) {
      return { element: null, reason: `that selector could not be read: ${error.message}` };
    }
  }

  async function fillHeld() {
    const context = state.heldPlan;
    if (!context) return;
    let filled = context.filled;
    let overwritten = context.overwritten;
    for (const entry of state.held) {
      if (setValue(entry.element, entry.value)) { filled++; overwritten++; flash(entry.element, 'warn'); }
      else context.failures.push(`${entry.label}: this field would not take the value`);
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
  /**
   * Decide whether this page is one of ours, and get ready on it.
   *
   * The scan runs whether or not the panel is open, so the bubble's dot is
   * already green by the time somebody looks at it: on a form the laboratory
   * uses forty times a morning, the answer should be waiting rather than
   * fetched when asked for.
   */
  async function evaluate() {
    const matched = await detectAdapter();
    if (!matched) {
      if (!state.open) unmount();
      return;
    }
    mount();
    await refresh();
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
      state.verdict = null; state.lastShape = ''; state.held = []; state.notice = null;
      void evaluate();
    };
    window.addEventListener('sechlims:navigated', onMove);
    window.addEventListener('popstate', onMove);

    /*
     * A result page changes under the person working on it: a panel is
     * expanded, a sample is chosen, a barcode is scanned into a box that was
     * empty. Re-reading the page is cheap; asking SECHLIMS again is not, so it
     * happens only when what was read has actually changed.
     */
    setInterval(() => {
      onMove();
      if (!state.adapter || state.busy || state.held.length) return;
      const previous = pageShape();
      state.scan = scanPage();
      if (pageShape() !== previous) void refresh();
      else setDot();
    }, RECHECK_MS);

    // A page that builds its sections after load — LHIMS expands its panels —
    // is caught by watching for them rather than by polling faster.
    try {
      const observer = new MutationObserver(() => {
        if (!state.adapter || state.busy || state.open || state.held.length) return;
        clearTimeout(observer.timer);
        observer.timer = setTimeout(() => {
          const previous = pageShape();
          state.scan = scanPage();
          if (pageShape() !== previous) void refresh();
        }, 700);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch { /* an older browser polls instead */ }

    window.addEventListener('resize', () => { if (state.open) clampIntoView(); else restorePosition(); });
  }

  void (async () => {
    await evaluate();
    watchNavigation();
  })();
})();
