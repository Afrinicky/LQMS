import { useEffect, useState } from 'react';
import { api } from '../services/api';

type LinkRow = {
  id: number;
  source_module_key: string;
  source_record_type: string;
  source_record_id: string;
  target_module_key: string;
  target_record_type: string;
  target_record_id: string;
  notes?: string | null;
  created_at: string;
};

type LinkedView = { outgoing: LinkRow[]; incoming: LinkRow[] };

export function LinkedRecordsPanel({ moduleKey, recordType, recordId, title }: { moduleKey: string; recordType: string; recordId: string | number; title?: string }) {
  const [data, setData] = useState<LinkedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams({ module_key: moduleKey, record_type: recordType, record_id: String(recordId) });
    api<LinkedView>(`/common/linked-records?${params.toString()}`).then(setData).catch(e => setError((e as Error).message));
  }, [moduleKey, recordType, recordId]);
  if (error) return <div className="card"><h4>{title ?? 'Linked records'}</h4><p className="error">{error}</p></div>;
  if (!data) return <div className="card"><h4>{title ?? 'Linked records'}</h4><p>Loading…</p></div>;
  const renderRow = (l: LinkRow, direction: 'outgoing' | 'incoming') => {
    const target = direction === 'outgoing' ? { module: l.target_module_key, type: l.target_record_type, id: l.target_record_id } : { module: l.source_module_key, type: l.source_record_type, id: l.source_record_id };
    return <tr key={`${direction}-${l.id}`}><td>{target.module}</td><td>{target.type}</td><td>{target.id}</td><td>{l.notes || '—'}</td><td>{l.created_at}</td></tr>;
  };
  return <div className="card">
    <h4>{title ?? 'Linked records'}</h4>
    {data.outgoing.length === 0 && data.incoming.length === 0 && <p>No cross-module links recorded.</p>}
    {data.outgoing.length > 0 && <>
      <h5>Outgoing links</h5>
      <table className="data-table"><thead><tr><th>Target module</th><th>Type</th><th>Id</th><th>Notes</th><th>Created</th></tr></thead><tbody>{data.outgoing.map(l => renderRow(l, 'outgoing'))}</tbody></table>
    </>}
    {data.incoming.length > 0 && <>
      <h5>Incoming links</h5>
      <table className="data-table"><thead><tr><th>Source module</th><th>Type</th><th>Id</th><th>Notes</th><th>Created</th></tr></thead><tbody>{data.incoming.map(l => renderRow(l, 'incoming'))}</tbody></table>
    </>}
  </div>;
}
