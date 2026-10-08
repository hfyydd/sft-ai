import { openTaskRunDatabase } from './database';
import type { EvidenceRecord, TaskCheckpoint, TaskRun, TaskRunEvent, TaskRunSnapshot, TaskRunStatus } from './types';

const reqValue = <T>(r: IDBRequest<T>) => new Promise<T>((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const makeId=()=>globalThis.crypto?.randomUUID?.()??`run_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export class TaskRunStore {
  async createRun(input:{id?:string;sessionId:string;goal:string;activeTabId?:number}):Promise<TaskRun>{
    const run:TaskRun={id:input.id??makeId(),sessionId:input.sessionId,goal:input.goal,status:'queued',createdAt:Date.now(),updatedAt:Date.now(),activeTabId:input.activeTabId,checkpointVersion:0};
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction('runs','readwrite');tx.objectStore('runs').add(run);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
    db.close(); return run;
  }
  async getRun(runId:string){const db=await openTaskRunDatabase();const r=await reqValue<TaskRun|undefined>(db.transaction('runs').objectStore('runs').get(runId));db.close();return r;}
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
      const tx=db.transaction(['runs','events'],'readwrite');const runs=tx.objectStore('runs');const events=tx.objectStore('events');const g=runs.get(runId);
      g.onsuccess=()=>{const run=g.result as TaskRun|undefined;if(!run){tx.abort();reject(new Error('Unknown task run'));return;}
        const c=events.index('runId').openCursor(IDBKeyRange.only(runId),'prev');
        c.onsuccess=()=>{const last=c.result?.value as TaskRunEvent|undefined;const e={id:makeId(),runId,sequence:(last?.sequence??0)+1,type,timestamp:Date.now(),payload};events.add(e);runs.put({...run,updatedAt:Date.now()});tx.oncomplete=()=>resolve(e);};
      }; tx.onerror=()=>reject(tx.error);
    }); db.close();return event;
  }
  async saveCheckpoint(cp:TaskCheckpoint){
    const db=await openTaskRunDatabase();
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['runs','events','checkpoints','evidence'],'readwrite');const runReq=tx.objectStore('runs').get(cp.runId);
      runReq.onsuccess=()=>{const run=runReq.result as TaskRun|undefined;if(!run){tx.abort();reject(new Error('Unknown task run'));return;}
        const ev=tx.objectStore('events').index('runId').openCursor(IDBKeyRange.only(cp.runId),'prev');
        ev.onsuccess=()=>{const latest=ev.result?.value as TaskRunEvent|undefined;if((latest?.sequence??0)<cp.sequence){tx.abort();reject(new Error('Checkpoint is ahead of event log'));return;}tx.objectStore('checkpoints').put(cp);tx.objectStore('runs').put({...run,checkpointVersion:cp.sequence,updatedAt:Date.now()});};
      };tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
    });db.close();
  }
  async getCheckpoint(runId:string){const db=await openTaskRunDatabase();const r=await reqValue<TaskCheckpoint|undefined>(db.transaction('checkpoints').objectStore('checkpoints').get(runId));db.close();return r;}
  async getEvents(runId:string,after=0,limit=500):Promise<TaskRunEvent[]>{
    const db=await openTaskRunDatabase();const out=await new Promise<TaskRunEvent[]>((resolve,reject)=>{const a:TaskRunEvent[]=[];const q=db.transaction('events').objectStore('events').index('runId').openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const c=q.result;if(!c||a.length>=limit){resolve(a);return;}const e=c.value as TaskRunEvent;if(e.sequence>after)a.push(e);c.continue();};q.onerror=()=>reject(q.error);});db.close();return out;
  }
  async getSnapshot(runId:string,after=0):Promise<TaskRunSnapshot>{const run=await this.getRun(runId);if(!run)throw new Error('Unknown task run');return{run,checkpoint:await this.getCheckpoint(runId),events:await this.getEvents(runId,after)};}
  async listActiveRuns(){const db=await openTaskRunDatabase();const active=new Set<TaskRunStatus>(['queued','running','waiting_approval','waiting_user','paused','interrupted']);const out=await new Promise<TaskRun[]>((resolve,reject)=>{const a:TaskRun[]=[];const q=db.transaction('runs').objectStore('runs').openCursor();q.onsuccess=()=>{const c=q.result;if(!c){resolve(a);return;}if(active.has((c.value as TaskRun).status))a.push(c.value);c.continue();};q.onerror=()=>reject(q.error);});db.close();return out;}
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

  async removeRun(runId:string){const db=await openTaskRunDatabase();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['runs','events','checkpoints'],'readwrite');tx.objectStore('runs').delete(runId);tx.objectStore('checkpoints').delete(runId);const q=tx.objectStore('events').index('runId').openCursor(IDBKeyRange.only(runId));q.onsuccess=()=>{const c=q.result;if(c){c.delete();c.continue();}};tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();}
}
export const taskRunStore=new TaskRunStore();
