import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, Bot, FileSearch, RefreshCw, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { api } from '../services/api';
import { DENNIS_NOTICE, dennisSafetyRules } from '../services/dennisService';

const tabs = ['Ask Dennis','Document Search','CAPA Helper','Audit Helper','Report Writer','Quality Indicator Analyst','Training Helper','Blood Bank Quality Assistant','Risk Assistant','Equipment Assistant','Inventory and Supplier Assistant','Dennis Alerts','Dennis Activity Log','Dennis Settings'] as const;
type Tab = typeof tabs[number];

// Tab -> (module key, [label, task] buttons) for the module helpers.
const HELPERS: Record<string, { module: string; buttons: Array<[string, string]> }> = {
  'CAPA Helper': { module: 'nc_capa', buttons: [['Improve NC Description','improve_nc'],['Suggest Root Causes','root_causes'],['Suggest Corrective Action','corrective_action'],['Suggest Preventive Action','preventive_action'],['Draft Follow-up Plan','follow_up'],['Suggest Effectiveness Check','effectiveness'],['Summarize CAPA','summarize']] },
  'Audit Helper': { module: 'assessments', buttons: [['Suggest Audit Questions','audit_questions'],['Suggest Evidence to Check','audit_evidence'],['Word a Finding','finding_wording'],['Draft Audit Report Section','report'],['Suggest Corrective Action','corrective_action']] },
  'Training Helper': { module: 'personnel', buttons: [['Explain SOP Simply','explain_sop'],['Generate Quiz','quiz'],['Suggest Competency Questions','audit_questions'],['Draft Training Summary','summarize'],['Identify Training Gaps','summarize']] },
  'Blood Bank Quality Assistant': { module: 'blood_bank_handover', buttons: [['Summarize Expiring Blood Units','summarize'],['Draft Thursday-to-Thursday Handover','report'],['Summarize Adverse Donor Reactions','summarize'],['Draft Blood Bank NC','improve_nc'],['Draft Monthly Blood Bank Quality Report','report']] },
  'Risk Assistant': { module: 'risks', buttons: [['Suggest Risks','risk_suggest'],['Suggest Causes','risk_suggest'],['Suggest Controls','risk_suggest'],['Suggest Mitigation Actions','corrective_action'],['Draft Risk Summary','summarize']] },
  'Equipment Assistant': { module: 'equipment', buttons: [['Summarize Calibration Due','summarize'],['Draft Breakdown Report','report'],['Summarize Downtime','summarize'],['Draft Replacement Justification','report'],['Suggest PM Follow-up','follow_up']] },
  'Inventory and Supplier Assistant': { module: 'supplier_inventory', buttons: [['Summarize Stock-out Risk','summarize'],['Summarize Expiry Alerts','summarize'],['Draft Purchase Justification','report'],['Draft Supplier Complaint','improve_nc'],['Summarize Supplier Performance','summarize']] },
};

type AskSource = { title: string; documentCode: string | null; version: string | null; section: string | null; sourceDocumentId: number | null; status: string | null; excerpt: string };

function Notice() { return <div className="dennis-notice"><ShieldCheck size={14}/>{DENNIS_NOTICE}</div>; }
function SafetyPanel(){ return <div className="card"><h3><Bot size={18}/> Dennis safety workflow</h3>{dennisSafetyRules.map(r=><p className="safety-rule" key={r}>{r}</p>)}</div>; }

function SourceList({ sources }: { sources: AskSource[] }) {
  if (!sources?.length) return null;
  return <div className="source-box"><strong>Sources</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
    {sources.map((s, i) => <li key={i}>{s.title}{s.documentCode ? ` (${s.documentCode})` : ''}{s.version ? `, v${s.version}` : ''}{s.section ? ` · ${s.section}` : ''} {s.status ? <span className="badge">{s.status}</span> : null}</li>)}
  </ul></div>;
}

