import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Printer, Minus, Plus, Maximize2, X } from 'lucide-react';
import type { OrgChartModel, OrgChartRole, OrgChartUnit, OrgHolder } from '../../../shared/types/api';

// ==========================================================================
// The laboratory's organisational chart.
//
// The chart follows the laboratory's own drawn structure: the Laboratory
// Manager at the head, the Deputy Laboratory Manager directly beneath him, the
// appointed officers on either side of that spine, the unit supervisors across
// the width of the sheet, and each unit's staff grouped by grade below its
// supervisor. One sheet, one page, the same shape on screen and on paper.
// ==========================================================================

const ROLE_COLOR: Record<string, string> = {
  management: '#2F6BFF', quality: '#C98A12', technical: '#0E9F8E', support: '#7C5CCB',
};

const away = (a?: string | null) => !!a && a.toLowerCase() !== 'available';
const namesOf = (holders: OrgHolder[]) => holders.map(h => h.name);

function Names({ holders, onOpenStaff }: { holders: OrgHolder[]; onOpenStaff?: (id: number) => void }) {
  if (holders.length === 0) return <span className="oc-vacant">Vacant</span>;
  return <span className="oc-names">
    {holders.map((h, i) => (
      <span key={h.staffId} className={away(h.availability) ? 'is-away' : ''}>
        {onOpenStaff
          ? <button type="button" className="oc-name-btn" onClick={e => { e.stopPropagation(); onOpenStaff(h.staffId); }}>{h.name}</button>
          : h.name}
        {i < holders.length - 1 ? ', ' : ''}
      </span>
    ))}
  </span>;
}

function RoleBox({ role, level, onSelect, onOpenStaff, selected }: {
  role: OrgChartRole; level: 'lead' | 'deputy' | 'officer' | 'unit';
  onSelect?: (positionId: number) => void; onOpenStaff?: (id: number) => void; selected?: boolean;
}) {
  const cls = `oc-box lvl-${level} rt-${role.roleType}${selected ? ' is-selected' : ''}${onSelect ? ' is-clickable' : ''}`;
  return (
    <div className={cls} onClick={onSelect ? () => onSelect(role.positionId) : undefined} role={onSelect ? 'button' : undefined}>
      <span className="oc-title">{role.title}</span>
      <Names holders={role.holders} onOpenStaff={onOpenStaff} />
      {role.deputies.length > 0 && <span className="oc-sub">Deputy: {namesOf(role.deputies).join(', ')}</span>}
    </div>
  );
}

function UnitColumn({ unit, onSelect, onOpenStaff, selected }: {
  unit: OrgChartUnit; onSelect?: (positionId: number) => void; onOpenStaff?: (id: number) => void; selected?: boolean;
}) {
  return <li className="oc-unit">
    <RoleBox role={unit} level="unit" onSelect={onSelect} onOpenStaff={onOpenStaff} selected={selected} />
    {unit.cadres.map(row => <div key={row.label} className="oc-cadre">
      <span className="oc-cadre-label">{row.label}</span>
      <span className="oc-cadre-names"><Names holders={row.staff} onOpenStaff={onOpenStaff} /></span>
    </div>)}
  </li>;
}

export function OrgChartSheet({ model, onSelectRole, onOpenStaff, selectedId, withHeading = false }: {
  model: OrgChartModel;
  onSelectRole?: (positionId: number) => void;
  onOpenStaff?: (id: number) => void;
  selectedId?: number | null;
  withHeading?: boolean;
}) {
  // The officers hang either side of the spine, balanced, in the order the
  // laboratory names them.
  const right = model.officers.filter((_, i) => i % 2 === 0);
  const left = model.officers.filter((_, i) => i % 2 === 1);

  return <div className="oc-sheet">
    {withHeading && <div className="oc-sheet-head">
      <strong>{model.facility}</strong>
      <span>Laboratory Organisational Structure</span>
    </div>}

    <div className="oc-lead">
      {model.manager
        ? <RoleBox role={model.manager} level="lead" onSelect={onSelectRole} onOpenStaff={onOpenStaff} selected={selectedId === model.manager.positionId} />
        : <div className="oc-box lvl-lead rt-management is-empty"><span className="oc-title">Laboratory Manager</span><span className="oc-vacant">Not created</span></div>}
      <span className="oc-vline" />
      {model.deputy
        ? <RoleBox role={model.deputy} level="deputy" onSelect={onSelectRole} onOpenStaff={onOpenStaff} selected={selectedId === model.deputy.positionId} />
        : <div className="oc-box lvl-deputy rt-management is-empty"><span className="oc-title">Deputy Laboratory Manager</span><span className="oc-vacant">Not created</span></div>}
    </div>

    <div className="oc-band">
      <div className="oc-side oc-side-left">
        {left.map(o => <div key={o.positionId} className="oc-slot">
          <RoleBox role={o} level="officer" onSelect={onSelectRole} onOpenStaff={onOpenStaff} selected={selectedId === o.positionId} />
          <span className="oc-arm" />
        </div>)}
      </div>
      <div className="oc-band-center"><span className="oc-stem" /></div>
      <div className="oc-side oc-side-right">
        {right.map(o => <div key={o.positionId} className="oc-slot">
          <span className="oc-arm" />
          <RoleBox role={o} level="officer" onSelect={onSelectRole} onOpenStaff={onOpenStaff} selected={selectedId === o.positionId} />
        </div>)}
      </div>
    </div>

    {model.units.length > 0 && <ul className="oc-units">
      {model.units.map(u => <UnitColumn key={u.positionId} unit={u} onSelect={onSelectRole} onOpenStaff={onOpenStaff} selected={selectedId === u.positionId} />)}
    </ul>}
  </div>;
}

