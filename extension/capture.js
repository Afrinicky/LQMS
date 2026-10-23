/**
 * Teaching the extension a form it does not know.
 *
 * An administrator opens the form, starts this from the toolbar, and clicks the
 * sample field and then each parameter. What is recorded is a STABLE way to
 * find each box — its id, its name, a data attribute, the label beside it, or
 * the row it sits in — never a position on the screen. The draft is saved in
 * SECHLIMS inactive, so nothing is ever filled from a captured form until
 * somebody has reviewed it.
 */
(() => {
  const HOST_ID = 'sechlims-result-filler-capture';
  if (document.getElementById(HOST_ID)) return;

  const FILLABLE = 'input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea';
  const esc = value => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const unique = query => { try { return document.querySelectorAll(query).length === 1; } catch { return false; } };

  /** The most stable way to find this control again. */
  function selectorFor(element) {
    if (element.id && unique(`#${CSS.escape(element.id)}`)) return { selectorKind: 'id', selector: element.id };
    if (element.name && unique(`[name="${CSS.escape(element.name)}"]`)) return { selectorKind: 'name', selector: element.name };

    for (const attribute of element.getAttributeNames()) {
      if (!attribute.startsWith('data-')) continue;
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const query = `[${attribute}="${CSS.escape(value)}"]`;
      if (unique(query)) return { selectorKind: 'css', selector: query };
    }

    const row = element.closest('tr, [role="row"]');
    if (row) {
      const cells = Array.from(row.children).filter(cell => /^(TD|TH)$/.test(cell.tagName) || cell.getAttribute('role') === 'cell');
      const label = String(cells[0]?.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (label) return { selectorKind: 'row', selector: label.slice(0, 80) };
    }

    const labelled = Array.from(document.querySelectorAll('label')).find(label => {
      const target = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector(FILLABLE);
      return target === element;
    });
    if (labelled) {
      const text = String(labelled.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text) return { selectorKind: 'label', selector: text.slice(0, 80) };
    }

    // Last resort: a path from the nearest identified ancestor. Structural, so
    // it survives a restyle but not a rebuild — which is why it is last.
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id && unique(`#${CSS.escape(node.id)}`)) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
      const parent = node.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).filter(child => child.tagName === node.tagName).indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
    }
    return { selectorKind: 'css', selector: parts.join(' > ') };
  }

  /** The grid a row-matched field lives in, so row lookups stay inside it. */
  function containerFor(element) {
    const table = element.closest('table');
    if (!table) return '';
    if (table.id && unique(`#${CSS.escape(table.id)}`)) return `#${CSS.escape(table.id)}`;
    const classes = Array.from(table.classList).filter(Boolean);
    for (const className of classes) {
      const query = `table.${CSS.escape(className)}`;
      if (document.querySelectorAll(query).length <= 2) return query;
    }
    return 'table';
  }

  const captured = [];
  let identifier = null;
  let container = '';

  /* ---- the panel -------------------------------------------------------- */
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.all = 'initial';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
<style>
  * { box-sizing: border-box; }
  .panel { position: fixed; right: 18px; bottom: 18px; width: 334px; max-height: 74vh; z-index: 2147483001;
    display: flex; flex-direction: column; background: #fff; border: 1px solid #D5DEEC; border-radius: 14px;
    box-shadow: 0 18px 46px rgba(10,22,44,.3); font-family: "Segoe UI", system-ui, Arial, sans-serif;
    font-size: 12.5px; color: #16202E; overflow: hidden; }
  .hd { padding: 10px 12px; background: linear-gradient(90deg,#16284B,#1B3A6B); color: #EAF1FF;
    display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .hd strong { font-size: 12.5px; }
  .hd button { background: transparent; border: 0; color: #CFE0FF; cursor: pointer; font-size: 15px; line-height: 1; }
  .bd { padding: 11px 12px; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; background: #F7F9FC; }
  .hint { margin: 0; font-size: 11.5px; line-height: 1.5; color: #475569; }
  .hint b { color: #1B3A6B; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
  li { background: #fff; border: 1px solid #E2E8F0; border-radius: 9px; padding: 6px 8px;
    display: flex; align-items: center; gap: 7px; }
  li input { flex: 1; min-width: 0; font: inherit; font-size: 12px; border: 1px solid #CBD5E1;
    border-radius: 6px; padding: 4px 6px; }
  li small { color: #94A3B8; font-size: 10px; white-space: nowrap; max-width: 92px; overflow: hidden; text-overflow: ellipsis; }
  li button { background: none; border: 0; color: #B91C1C; cursor: pointer; font-size: 14px; line-height: 1; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; background: #DCFCE7; color: #15803D;
    font-size: 10px; font-weight: 700; }
  .ft { padding: 10px 12px; border-top: 1px solid #E2E8F0; background: #fff; display: flex; gap: 8px; }
  .ft button { flex: 1; font: inherit; font-size: 12.5px; font-weight: 600; padding: 8px; border-radius: 9px;
    cursor: pointer; border: 1px solid #1B3A6B; background: #1B3A6B; color: #fff; }
  .ft button.ghost { background: #fff; color: #1B3A6B; }
  .ft button:disabled { opacity: .45; cursor: default; }
  .msg { margin: 0; font-size: 11.5px; color: #B91C1C; }
</style>
<div class="panel">
  <div class="hd"><strong>Teach this form</strong><button class="x" title="Cancel">&times;</button></div>
  <div class="bd">
    <p class="hint">Click the <b>sample identifier</b> field on the page first, then click each result field. Name each one as the analyser reports it — WBC, HGB, Glucose.</p>
    <ul class="list"></ul>
    <p class="msg"></p>
  </div>
  <div class="ft">
    <button class="ghost cancel">Cancel</button>
    <button class="save" disabled>Save draft</button>
  </div>
</div>`;
  document.documentElement.appendChild(host);

  const panel = shadow.querySelector('.panel');
  const list = shadow.querySelector('.list');
  const message = shadow.querySelector('.msg');
  const saveButton = shadow.querySelector('.save');

  /* ---- picking fields on the page --------------------------------------- */
  let highlighted = null;
  const highlight = element => {
    if (highlighted === element) return;
    if (highlighted) highlighted.style.outline = highlighted.dataset.rfOutline || '';
    highlighted = element;
    if (element) {
      element.dataset.rfOutline = element.style.outline;
      element.style.outline = '2px solid #2DB7B2';
    }
  };

  const onMove = event => {
    if (host.contains(event.target)) return;
    const target = event.target.closest?.(FILLABLE);
    highlight(target || null);
  };

  const onClick = event => {
    if (host.contains(event.target)) return;
    const target = event.target.closest?.(FILLABLE);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();

    const found = selectorFor(target);
    if (!identifier) {
      identifier = { kind: 'sample', ...found, primary: true };
    } else {
      if (!container) container = containerFor(target);
      const row = target.closest('tr, [role="row"]');
      const guess = found.selectorKind === 'row' ? found.selector
        : String(row?.children?.[0]?.textContent ?? '').trim().replace(/\s+/g, ' ');
      captured.push({ sourceCode: (guess || '').slice(0, 40), analyte: guess || '', ...found });
    }
    draw();
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);

  function draw() {
    const rows = [];
    if (identifier) {
      rows.push(`<li><span class="tag">Sample</span><small title="${esc(identifier.selector)}">${esc(identifier.selectorKind)}: ${esc(identifier.selector)}</small></li>`);
    }
    captured.forEach((field, index) => {
      rows.push(`<li>
        <input data-index="${index}" value="${esc(field.sourceCode)}" placeholder="Parameter, e.g. HGB" />
        <small title="${esc(field.selector)}">${esc(field.selectorKind)}</small>
        <button data-remove="${index}" title="Remove">&times;</button>
      </li>`);
    });
    list.innerHTML = rows.join('') || '<li><small>Nothing captured yet.</small></li>';
    list.querySelectorAll('input[data-index]').forEach(input => {
      input.addEventListener('input', () => {
        const field = captured[Number(input.dataset.index)];
        field.sourceCode = input.value.trim();
        field.analyte = input.value.trim();
        saveButton.disabled = !ready();
      });
    });
    list.querySelectorAll('button[data-remove]').forEach(button => {
      button.addEventListener('click', () => { captured.splice(Number(button.dataset.remove), 1); draw(); });
    });
    saveButton.disabled = !ready();
  }

  const ready = () => Boolean(identifier) && captured.length > 0 && captured.every(field => field.sourceCode);

  function close() {
    highlight(null);
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    host.remove();
  }

  shadow.querySelector('.x').addEventListener('click', close);
  shadow.querySelector('.cancel').addEventListener('click', close);

  saveButton.addEventListener('click', () => {
    if (!ready()) return;
    saveButton.disabled = true;
    message.textContent = '';
    const payload = {
      name: document.title ? `${document.title.slice(0, 70)} — captured` : 'Captured form',
      platform: 'other',
      url: location.href,
      urlPattern: `${location.origin}${location.pathname}`,
      formSelector: container || '',
      rowContainer: container || '',
      identifiers: [identifier],
      fields: captured,
      description: `Captured from ${location.host} with ${captured.length} field(s).`,
    };
    chrome.runtime.sendMessage({ type: 'captured', payload }, response => {
      if (!response?.ok) {
        message.textContent = response?.error || 'The draft could not be saved.';
        saveButton.disabled = false;
        return;
      }
      panel.querySelector('.bd').innerHTML = `<p class="hint">${esc(response.data.note || 'Saved as an inactive draft in SECHLIMS.')}</p>`;
      panel.querySelector('.ft').innerHTML = '';
      setTimeout(close, 3200);
    });
  });

  draw();
})();
