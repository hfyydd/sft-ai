import { taskRunStore, type PendingAction } from '@extension/storage';

type Resolver = (approved:boolean)=>void;
const pending = new Map<string, Resolver>();

const hash = async (value:string) => {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(v=>v.toString(16).padStart(2,'0')).join('');
};

export async function requestApproval(input:{runId:string;toolName:string;args:unknown;tabId?:number;url?:string;reason?:string}){
  const nonce=crypto.randomUUID();
  const argsSummary=JSON.stringify(input.args);
  const parameterHash=await hash(argsSummary);
  const action:PendingAction={runId:input.runId,toolName:input.toolName,argsSummary,input.tabId,url:input.url,expiresAt:Date.now()+5*60_000,nonce,parameterHash};
  await taskRunStore.updateStatus(input.runId,'waiting_approval');
  await taskRunStore.appendEvent(input.runId,'approval.requested',{...action,reason:input.reason});
  return new Promise<boolean>(resolve=>pending.set(nonce,resolve));
}

export async function resolveApproval(input:{runId:string;nonce:string;approved:boolean;parameterHash:string}){
  const run=await taskRunStore.getRun(input.runId);
  if(!run||run.status!=='waiting_approval') return false;
  const resolve=pending.get(input.nonce);
  if(!resolve) return false;
  const cp=await taskRunStore.getCheckpoint(input.runId);
  const action=cp?.pendingAction;
  if(!action||action.nonce!==input.nonce||action.parameterHash!==input.parameterHash||action.expiresAt<Date.now()) return false;
  pending.delete(input.nonce);
  await taskRunStore.appendEvent(input.runId,input.approved?'approval.approved':'approval.rejected',{nonce:input.nonce});
  await taskRunStore.updateStatus(input.runId,input.approved?'running':'cancelled');
  resolve(input.approved);
  return true;
}
