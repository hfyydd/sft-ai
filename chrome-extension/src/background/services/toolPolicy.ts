import { skillStore } from '@extension/storage';

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
}

const MANDATORY_TOOLS = new Set(['done', 'ask_user']);
const HIGH_IMPACT = new Set([
  'click_element',
  'close_tab',
  'input_text',
  'select_dropdown_option',
  'send_keys',
  'go_to_url',
  'open_tab',
  'search_google',
  'fill_form',
]);

export class ToolPolicy {
  private readonly allowed: Set<string> | null;

  constructor(allowed?: Set<string> | null) {
    this.allowed = allowed ?? null;
  }

  decide(name: string): ToolPolicyDecision {
    if (MANDATORY_TOOLS.has(name)) return { allowed: true, reason: 'mandatory_control_tool' };
    if (!this.allowed) return { allowed: true, reason: 'default' };
    return this.allowed.has(name)
      ? { allowed: true, reason: 'skill_allowed' }
      : { allowed: false, reason: 'skill_tool_not_allowed' };
  }

  isHighImpact(name: string): boolean {
    return HIGH_IMPACT.has(name);
  }
}

export async function buildToolPolicy(skillIds: string[] = []): Promise<ToolPolicy> {
  const skills = await skillStore.getSkills();
  const selected = skills.filter(skill => skill.enabled && (skill.mode === 'always' || skillIds.includes(skill.id)));
  const lists = selected
    .map(skill => skill.allowedTools)
    .filter((value): value is string[] => Array.isArray(value));

  if (!lists.length) return new ToolPolicy();
  const intersection = lists.reduce((acc, list) => new Set([...acc].filter(tool => list.includes(tool))));
  return new ToolPolicy(intersection);
}
