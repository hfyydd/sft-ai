import { openTaskRunDatabase } from './database';
import type { EvidenceRecord, TaskCheckpoint, TaskRun, TaskRunEvent, TaskRunSnapshot, TaskRunStatus } from './types';

const reqValue = <T>(r: IDBRequest<T>) => new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const normalizeRun = (run: TaskRun | undefined): TaskRun | undefined => run ? { ...run, skillIds: run.skillIds ?? [], lastEventSequence: run.lastEventSequence ?? 0 } : undefined;
const makeId=()=>globalThis.crypto?.randomUUID?.()??`run_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export class TaskRunStore {
  async createRun(input:{id?:string;sessionId:string;goal:string;activeTabId?:number;skillIds?:string[]}):Promise<TaskRun>{
    const run:TaskRun={id:input.id??makeId(),sessionId:input.sessionId,goal:input.goal,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),activeTabId:input.activeTabId,checkpointVersion:0,lastEventSequence:0,skillIds:input.skillIds??[]};
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('runs','readwrite');tx.objectStore('runs').add(run);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close(); return run;
  }
  async getRun(runId:string){const db=await openTaskRunDatabase();const r=await reqValue<TaskRun|undefined>(db.transaction('runs').objectStore('runs').get(runId));db.close();return normalizeRun(r);}
  async updateStatus(runId:string,status:TaskRunStatus,patch:Partial<TaskRun>={}):Promise<TaskRun>{
    const db=await openTaskRunDatabase();const run=await reqValue<TaskRun|undefined>(db.transaction('runs').objectStore('runs').get(runId));
    if(!run){db.close();throw new Error(`Unknown task run: ${runId}`);}
    const next={...run,...patch,status,updatedAt:Date.now()};
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('runs','readwrite');tx.objectStore('runs').put(next);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();return next;
  }
  async appendEvent(runId:string,type:string,payload:unknown):Promise<TaskRunEvent>{
    const db=await openTaskRunDatabase();
    const event=await new Promise<TaskRunEvent>((resolve,reject)=>{
      const tx=db.transaction(['runs','events'],'readwrite');
      const runs=tx.objectStore('runs');
      const events=tx.objectStore('events');
      const req=runs.get(runId);
      req.onsuccess=()=>{
        const run=normalizeRun(req.result as TaskRun|undefined);
        if(!run){tx.abort();reject(new Error('Unknown task run'));return;}
        const sequence=(run.lastEventSequence??0)+1;
        const e:TaskRunEvent={id:makeId(),runId,sequence,type,timestamp:Date.now(),payload};
        events.add(e);
        runs.put({...run,lastEventSequence:sequence,updatedAt:Date.now()});
      };
      tx.oncomplete=()=>{
        const sequence=JSON.parse(JSON.stringify({})); void sequence;
        // Re-read is deliberately avoided in this transaction; the object is retained below.
      };
      const previousComplete=tx.oncomplete;
      tx.oncomplete=()=>{
        // Find the newly committed tail deterministically by sequence recorded above.
        void previousComplete;
      };
      req.onerror=()=>reject(req.error);
      tx.onerror=()=>reject(tx.error??new Error('Task event append failed'));
      let created:TaskRunEvent|undefined;
      req.onsuccess=()=>{
        const run=normalizeRun(req.result as TaskRun|undefined);
        if(!run)return;
        const sequence=(run.lastEventSequence??0)+1;
        created={id:makeId(),runId,sequence,type,timestamp:Date.now(),payload};
        events.add(created);
        runs.put({...run,lastEventSequence:sequence,updatedAt:Date.now()});
      };
      tx.oncomplete=()=>created?resolve(created):reject(new Error('Task event was not created'));
    });
    db.close();return event;
  }

  async saveCheckpoint(cp:TaskCheckpoint){
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['runs','events','checkpoints','evidence'],'readwrite');const runReq=tx.objectStore('runs').get(cp.runId);
      runReq.onsuccess=()=>{const run=runReq.result as TaskRun|undefined;if(!run){tx.abort();reject(new Error('Unknown task run'));return;}
        if((run.lastEventSequence??0)<cp.sequence){tx.abort();reject(new Error('Checkpoint is ahead of event log'));return;}tx.objectStore('checkpoints').put(cp);tx.objectStore('runs').put({...run,checkpointVersion:cp.sequence,updatedAt:Date.now()});
      };tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
    });db.close();
  }
  async getCheckpoint(runId:string){const db=await openTaskRunDatabase();const r=await reqValue<TaskCheckpoint|undefined>(db.transaction('checkpoints').objectStore('checkpoints').get(runId));db.close();return r;}
  async getEvents(runId:string,after=0,limit=500):Promise<TaskRunEvent[]>{
    const db=await openTaskRunDatabase();const out=await new Promise<TaskRunEvent[]>((resolve,reject)=>{const a:TaskRunEvent[]=[];const q=db.transaction('events').objectStore('events').index('runId').openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const c=q.result;if(!c||a.length>=limit){resolve(a);return;}const e=c.value as TaskRunEvent;if(e.sequence>after)a.push(e);c.continue();};q.onerror=()=>reject(q.error);});db.close();return out;
  }
  async getEventsBefore(runId: string, beforeSequence: number, limit = 200): Promise<TaskRunEvent[]> {
    const db = await openTaskRunDatabase();
    const out = await new Promise<TaskRunEvent[]>((resolve, reject) => {
      const values: TaskRunEvent[] = [];
      const q = db.transaction('events').objectStore('events').openCursor(IDBKeyRange.bound([runId, 0], [runId, Math.max(0, beforeSequence - 1)]), 'prev');
      q.onsuccess = () => {
        const cursor = q.result;
        if (!cursor || values.length >= limit) { resolve(values.reverse()); return; }
        values.push(cursor.value as TaskRunEvent);
        cursor.continue();
      };
      q.onerror = () => reject(q.error);
    });
    db.close();
    return out;
  }

  async getSnapshot(runId:string,after=0):Promise<TaskRunSnapshot>{const run=await this.getRun(runId);if(!run)throw new Error('Unknown task run');return{run,checkpoint:await this.getCheckpoint(runId),events:await this.getEvents(runId,after)};}
  async listBySession(sessionId:string){
    const db=await openTaskRunDatabase();
    const out=await new Promise<TaskRun[]>((resolve,reject)=>{const a:TaskRun[]=[];const q=db.transaction('runs').objectStore('runs').openCursor();q.onsuccess=()=>{const cur=q.result;if(!cur){resolve(a);return;}if((cur.value as TaskRun).sessionId===sessionId)a.push(normalizeRun(cur.value)!);cur.continue();};q.onerror=()=>reject(q.error);});
    db.close();return out;
  }
  async listActiveRuns(){const db=await openTaskRunDatabase();const active=new Set<TaskRunStatus>(['queued','running','waiting_approval','waiting_user','paused','interrupted']);const out=await new Promise<TaskRun[]>((resolve,reject)=>{const a:TaskRun[]=[];const q=db.transaction('runs').objectStore('runs').openCursor();q.onsuccess=()=>{const c=q.result;if(!c){resolve(a);return;}if(active.has((c.value as TaskRun).status))a.push(normalizeRun(c.value)!);c.continue();};q.onerror=()=>reject(q.error);});db.close();return out;}
  async markInterrupted(){const runs=await this.listActiveRuns();return Promise.all(runs.filter(r=>r.status==='running').map(r=>this.updateStatus(r.id,'interrupted')));}
  async addEvidence(evidence: EvidenceRecord){
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('evidence','readwrite');tx.objectStore('evidence').put(evidence);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();
  }
  async getEvidence(runId:string,limit=200){
    const db=await openTaskRunDatabase();
    const out=await new Promise<EvidenceRecord[]>((resolve,reject)=>{const a:EvidenceRecord[]=[];const q=db.transaction('evidence').objectStore('evidence').index('runId').openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const cur=q.result;if(!cur||a.length>=limit){resolve(a);return;}a.push(cur.value);cur.continue();};q.onerror=()=>reject(q.error);});
    db.close();return out;
  }

  async listAllRuns(): Promise<TaskRun[]> {
    const db = await openTaskRunDatabase();
    const out = await new Promise<TaskRun[]>((resolve, reject) => {
      const values: TaskRun[] = [];
      const q = db.transaction('runs').objectStore('runs').openCursor();
      q.onsuccess = () => {
        const cur = q.result;
        if (!cur) { resolve(values); return; }
        values.push(normalizeRun(cur.value)!);
        cur.continue();
      };
      q.onerror = () => reject(q.error);
    });
    db.close();
    return out;
  }

  async removeAllRuns(): Promise<void> {
    const runs = await this.listAllRuns();
    for (const run of runs) await this.removeRun(run.id);
  }

  async cleanupRetention(maxTerminalRuns = 30, maxEventsPerRun = 2000, maxEvidencePerRun = 200) {
    const db=await openTaskRunDatabase();
    const terminal=new Set<TaskRunStatus>(['completed','failed','cancelled']);
    const runs=await new Promise<TaskRun[]>((resolve,reject)=>{const a:TaskRun[]=[];const q=db.transaction('runs').objectStore('runs').openCursor();q.onsuccess=()=>{const cur=q.result;if(!cur){resolve(a);return;}if(terminal.has((cur.value as TaskRun).status))a.push(normalizeRun(cur.value)!);cur.continue();};q.onerror=()=>reject(q.error);});
    db.close();
    runs.sort((a,b)=>b.updatedAt-a.updatedAt);
    for(const run of runs.slice(maxTerminalRuns)) await this.removeRun(run.id);
    for(const run of runs.slice(0,maxTerminalRuns)){
      await this.trimEvents(run.id,maxEventsPerRun);
      await this.trimEvidence(run.id,maxEvidencePerRun);
    }
  }

  private async trimEvents(runId:string,maxItems:number){
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('events','readwrite');const idx=tx.objectStore('events').index('runId');const values:IDBValidKey[]=[];const q=idx.openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const cur=q.result;if(!cur){const excess=Math.max(0,values.length-maxItems);for(let i=0;i<excess;i++)tx.objectStore('events').delete(values[i]);return;}values.push(cur.primaryKey as IDBValidKey);cur.continue();};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();
  }

  private async trimEvidence(runId:string,maxItems:number){
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('evidence','readwrite');const idx=tx.objectStore('evidence').index('runId');const values:IDBValidKey[]=[];const q=idx.openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const cur=q.result;if(!cur){const excess=Math.max(0,values.length-maxItems);for(let i=0;i<excess;i++)tx.objectStore('evidence').delete(values[i]);return;}values.push(cur.primaryKey as IDBValidKey);cur.continue();};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close();
  }

  async removeRun(runId:string){const db=await openTaskRunDatabase();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['runs','events','checkpoints','evidence'],'readwrite');tx.objectStore('runs').delete(runId);tx.objectStore('checkpoints').delete(runId);const evidence=tx.objectStore('evidence').index('runId').openCursor(IDBKeyRange.only(runId));evidence.onsuccess=()=>{const cur=evidence.result;if(cur){cur.delete();cur.continue();}};const q=tx.objectStore('events').index('runId').openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const c=q.result;if(c){c.delete();c.continue();}};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();}
}
export const taskRunStore=new TaskRunStore();
