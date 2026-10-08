import { skillStore } from '@extension/storage';

export interface ToolPolicyDecision { allowed:boolean; reason:string; }
const HIGH_IMPACT=new Set(['click_element','close_tab','input_text','select_dropdown_option','send_keys','go_to_url','open_tab','fill_form']);
export class ToolPolicy {
  constructor(private readonly allowed:Set<string>|null=null){}
  decide(name:string):ToolPolicyDecision{if(!this.allowed)return{allowed:true,reason:'default'};return this.allowed.has(name)?{allowed:true,reason:'skill_allowed'}:{allowed:false,reason:'skill_tool_not_allowed'};}
  isHighImpact(name:string){return HIGH_IMPACT.has(name);}
}
export async function buildToolPolicy(skillIds:string[]=[]){
  const skills=await skillStore.getSkills();const selected=skills.filter(s=>s.enabled&&(s.mode==='always'||skillIds.includes(s.id)));
  const lists=selected.map(s=>s.allowedTools).filter((x):x is string[]=>x!=='*');
  return new ToolPolicy(intersectToolLists(selected.map(s => s.allowedTools)));
}

export function intersectToolLists(lists: Array<string[] | '*'>): Set<string> | null {
  const explicit = lists.filter((list): list is string[] => list !== '*');
  if (!explicit.length) return null;
  return explicit.reduce(
    (current, list) => new Set([...current].filter(name => list.includes(name))),
    new Set(explicit[0]),
  );
}