// -------------------------------------------------------------------------
// The printed sheet — its own document, scaled to one A4 page.
// -------------------------------------------------------------------------
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const printNames = (holders: OrgHolder[]) =>
  holders.length ? `<span class="names">${esc(namesOf(holders).join(', '))}</span>` : '<span class="vacant">Vacant</span>';

function printBox(role: OrgChartRole, level: string): string {
  return `<div class="box ${level} rt-${esc(role.roleType)}">
    <span class="title">${esc(role.title)}</span>
    ${printNames(role.holders)}
    ${role.deputies.length ? `<span class="sub">Deputy: ${esc(namesOf(role.deputies).join(', '))}</span>` : ''}
  </div>`;
}

export function organogramPrintHtml(model: OrgChartModel): string {
  const printedAt = new Date().toLocaleDateString();
  const right = model.officers.filter((_, i) => i % 2 === 0);
  const left = model.officers.filter((_, i) => i % 2 === 1);
  const units = model.units.map(u => `<li class="unit">
      ${printBox(u, 'unit')}
      ${u.cadres.map(r => `<div class="cadre"><span class="cl">${esc(r.label)}</span><span class="cn">${esc(namesOf(r.staff).join(', '))}</span></div>`).join('')}
    </li>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Organisational Chart</title><style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; padding: 6px 10px; font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #111; }
  .head { text-align: center; margin-bottom: 8px; }
  .head h1 { font-size: 13px; margin: 0; letter-spacing: .06em; text-transform: uppercase; }
  .head h2 { font-size: 10.5px; margin: 2px 0 0; font-weight: 600; color: #444; letter-spacing: .05em; text-transform: uppercase; }
  .head .when { font-size: 7.5px; color: #777; margin-top: 3px; }
  .scale { transform-origin: top center; width: 1046px; margin: 0 auto; }
  .box { border: 1px solid #99a1ae; border-top: 2.5px solid #666; border-radius: 4px; background: #fff; padding: 4px 7px; text-align: center; display: flex; flex-direction: column; gap: 1px; }
  .box .title { font-size: 7.6px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; line-height: 1.25; }
  .box .names { font-size: 8.4px; font-weight: 600; line-height: 1.3; }
  .box .vacant { font-size: 8px; font-style: italic; color: #96700d; }
  .box .sub { font-size: 6.8px; color: #667; }
  .rt-management { border-top-color: ${ROLE_COLOR.management}; }
  .rt-quality { border-top-color: ${ROLE_COLOR.quality}; }
  .rt-technical { border-top-color: ${ROLE_COLOR.technical}; }
  .rt-support { border-top-color: ${ROLE_COLOR.support}; }
  .lead { width: 206px; } .lead .title { font-size: 8.6px; } .lead .names { font-size: 9.4px; }
  .deputy { width: 206px; }
  .lead-col { display: flex; flex-direction: column; align-items: center; }
  .lead-col .vline { width: 1px; height: 16px; background: #8b93a3; }
  .band { display: grid; grid-template-columns: 1fr 1px 1fr; align-items: stretch; }
  .band-center { display: flex; justify-content: center; }
  .band-center .stem { width: 1px; height: 100%; background: #8b93a3; }
  .side { display: flex; flex-direction: column; justify-content: center; gap: 9px; padding: 12px 0; }
  .slot { display: flex; align-items: center; }
  .slot .arm { flex: 1; height: 1px; background: #8b93a3; }
  .side-left .slot { justify-content: flex-start; } .side-left .box { width: 162px; }
  .side-right .slot { justify-content: flex-end; } .side-right .box { width: 162px; }
  ul.units { list-style: none; margin: 0; padding: 16px 0 0; display: flex; justify-content: center; position: relative; }
  ul.units::before { content: ''; position: absolute; top: 0; left: 50%; width: 1px; height: 8px; background: #8b93a3; }
  li.unit { position: relative; padding: 14px 5px 0; display: flex; flex-direction: column; width: 162px; }
  li.unit > .box { min-height: 40px; justify-content: center; }
  li.unit::before { content: ''; position: absolute; top: 6px; left: 50%; width: 1px; height: 8px; background: #8b93a3; }
  li.unit::after { content: ''; position: absolute; top: 6px; left: 0; right: 0; height: 1px; background: #8b93a3; }
  li.unit:first-child::after { left: 50%; } li.unit:last-child::after { right: 50%; }
  li.unit:only-child::after { display: none; }
  .cadre { border: 1px solid #c3c9d4; border-top: 0; background: #fafbfd; padding: 3px 6px; text-align: center; }
  .cadre:last-child { border-radius: 0 0 4px 4px; }
  .cadre .cl { display: block; font-size: 6.6px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
  .cadre .cn { display: block; font-size: 7.6px; line-height: 1.35; }
  </style></head><body>
  <div class="head">
    <h1>${esc(model.facility)}</h1>
    <h2>Laboratory Organisational Structure</h2>
    <div class="when">Printed ${esc(printedAt)}</div>
  </div>
  <div class="scale" id="scale">
    <div class="lead-col">
      ${model.manager ? printBox(model.manager, 'lead') : ''}
      <span class="vline"></span>
      ${model.deputy ? printBox(model.deputy, 'deputy') : ''}
    </div>
    <div class="band">
      <div class="side side-left">${left.map(o => `<div class="slot">${printBox(o, 'officer')}<span class="arm"></span></div>`).join('')}</div>
      <div class="band-center"><span class="stem"></span></div>
      <div class="side side-right">${right.map(o => `<div class="slot"><span class="arm"></span>${printBox(o, 'officer')}</div>`).join('')}</div>
    </div>
    ${units ? `<ul class="units">${units}</ul>` : ''}
  </div>
  <script>window.onload = function () {
    /* One A4 landscape page at 8mm margins, less the heading: the sheet is
       scaled to that box so it prints the same from any screen. */
    var el = document.getElementById('scale');
    var availW = 1046, availH = 650;
    var s = Math.max(0.4, Math.min(1.7, availW / Math.max(1, el.scrollWidth), availH / Math.max(1, el.scrollHeight)));
    el.style.transform = 'scale(' + s + ')';
    el.style.height = (el.scrollHeight * s) + 'px';
    setTimeout(function () { window.print(); }, 150);
  };</script>
  </body></html>`;
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
// Widescreen view — the chart on its own, in a window the reader can resize.
// -------------------------------------------------------------------------
function Widescreen({ model, onClose, onOpenStaff }: { model: OrgChartModel; onClose: () => void; onOpenStaff?: (id: number) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  const [zoom, setZoom] = useState(1);
  return <div className="oc-wide-overlay" onClick={onClose}>
    <div className="oc-wide" onClick={e => e.stopPropagation()}>
      <div className="oc-wide-head">
        <strong>{model.facility} — Laboratory Organisational Structure</strong>
        <div className="oc-tools">
          <div className="oc-zoom">
            <button type="button" title="Zoom out" onClick={() => setZoom(z => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}><Minus size={13} /></button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" title="Zoom in" onClick={() => setZoom(z => Math.min(2, Math.round((z + 0.1) * 10) / 10))}><Plus size={13} /></button>
          </div>
          <button type="button" className="oc-wide-close" onClick={onClose} title="Close"><X size={16} /></button>
        </div>
      </div>
      <div className="oc-wide-body">
        <div className="oc-scale" style={{ zoom } as React.CSSProperties}>
          <OrgChartSheet model={model} onOpenStaff={onOpenStaff} />
        </div>
      </div>
    </div>
  </div>;
}

// -------------------------------------------------------------------------
// The framed chart: zoom, fit, widescreen and print around the sheet.
// -------------------------------------------------------------------------
export function OrgChartBoard({ model, onSelectRole, onOpenStaff, selectedId, actions, aside, onPrintError, emptyText = 'No positions on the organogram yet.' }: {
  model: OrgChartModel | null;
  onSelectRole?: (positionId: number) => void;
  onOpenStaff?: (id: number) => void;
  selectedId?: number | null;
  actions?: ReactNode;
  aside?: ReactNode;
  onPrintError?: (m: string) => void;
  emptyText?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [wide, setWide] = useState(false);
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
    if (!model) return;
    const w = window.open('', '_blank', 'width=1180,height=840');
    if (!w) { onPrintError?.('Allow pop-ups to print the organogram.'); return; }
    w.document.write(organogramPrintHtml(model));
    w.document.close();
  }

  const empty = !model || (!model.manager && !model.deputy && model.officers.length === 0 && model.units.length === 0);

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
        <button type="button" className="secondary" disabled={empty} onClick={() => setWide(true)}><Maximize2 size={14} /> Widescreen</button>
        <button type="button" className="secondary" disabled={empty} onClick={print}><Printer size={14} /> Print</button>
      </div>
    </div>
    <div className="oc-frame">
      <div className="oc-viewport" ref={viewportRef}>
        <div className="oc-scale" ref={chartRef} style={{ zoom } as React.CSSProperties}>
          {empty ? <p className="hint" style={{ padding: 24 }}>{emptyText}</p>
            : <OrgChartSheet model={model!} onSelectRole={onSelectRole} onOpenStaff={onOpenStaff} selectedId={selectedId} />}
        </div>
      </div>
      {aside}
    </div>
    {wide && model && <Widescreen model={model} onClose={() => setWide(false)} onOpenStaff={onOpenStaff} />}
  </div>;
}
