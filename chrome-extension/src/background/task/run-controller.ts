import { taskRunStore, type TaskRun, type TaskRunStatus } from '@extension/storage';
import type { Executor } from '../agent/executor';
import type { AgentEvent } from '../agent/event/types';

const TERMINAL=new Set<TaskRunStatus>(['completed','failed','cancelled']);

export class RunController {
  private executor:Executor|null=null;
  private activeRunId:string|null=null;
  private factory:((run:TaskRun)=>Promise<Executor>)|null=null;
  private subscribers = new Set<(event: AgentEvent) => Promise<void> | void>();

  configure(factory:(run:TaskRun)=>Promise<Executor>){this.factory=factory;}
  subscribe(callback:(event:AgentEvent)=>Promise<void>|void){this.subscribers.add(callback);return()=>this.subscribers.delete(callback);}

  async initialize(){
    const active=await taskRunStore.listActiveRuns();
    for(const run of active.filter(r=>r.status==='running')) await taskRunStore.updateStatus(run.id,'interrupted');
  }

  async createAndStart(input:{runId:string;sessionId:string;goal:string;tabId:number;createExecutor:(run:TaskRun)=>Promise<Executor>}){
    if(this.activeRunId) throw new Error('Another task is already active');
    const run=await taskRunStore.createRun({id:input.runId,sessionId:input.sessionId,goal:input.goal,activeTabId:input.tabId});
    this.factory=input.createExecutor;
    return this.start(run);
  }

  async start(run:TaskRun){
    if(this.activeRunId&&this.activeRunId!==run.id) throw new Error('Another task is already active');
    if(!this.factory) throw new Error('RunController executor factory is not configured');
    this.activeRunId=run.id;
    this.executor=await this.factory(run);
    this.executor.subscribeExecutionEvents(event=>this.onEvent(run,event));
    await taskRunStore.updateStatus(run.id,'running');
    void this.executor.execute();
    return run;
  }

  private async onEvent(run:TaskRun,event:AgentEvent){
    const persisted=await taskRunStore.appendEvent(run.id,event.state,{actor:event.actor,data:event.data,timestamp:event.timestamp});
    for(const subscriber of this.subscribers) await subscriber(event);
    if(event.state==='task.pause') await taskRunStore.updateStatus(run.id,'paused');
    else if(event.state==='task.cancel') await taskRunStore.updateStatus(run.id,'cancelled');
    else if(event.state==='task.ok') await taskRunStore.updateStatus(run.id,'completed');
    else if(event.state==='task.fail') await taskRunStore.updateStatus(run.id,'failed');
    else if(event.state==='task.start') await taskRunStore.updateStatus(run.id,'running');
    if(!TERMINAL.has((await taskRunStore.getRun(run.id))?.status as TaskRunStatus)) {
      await taskRunStore.saveCheckpoint({runId:run.id,sequence:persisted.sequence,plan:[],completedStepIds:[],memory:[],evidenceIds:[],activeTabId:run.activeTabId});
    }
  }

  async pause(){if(this.executor) await this.executor.pause();}
  async resume(){if(this.executor) await this.executor.resume();}
  async cancel(){if(this.executor) await this.executor.cancel();}
  getExecutor(){return this.executor;}
  getRunId(){return this.activeRunId;}

  async snapshot(runId:string,afterSequence=0){return taskRunStore.getSnapshot(runId,afterSequence);}

  async recover(runId:string){
    const run=await taskRunStore.getRun(runId); if(!run) throw new Error('Unknown task run');
    if(run.status!=='interrupted'&&run.status!=='paused') throw new Error('Run is not recoverable');
    if(!this.factory) throw new Error('RunController executor factory is not configured');
    this.activeRunId=run.id; this.executor=await this.factory(run);
    this.executor.subscribeExecutionEvents(event=>this.onEvent(run,event));
    await taskRunStore.updateStatus(run.id,'running');
    void this.executor.execute();
  }

  clearIfTerminal(){
    if(this.executor&&this.activeRunId) return taskRunStore.getRun(this.activeRunId).then(run=>{
      if(run&&TERMINAL.has(run.status)){this.executor=null;this.activeRunId=null;}
    });
  }
}

export const runController=new RunController();
