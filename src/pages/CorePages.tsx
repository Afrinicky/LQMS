import { useEffect, useState } from 'react';
import { api } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import { useModules } from '../hooks/useModules';

type CountRow={count:number};
export function Home(){return <div className="grid"><div className="card"><h2>Home</h2><p>Welcome to SECH_LIMS by Nickland, a neutral laboratory QMS workspace designed to support daily records, evidence, personnel, actions, document control, audit trail, backups, and LAN host/client readiness alongside LHIMS/Lightwave.</p></div></div>}
export function Dashboard(){const [data,setData]=useState<Record<string,CountRow|{file_name?:string}|null>>({}); useEffect(()=>{api<Record<string,CountRow|{file_name?:string}|null>>('/dashboard').then(setData).catch(()=>undefined)},[]); const metric=(label:string,value:unknown)=><div className="card metric"><span>{label}</span><br/><strong>{String(value ?? 0)}</strong></div>; return <><h2>Main Dashboard</h2><div className="grid cols-4">{metric('Documents',(data.documents as CountRow)?.count)}{metric('Open actions',(data.actionsOpen as CountRow)?.count)}{metric('Staff records',(data.staff as CountRow)?.count)}{metric('Enabled modules',(data.modulesEnabled as CountRow)?.count)}</div><div className="grid cols-4">{metric('Equipment items',(data.equipmentItems as CountRow)?.count)}{metric('Inventory items',(data.inventoryItems as CountRow)?.count)}{metric('Monitoring records',(data.monitoringRecords as CountRow)?.count)}{metric('Safety incidents',(data.safetyIncidents as CountRow)?.count)}</div></>}
export function ModulePage({moduleKey,title,placeholder=false}:{moduleKey:string;title:string;placeholder?:boolean}){const {isEnabled}=useModules(); if(!isEnabled(moduleKey)) return <DisabledModule/>; return <div className="card"><h2>{title}</h2>{placeholder?<p>This foundation MVP intentionally provides a placeholder only. Full workflows will be built in later phases without accreditation scoring or star ratings.</p>:<p>Foundation workspace connected to the host API and audit-ready data model.</p>}</div>}
export function Documents(){return <ModulePage moduleKey="documents" title="Documents & Records"/>}
export function Organisation(){return <ModulePage moduleKey="organisation" title="Organisation & Leadership"/>}
export function Personnel(){return <ModulePage moduleKey="personnel" title="Personnel Management"/>}
