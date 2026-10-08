import React from 'react';
export interface EvidenceItem { id:string; source:string; url:string; title:string; capturedAt:string; pageNumber?:number; }
export function EvidenceList({items}:{items:EvidenceItem[]}){return <section className="rounded border p-2 text-xs"><div className="mb-1 font-semibold">证据来源</div>{items.map(e=><div key={e.id} className="border-b py-1 last:border-0"><div>{e.title||e.url}</div><div className="text-zinc-500">{e.source} · {e.pageNumber ? '第'+e.pageNumber+'页 · ' : ''}{new Date(e.capturedAt).toLocaleString()}</div></div>)}</section>;}
