import { useRef, useState, type ReactNode } from 'react';
import { Printer, Minus, Plus, Maximize2 } from 'lucide-react';
import type { OrgTreeNode } from '../../../shared/types/api';

// ==========================================================================
// OrgChart — the laboratory's organisational chart.
//
// The tree the server returns chains a unit's staff one below the other, so a
// unit of twenty people used to draw twenty nested levels of connectors: tall,
// wide and unreadable on screen, and unusable on paper. The chart here draws
// the appointed positions as a proper top-down hierarchy and collapses each
// unit's staff chain into one compact succession panel under its supervisor.
// The same shape is written out for printing, scaled to the sheet.
// ==========================================================================

const ROLE_COLOR: Record<string, string> = {
  management: '#2F6BFF', quality: '#C98A12', technical: '#0E9F8E', support: '#7C5CCB',
};

const isAvailable = (a?: string | null) => !a || a.toLowerCase() === 'available';

/** A unit's staff chain, flattened from the nested succession the server sends. */
export function staffChainOf(node: OrgTreeNode): OrgTreeNode[] {
  const out: OrgTreeNode[] = [];
  let cur = node.children.find(c => c.kind === 'staff');
  while (cur) { out.push(cur); cur = cur.children.find(c => c.kind === 'staff'); }
  return out;
}

export function OrgCard({ node, onClick }: { node: OrgTreeNode; onClick?: () => void }) {
  const cls = `oc-card rt-${node.roleType}${node.isActive ? '' : ' is-inactive'}${node.unitHead ? ' is-unit' : ''}`;
  const body = <>
    <span className="oc-role">{node.title}</span>
    <span className={`oc-holder${node.vacant ? ' vacant' : ''}`}>{node.vacant ? 'Vacant' : node.holderName}</span>
    <span className="oc-line">
      {node.unitHead ? 'Next in command' : 'Deputy'}: {node.deputyName || '—'}
      {node.actingName && node.actingName !== node.deputyName ? ` · Acting: ${node.actingName}` : ''}
    </span>
  </>;
  return onClick
    ? <button type="button" className={`${cls} is-clickable`} onClick={onClick}>{body}</button>
    : <div className={cls}>{body}</div>;
}