function AskDennis() {
  type Msg = { role: 'user' | 'dennis'; content: string; sources?: AskSource[] };
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowOnline, setAllowOnline] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([{ role: 'dennis', content: 'Hello, I am Dennis. Ask me a quality question and I will search the laboratory’s approved documents and answer with sources.' }]);

  async function send() {
    const q = input.trim(); if (!q || busy) return;
    setMessages(m => [...m, { role: 'user', content: q }]); setInput(''); setBusy(true);
    try {
      let res = await api<{ answer: string; sources: AskSource[]; mode: string }>('/dennis/ask', { method: 'POST', body: JSON.stringify({ question: q, allowOnline }) });
      if (res.answer === 'CONFIRM_ONLINE') {
        if (window.confirm('Dennis is about to send redacted information to an online AI provider. Do not include patient names, patient IDs, donor IDs, phone numbers, addresses, or confidential personal information. Continue?')) {
          res = await api('/dennis/ask', { method: 'POST', body: JSON.stringify({ question: q, allowOnline: true, confirmed: true }) });
        } else { setBusy(false); setMessages(m => [...m, { role: 'dennis', content: 'Online request cancelled. Staying offline.' }]); return; }
      }
      setMessages(m => [...m, { role: 'dennis', content: res.answer, sources: res.sources }]);
    } catch (e) { setMessages(m => [...m, { role: 'dennis', content: `Dennis could not answer: ${(e as Error).message}` }]); }
    finally { setBusy(false); }
  }

  return <div className="dennis-grid two"><div className="card dennis-chat">
    <div className="chat-stream">{messages.map((m,i)=><div key={i} className={`chat-bubble ${m.role}`}><strong>{m.role==='dennis'?'Dennis':'You'}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{m.content}</p>{m.role==='dennis' && m.content!=='' && <><SourceList sources={m.sources ?? []}/><Notice/></>}</div>)}
      {busy && <div className="chat-bubble dennis"><strong>Dennis</strong><p>Searching approved documents…</p></div>}</div>
    <div className="dennis-input">
      <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } }} placeholder="Ask Dennis a quality management question…"/>
      <button onClick={send} disabled={busy}><Send size={16}/> Send</button>
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={allowOnline} onChange={e=>setAllowOnline(e.target.checked)}/> Allow online AI (if enabled)</label>
      <button className="secondary" onClick={()=>setMessages([])}>Clear</button>
    </div></div><SafetyPanel/></div>;
}

function DocumentSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadStats = () => api('/dennis/index-stats').then(setStats).catch(()=>{});
  useEffect(() => { void loadStats(); }, []);

  async function search() {
    setBusy(true); setMsg(null);
    try {
      const params = new URLSearchParams({ q });
      if (type) params.set('documentType', type);
      if (currentOnly) params.set('currentOnly', 'true');
      const r = await api<{ results: any[] }>(`/dennis/search?${params.toString()}`);
      setResults(r.results);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function indexAll() {
    setBusy(true); setMsg(null);
    try { const r = await api<{ indexed: number; skipped: number; failed: number; total: number }>('/dennis/index-all', { method: 'POST', body: '{}' }); setMsg(`Indexed ${r.indexed}, skipped ${r.skipped}, failed ${r.failed} of ${r.total} approved/current documents.`); await loadStats(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function reindex(sourceId: number) {
    try { await api(`/dennis/index/${sourceId}`, { method: 'POST', body: '{}' }); setMsg(`Reindexed document #${sourceId}.`); await loadStats(); }
    catch (e) { setMsg((e as Error).message); }
  }

  return <div className="dennis-grid two"><div className="card">
    <h3><FileSearch size={18}/> Document Search</h3>
    {stats && <p className="muted" style={{ fontSize: 12 }}>Indexed: {stats.totalIndexed} · Chunks: {stats.chunks} · Skipped: {stats.skipped} · Failed: {stats.failed} · Not indexed: {stats.notIndexed}</p>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input style={{ flex: 1, minWidth: 220 }} value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') search(); }} placeholder="Search approved/current documents (keywords)…"/>
      <select value={type} onChange={e=>setType(e.target.value)}><option value="">All types</option>{['SOP','Policy','Manual','Form','Register','Log'].map(t=><option key={t} value={t}>{t}</option>)}</select>
      <label style={{ fontSize: 12 }}><input type="checkbox" checked={currentOnly} onChange={e=>setCurrentOnly(e.target.checked)}/> Current only</label>
      <button onClick={search} disabled={busy}>Search</button>
      <button className="secondary" onClick={indexAll} disabled={busy} title="Index all approved/current documents"><RefreshCw size={14}/> Reindex all approved</button>
    </div>
    {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    {results && results.length === 0 && <div className="dennis-output" style={{ marginTop: 12 }}><strong>No matching approved documents found.</strong><Notice/></div>}
    {results && results.length > 0 && <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {results.map((r:any,i:number)=><div className="dennis-output" key={i}>
        <strong>{r.title}{r.documentCode ? ` · ${r.documentCode}` : ''}</strong>
        <div className="chip-row" style={{ margin: '4px 0' }}>
          {r.documentType && <span className="badge">{r.documentType}</span>}
          {r.version && <span className="badge">v{r.version}</span>}
          {r.status && <span className="badge">{r.status}</span>}
          {r.sectionHeading && <span className="badge">{r.sectionHeading}</span>}
        </div>
        <p style={{ margin: '4px 0' }}>{String(r.excerpt || '').replace(/[〔〕]/g, '')}</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {r.sourceDocumentId && <button className="secondary" onClick={()=>navigate('/documents')}>Open in Documents</button>}
          {r.sourceDocumentId && <button className="secondary" onClick={()=>reindex(r.sourceDocumentId)}>Reindex</button>}
        </div>
        <Notice/>
      </div>)}
    </div>}
    {!results && <div className="dennis-output" style={{ marginTop: 12 }}>Search the laboratory’s indexed approved documents. Use <em>Reindex all approved</em> first if results are empty. Dennis only shows documents you are permitted to see.</div>}
  </div><SafetyPanel/></div>;
}

function Helper({ tab }: { tab: Tab }) {
  const cfg = HELPERS[tab];
  const [input, setInput] = useState('');
  const [recordId, setRecordId] = useState('');
  const [out, setOut] = useState<{ draft: string; sources: AskSource[]; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function run(task: string) {
    setBusy(true); setCopied(false);
    try {
      let res = await api<{ draft: string; sources: AskSource[]; mode: string }>('/dennis/helper', { method: 'POST', body: JSON.stringify({ module: cfg.module, task, inputText: input, recordId: recordId || null }) });
      if (res.draft === 'CONFIRM_ONLINE') {
        if (window.confirm('Dennis is about to send redacted information to an online AI provider. Continue?')) res = await api('/dennis/helper', { method: 'POST', body: JSON.stringify({ module: cfg.module, task, inputText: input, recordId: recordId || null, allowOnline: true, confirmed: true }) });
        else { setBusy(false); return; }
      }
      setOut(res);
    } catch (e) { setOut({ draft: `Dennis helper failed: ${(e as Error).message}`, sources: [], mode: 'error' }); }
    finally { setBusy(false); }
  }

  return <div className="dennis-grid two"><div className="card">
    <h3><Sparkles size={18}/> {tab}</h3>
    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
      <input style={{ width: 160 }} value={recordId} onChange={e=>setRecordId(e.target.value)} placeholder="Record # (optional)"/>
      <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>Link a record to ground the draft.</span>
    </div>
    <textarea value={input} onChange={e=>setInput(e.target.value)} placeholder={`Paste ${tab} notes here. Do not include patient or donor identifiers.`}/>
    <div className="button-grid">{cfg.buttons.map(([label, task])=><button key={label} disabled={busy} onClick={()=>run(task)}>{label}</button>)}</div>
    <div className="dennis-output">
      <strong>Dennis draft output {out?.mode ? `(${out.mode})` : ''}</strong>
      <p style={{ whiteSpace: 'pre-wrap' }}>{busy ? 'Dennis is drafting…' : (out?.draft || 'Select a Dennis action to generate a draft suggestion. Drafts are never auto-saved into official records.')}</p>
      {out && <><SourceList sources={out.sources}/><div style={{ display: 'flex', gap: 8 }}><button className="secondary" onClick={()=>{ navigator.clipboard?.writeText(out.draft); setCopied(true); }}>{copied ? 'Copied' : 'Copy suggestion'}</button></div></>}
      <Notice/>
    </div>
  </div><SafetyPanel/></div>;
}

function ReportWriter() {
  const reports = ['Monthly quality report','Management review input','Blood bank quality report','CAPA summary report','Internal audit report','Equipment downtime report','Complaint summary report','Training summary report','Risk summary report','Supplier performance summary'];
  const [reportType, setReportType] = useState(reports[0]);
  const [period, setPeriod] = useState('');
  const [out, setOut] = useState<{ draft: string; sources: AskSource[]; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function gen() {
    setBusy(true);
    try { const res = await api<{ draft: string; sources: AskSource[]; mode: string }>('/dennis/helper', { method: 'POST', body: JSON.stringify({ module: 'reports', task: 'report', inputText: `${reportType} for period ${period || '(unspecified)'}` }) }); setOut(res); }
    catch (e) { setOut({ draft: (e as Error).message, sources: [], mode: 'error' }); } finally { setBusy(false); }
  }
  return <div className="dennis-grid two"><div className="card"><h3>Report Writer</h3>
    <div className="form-grid">
      <select value={reportType} onChange={e=>setReportType(e.target.value)}>{reports.map(r=><option key={r}>{r}</option>)}</select>
      <input type="month" value={period} onChange={e=>setPeriod(e.target.value)}/>
    </div>
    <button onClick={gen} disabled={busy}>{busy ? 'Generating…' : 'Generate Draft'}</button>
    <div className="dennis-output"><strong>Draft report {out?.mode ? `(${out.mode})` : ''}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{out?.draft || 'Choose a report type and period, then generate a draft. Dennis produces drafts only.'}</p>{out && <><SourceList sources={out.sources}/><button className="secondary" onClick={()=>navigator.clipboard?.writeText(out.draft)}>Copy Draft</button></>}<Notice/></div>
  </div><SafetyPanel/></div>;
}

function IndicatorAnalyst() {
  const items=['Turnaround time','Sample rejection rate','EQA performance','IQC failures','Equipment downtime','Complaint trends','CAPA closure rate','Stock-outs','Blood unit expiry','Reagent expiry','Internal audit finding trends'];
  const [sel, setSel] = useState(items[0]);
  const [out, setOut] = useState<string>('');
  const [busy, setBusy] = useState(false);
  async function run() { setBusy(true); try { const r = await api<{ draft: string }>('/dennis/helper', { method: 'POST', body: JSON.stringify({ module: 'quality_indicators', task: 'summarize', inputText: `Summarise the ${sel} quality indicator. Do not change any values.` }) }); setOut(r.draft); } catch (e) { setOut((e as Error).message); } finally { setBusy(false); } }
  return <div className="card"><h3>Quality Indicator Analyst</h3><p className="muted">Dennis summarises and explains indicators — he never edits indicator values.</p>
    <div style={{ display: 'flex', gap: 8 }}><select value={sel} onChange={e=>setSel(e.target.value)}>{items.map(i=><option key={i}>{i}</option>)}</select><button onClick={run} disabled={busy}>{busy?'Summarising…':'Summarize'}</button></div>
    <div className="dennis-output" style={{ marginTop: 10 }}><strong>{sel}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{out || 'Select an indicator and click Summarize.'}</p><Notice/></div>
  </div>;
}

function Alerts() {
  const [alerts, setAlerts] = useState<any[] | null>(null);
  const navigate = useNavigate();
  useEffect(() => { api<{ alerts: any[] }>('/dennis/alerts').then(r=>setAlerts(r.alerts)).catch(()=>setAlerts([])); }, []);
  return <div className="card"><h3><Bell size={18}/> Dennis Alerts</h3>
    {!alerts && <p>Loading…</p>}
    {alerts && alerts.length === 0 && <p className="muted">No active alerts. Dennis will surface overdue CAPA, SOP reviews, calibration, expiries and pending approvals here.</p>}
    <div className="alert-grid">{(alerts ?? []).map((a,i)=><div className="alert-card" key={i}><strong>{a.title}</strong><span>Module: {a.module}</span><span className="badge">{a.priority} priority</span><span>Count: {a.count}</span><button className="secondary" onClick={()=>navigate(`/${a.module}`)}>Open module</button></div>)}</div>
  </div>;
}

function ActivityLog() {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => { api<{ rows: any[] }>('/dennis/activity-log').then(r=>setRows(r.rows)).catch(()=>setRows([])); }, []);
  return <div className="card"><h3>Dennis Activity Log</h3>
    <table><thead><tr><th>Date/time</th><th>User</th><th>Module</th><th>Task</th><th>Action</th><th>AI mode</th><th>Provider</th><th>Online?</th><th>Redacted?</th><th>Document</th><th>Status</th></tr></thead>
    <tbody>{(rows ?? []).map((r,i)=><tr key={i}><td>{String(r.dateTime||'').slice(0,19).replace('T',' ')}</td><td>{r.userName||r.userId||'—'}</td><td>{r.module}</td><td>{r.taskType||'—'}</td><td>{r.action}</td><td>{r.aiMode||'—'}</td><td>{r.provider||'—'}</td><td>{r.onlineUsed? <span className="badge warning">online</span> : <span className="badge">offline</span>}</td><td>{r.redactionApplied? 'Yes' : '—'}</td><td>{r.documentName||'—'}</td><td><span className="badge">{r.status}</span></td></tr>)}
    {rows && rows.length===0 && <tr><td colSpan={11} className="muted">No Dennis activity yet.</td></tr>}</tbody></table>
  </div>;
}

function Settings() {
  const [s, setS] = useState<Record<string,string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<Record<string,string>>({});
  const load = () => api<{ settings: Record<string,string> }>('/dennis/settings').then(r=>setS(r.settings)).catch(()=>{});
  useEffect(() => { void load(); }, []);
  if (!s) return <div className="card">Loading Dennis settings…</div>;
  const set = (k:string,v:string)=>setS({ ...s, [k]: v });
  const bool = (k:string)=>s[k]==='true';
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const payload: Record<string,string> = { ...s };
      if (apiKey) payload['dennis.online.apiKey'] = apiKey; else delete payload['dennis.online.apiKey'];
      await api('/dennis/settings', { method: 'PUT', body: JSON.stringify({ settings: payload }) });
      setApiKey(''); setMsg('Saved.'); await load();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function testConn(which:'local'|'online') {
    setTest(t=>({ ...t, [which]: 'Testing…' }));
    try { const r = await api<{ ok:boolean; detail:string }>('/dennis/test-connection', { method: 'POST', body: JSON.stringify({ which }) }); setTest(t=>({ ...t, [which]: `${r.ok?'✓':'✗'} ${r.detail}` })); }
    catch (e) { setTest(t=>({ ...t, [which]: (e as Error).message })); }
  }
  return <div className="dennis-grid two"><div className="card"><h3>Dennis Settings</h3>
    <label>AI mode<select value={s['dennis.mode']||'Hybrid recommended'} onChange={e=>set('dennis.mode', e.target.value)}>
      <option value="Offline only">Offline only — all Dennis tasks use Ollama</option>
      <option value="Hybrid recommended">Hybrid (recommended) — Ollama for everything; online AI only for uploaded SOP/document analysis</option>
      <option value="Online drafting only">Online drafting only — online AI for non-sensitive SOP/document drafting; never patient or operational records</option>
    </select></label>
    <p className="muted" style={{ marginTop: 4 }}>Ollama (offline) is the default runtime for normal chat and <strong>all operational records</strong> (NC/CAPA, audit, complaints, blood bank, staff, equipment, inventory, quality indicators, management review). Online AI is used <strong>only</strong> for SOP/document analysis, and only after redaction.</p>

    <h4 style={{ marginBottom: 4 }}>Local / offline AI (Phase DENNIS-4)</h4>
    <label><input type="checkbox" checked={bool('dennis.local.enabled')} onChange={e=>set('dennis.local.enabled', String(e.target.checked))}/> Local AI enabled</label>
    <label>Provider<select value={s['dennis.local.provider']||'ollama'} onChange={e=>set('dennis.local.provider', e.target.value)}><option value="ollama">Ollama</option><option value="custom">Custom local endpoint</option><option value="none">None</option></select></label>
    <label>Local endpoint URL<input value={s['dennis.local.endpoint']||''} onChange={e=>set('dennis.local.endpoint', e.target.value)} placeholder="http://localhost:11434"/></label>
    <label>Local chat model<input value={s['dennis.local.chatModel']||''} onChange={e=>set('dennis.local.chatModel', e.target.value)} placeholder="llama3.1"/></label>
    <label>Local embedding model<input value={s['dennis.local.embedModel']||''} onChange={e=>set('dennis.local.embedModel', e.target.value)} placeholder="nomic-embed-text"/></label>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><button className="secondary" type="button" onClick={()=>testConn('local')}>Test local connection</button><span className="badge">{test.local || 'not tested'}</span></div>

    <h4 style={{ margin: '12px 0 4px' }}>Online AI (Phase DENNIS-6 — disabled by default)</h4>
    <label><input type="checkbox" checked={bool('dennis.online.enabled')} onChange={e=>set('dennis.online.enabled', String(e.target.checked))}/> Online Dennis enabled</label>
    <label>Provider<select value={s['dennis.online.provider']||'anthropic'} onChange={e=>set('dennis.online.provider', e.target.value)}><option value="anthropic">Anthropic (Claude)</option><option value="openai">OpenAI</option><option value="custom">Custom (OpenAI-compatible)</option></select></label>
    <label>Endpoint (optional)<input value={s['dennis.online.endpoint']||''} onChange={e=>set('dennis.online.endpoint', e.target.value)} placeholder="default per provider"/></label>
    <label>Model<input value={s['dennis.online.model']||''} onChange={e=>set('dennis.online.model', e.target.value)} placeholder="claude-sonnet-4-6"/></label>
    <label>API key<input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={s['dennis.online.apiKey'] ? `Saved (${s['dennis.online.apiKey']}) — type to replace` : 'Enter API key'}/></label>
    <label><input type="checkbox" checked={s['dennis.online.confirmRequired']!=='false'} onChange={e=>set('dennis.online.confirmRequired', String(e.target.checked))}/> Require confirmation before each online AI use</label>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><button className="secondary" type="button" onClick={()=>testConn('online')}>Test online connection</button><span className="badge">{test.online || 'not tested'}</span></div>

    <div className="warning" style={{ marginTop: 12 }}><AlertTriangle size={18}/>Online AI may send document text outside the hospital network. Use only for SOPs and non-patient documents. Online AI is restricted to the SOP/document analysis tools and is <strong>never</strong> used for patient records, NC/CAPA, audit findings, complaints, blood bank, staff, equipment, inventory, quality indicators, management review or any live operational data. Dennis redacts identifiers before any online call, and blocks online use entirely when patient/operational data is detected.</div>
    <p className="muted">TODO: API keys are stored in the local SECH_LIMS database. Use OS secure storage where available in a later hardening pass.</p>
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button onClick={save} disabled={busy}>{busy?'Saving…':'Save settings'}</button>{msg && <span className="muted" style={{ alignSelf: 'center' }}>{msg}</span>}</div>
  </div><SafetyPanel/></div>;
}

export function DennisPage(){
  const [tab,setTab]=useState<Tab>('Ask Dennis');
  const body=useMemo(()=>{
    if(tab==='Ask Dennis')return <AskDennis/>;
    if(tab==='Document Search')return <DocumentSearch/>;
    if(tab==='Report Writer')return <ReportWriter/>;
    if(tab==='Quality Indicator Analyst')return <IndicatorAnalyst/>;
    if(tab==='Dennis Alerts')return <Alerts/>;
    if(tab==='Dennis Activity Log')return <ActivityLog/>;
    if(tab==='Dennis Settings')return <Settings/>;
    return <Helper tab={tab}/>;
  },[tab]);
  return <div className="page dennis-page"><div className="page-header"><div><p className="eyebrow">Documents and Records</p><h2>Dennis</h2><p>Dennis helps you search approved documents, explain, draft, suggest, summarize and remind — with sources. He is an assistant, not a final decision-maker.</p></div></div>
    <div className="tabbar dennis-tabs">{tabs.map(t=><button className={tab===t?'active':''} key={t} onClick={()=>setTab(t)}>{t}</button>)}</div>{body}</div>;
}