function StaffPanel({ staff }: { staff: OrgTreeNode[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? staff : staff.slice(0, 6);
  return <div className="oc-staff">
    <div className="oc-staff-head">Unit staff — succession order</div>
    <ol className="oc-staff-list">
      {shown.map((s, i) => (
        <li key={s.key} className={isAvailable(s.availability) ? '' : 'is-away'}>
          <span className="n">{i + 1}</span>
          <span className="who">
            <b>{s.staffName}</b>
            <em>{[s.title, s.rank].filter(Boolean).join(' · ')}</em>
          </span>
          {!isAvailable(s.availability) && <span className="flag">{s.availability}</span>}
        </li>
      ))}
    </ol>
    {staff.length > 6 && (
      <button type="button" className="oc-more" onClick={() => setAll(a => !a)}>
        {all ? 'Show fewer' : `+${staff.length - 6} more`}
      </button>
    )}
  </div>;
}

function OrgBranch({ node, renderCard }: { node: OrgTreeNode; renderCard?: (n: OrgTreeNode) => ReactNode }) {
  const positions = node.children.filter(c => c.kind === 'position');
  const staff = staffChainOf(node);
  return <li>
    <div className="oc-item">
      {renderCard ? renderCard(node) : <OrgCard node={node} />}
      {staff.length > 0 && <StaffPanel staff={staff} />}
    </div>
    {positions.length > 0 && <ul>{positions.map(c => <OrgBranch key={c.key} node={c} renderCard={renderCard} />)}</ul>}
  </li>;
}

export function OrgChart({ roots, renderCard }: { roots: OrgTreeNode[]; renderCard?: (n: OrgTreeNode) => ReactNode }) {
  return <div className="oc-chart">
    <ul className="oc-tree">{roots.map(r => <OrgBranch key={r.key} node={r} renderCard={renderCard} />)}</ul>
  </div>;
}

export function OrgLegend() {
  return <div className="oc-legend">
    <span><i style={{ background: ROLE_COLOR.management }} />Management</span>
    <span><i style={{ background: ROLE_COLOR.quality }} />Quality</span>
    <span><i style={{ background: ROLE_COLOR.technical }} />Technical / unit</span>
    <span><i style={{ background: ROLE_COLOR.support }} />Support / administration</span>
  </div>;
}

// -------------------------------------------------------------------------
// Printing — a self-contained sheet, scaled to the page, so what comes out of
// the printer is the same chart rather than whatever survived the app's theme.
// -------------------------------------------------------------------------
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

function printBranch(node: OrgTreeNode): string {
  const positions = node.children.filter(c => c.kind === 'position');
  const staff = staffChainOf(node);
  const deputy = `${node.unitHead ? 'Next in command' : 'Deputy'}: ${esc(node.deputyName || '—')}`
    + (node.actingName && node.actingName !== node.deputyName ? ` · Acting: ${esc(node.actingName)}` : '');
  const staffHtml = staff.length ? `<div class="staff">
      <div class="staff-head">Unit staff — succession order</div>
      <ol>${staff.map(s => `<li><span class="n"></span><span class="who"><b>${esc(s.staffName)}</b><em>${esc([s.title, s.rank].filter(Boolean).join(' · '))}</em></span>${isAvailable(s.availability) ? '' : `<span class="flag">${esc(s.availability)}</span>`}</li>`).join('')}</ol>
    </div>` : '';
  return `<li><div class="item">
      <div class="card rt-${esc(node.roleType)}">
        <span class="role">${esc(node.title)}</span>
        <span class="holder${node.vacant ? ' vacant' : ''}">${node.vacant ? 'Vacant' : esc(node.holderName)}</span>
        <span class="line">${deputy}</span>
      </div>
      ${staffHtml}
    </div>${positions.length ? `<ul>${positions.map(printBranch).join('')}</ul>` : ''}</li>`;
}

export function organogramPrintHtml(roots: OrgTreeNode[], meta: { facility?: string; subtitle?: string }): string {
  const printedAt = new Date().toLocaleString();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Organisational Chart</title><style>
  @page { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 12px; font-family: Arial, Helvetica, sans-serif; color: #111; }
  .head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1.5px solid #222; padding-bottom: 6px; margin-bottom: 4px; }
  .head h1 { font-size: 15px; margin: 0; letter-spacing: .01em; }
  .head span { font-size: 10.5px; color: #555; }
  .sub { font-size: 11px; color: #555; margin: 0 0 10px; }
  .legend { display: flex; gap: 14px; font-size: 10px; color: #444; margin: 0 0 12px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
  .scale { transform-origin: top center; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; justify-content: center; position: relative; padding-top: 22px; }
  li { position: relative; display: flex; flex-direction: column; align-items: center; padding: 22px 8px 0; break-inside: avoid; }
  li::before { content: ''; position: absolute; top: 11px; left: 50%; width: 1px; height: 11px; background: #9aa3b2; }
  li::after { content: ''; position: absolute; top: 11px; left: 0; right: 0; height: 1px; background: #9aa3b2; }
  li:first-child::after { left: 50%; } li:last-child::after { right: 50%; } li:only-child::after { display: none; }
  li > ul::before { content: ''; position: absolute; top: 0; left: 50%; width: 1px; height: 11px; background: #9aa3b2; }
  .oc-root { padding-top: 0; } .oc-root::before, .oc-root::after { display: none; }
  .item { display: flex; flex-direction: column; align-items: stretch; width: 176px; }
  .card { border: 1px solid #c3c9d4; border-top: 2.5px solid #666; border-radius: 5px; padding: 7px 9px 6px; background: #fff; display: flex; flex-direction: column; gap: 1px; }
  .card .role { font-size: 8.2px; font-weight: 700; line-height: 1.35; text-transform: uppercase; letter-spacing: .07em; color: #667; }
  .card .holder { font-size: 11px; font-weight: 700; line-height: 1.3; }
  .card .holder.vacant { font-style: italic; font-weight: 400; color: #8a6d00; }
  .card .line { font-size: 8.4px; color: #667; margin-top: 4px; padding-top: 4px; border-top: 1px dashed #d6dbe4; }
  .oc-root > .item { width: 200px; }
  .oc-root > .item .card { background: #f7f9fc; padding: 9px 11px 8px; }
  .oc-root > .item .holder { font-size: 12px; }
  .rt-management { border-top-color: ${ROLE_COLOR.management}; } .rt-management .role { color: ${ROLE_COLOR.management}; }
  .rt-quality { border-top-color: ${ROLE_COLOR.quality}; } .rt-quality .role { color: ${ROLE_COLOR.quality}; }
  .rt-technical { border-top-color: ${ROLE_COLOR.technical}; } .rt-technical .role { color: ${ROLE_COLOR.technical}; }
  .rt-support { border-top-color: ${ROLE_COLOR.support}; } .rt-support .role { color: ${ROLE_COLOR.support}; }
  .staff { border: 1px solid #ccd2dc; border-top: 0; border-radius: 0 0 5px 5px; margin-top: -1px; background: #fafbfd; }
  .staff-head { font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #667; padding: 4px 8px; border-bottom: 1px solid #e3e7ee; }
  .staff ol { list-style: none; margin: 0; padding: 4px 8px 6px; counter-reset: s; display: block; }
  .staff ol li { display: flex; flex-direction: row; align-items: baseline; gap: 6px; padding: 2px 0; counter-increment: s; text-align: left; }
  .staff li .n::before { content: counter(s); }
  .staff li::before, .staff li::after { display: none; }
  .staff .n { font-size: 9px; color: #889; min-width: 10px; }
  .staff .who { display: flex; flex-direction: column; align-items: flex-start; flex: 1; min-width: 0; }
  .staff .who b { font-size: 9.8px; font-weight: 600; }
  .staff .who em { font-size: 8.6px; color: #667; font-style: normal; }
  .staff .flag { font-size: 7.6px; color: #9a3412; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  </style></head><body>
  <div class="head"><h1>${esc(meta.facility || 'Laboratory')} — Organisational Chart</h1><span>Printed ${esc(printedAt)}</span></div>
  ${meta.subtitle ? `<p class="sub">${esc(meta.subtitle)}</p>` : ''}
  <div class="legend">
    <span><i style="background:${ROLE_COLOR.management}"></i>Management</span>
    <span><i style="background:${ROLE_COLOR.quality}"></i>Quality</span>
    <span><i style="background:${ROLE_COLOR.technical}"></i>Technical / unit</span>
    <span><i style="background:${ROLE_COLOR.support}"></i>Support / administration</span>
  </div>
  <div class="scale" id="scale"><ul>${roots.map(r => printBranch(r).replace('<li>', '<li class="oc-root">')).join('')}</ul></div>
  <script>window.onload = function () {
    var el = document.getElementById('scale');
    var avail = document.body.clientWidth - 24;
    var s = Math.max(0.4, Math.min(1, avail / Math.max(1, el.scrollWidth)));
    el.style.transform = 'scale(' + s + ')';
    el.style.height = (el.scrollHeight * s) + 'px';
    setTimeout(function () { window.print(); }, 120);
  };</script>
  </body></html>`;
}

// -------------------------------------------------------------------------
// The framed chart: zoom, fit and print around the chart itself.
// -------------------------------------------------------------------------
export function OrgChartBoard({ roots, facility, subtitle, renderCard, actions, emptyText = 'No positions on the organogram yet.', onPrintError }: {
  roots: OrgTreeNode[];
  facility?: string;
  subtitle?: string;
  renderCard?: (n: OrgTreeNode) => ReactNode;
  actions?: ReactNode;
  emptyText?: string;
  onPrintError?: (m: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const viewportRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  function fitToScreen() {
    const vp = viewportRef.current, ch = chartRef.current;
    if (!vp || !ch) return;
    const w = ch.scrollWidth / (zoom || 1);
    const avail = vp.clientWidth - 24;
    setZoom(w > 0 ? Math.max(0.4, Math.min(1, avail / w)) : 1);
  }

  function print() {
    const w = window.open('', '_blank', 'width=1100,height=800');
    if (!w) { onPrintError?.('Allow pop-ups to print the organogram.'); return; }
    w.document.write(organogramPrintHtml(roots, { facility, subtitle }));
    w.document.close();
  }

  return <div className="oc-board">
    <div className="oc-toolbar no-print">
      <OrgLegend />
      <div className="oc-tools">
        <div className="oc-zoom">
          <button type="button" title="Zoom out" onClick={() => setZoom(z => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}><Minus size={13} /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" title="Zoom in" onClick={() => setZoom(z => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}><Plus size={13} /></button>
          <button type="button" title="Fit to screen" onClick={fitToScreen}><Maximize2 size={13} /></button>
        </div>
        {actions}
        <button type="button" className="secondary" onClick={print}><Printer size={14} /> Print</button>
      </div>
    </div>
    <div className="oc-viewport" ref={viewportRef}>
      <div className="oc-scale" ref={chartRef} style={{ zoom } as React.CSSProperties}>
        {roots.length === 0 ? <p className="hint" style={{ padding: 24 }}>{emptyText}</p> : <OrgChart roots={roots} renderCard={renderCard} />}
      </div>
    </div>
  </div>;
}
