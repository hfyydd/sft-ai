import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/**
 * Skill = a reusable instruction module injected into the agents' system prompts.
 * - 'always' skills are appended to every task's system prompt.
 * - 'manual' skills are stored for per-conversation selection (UI support planned).
 * - allowedTools reserves a per-skill tool whitelist for the executor (enforcement planned).
 */
export type SkillMode = 'always' | 'manual';

export interface Skill {
  id: string;
  name: string;
  description: string;
  mode: SkillMode;
  prompt: string;
  allowedTools: string[] | '*';
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export function newSkillId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `skill_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

export function makeSkill(partial: Partial<Skill> & Pick<Skill, 'name' | 'prompt'>): Skill {
  const now = Date.now();
  return {
    id: partial.id ?? newSkillId(),
    name: partial.name,
    description: partial.description ?? '',
    mode: partial.mode ?? 'manual',
    prompt: partial.prompt,
    allowedTools: partial.allowedTools ?? '*',
    enabled: partial.enabled ?? false,
    createdAt: partial.createdAt ?? now,
    updatedAt: now,
    version: partial.version ?? 1,
  };
}

// Starter skills shipped with the internal build. Users can load them from the
// Skills settings tab; loading skips skills whose name already exists.
export const STARTER_SKILLS: Array<Partial<Skill> & Pick<Skill, 'name' | 'prompt'>> = [
  {
    name: '页面摘要',
    description: '总结当前页面时的输出格式约定',
    mode: 'manual',
    allowedTools: ['read_page','cache_content','scroll_to_percent','scroll_to_top','scroll_to_bottom','previous_page','next_page','scroll_to_text','ask_user'],
    prompt:
      '总结当前页面时:先给出 3 句话以内的概述,再列出关键要点(最多 8 条),最后单独列出页面中的硬信息(数字、日期、金额、状态)。使用与页面内容相同的语言输出。',
  },
  {
    name: '表格提取',
    description: '采集页面表格数据时的格式与翻页约定',
    mode: 'manual',
    allowedTools: ['read_page','get_dropdown_options','scroll_to_percent','scroll_to_top','scroll_to_bottom','previous_page','next_page'],
    prompt:
      '提取表格数据时:输出为 Markdown 表格并保留原始列名;金额、日期保持页面原格式;空单元格用 — 表示。如果数据分布在多页,先采集当前页并告知用户可以让你继续翻页采集。',
  },
  {
    name: '自动填表',
    description: '表单填报的安全流程约定',
    mode: 'manual',
    allowedTools: ['read_page','input_text','click_element','get_dropdown_options','select_dropdown_option','ask_user'],
    prompt:
      '填写表单时:先列出你识别到的全部表单字段以及计划填入的值,经用户确认后再执行;提交/保存/下一步等提交类按钮,必须在点击前再次向用户确认。填写值只能来自用户消息或页面已有数据,不得编造;缺失字段标记为待确认而不是乱填。',
  },
  {
    name: '翻页采集',
    description: '多页采集的进度与终止约定',
    mode: 'manual',
    allowedTools: ['read_page','cache_content','next_page','previous_page','scroll_to_text'],
    prompt:
      '翻页采集时:每完成一页记录进度(第 N 页);连续 2 次找不到下一页控件则视为已到末页;每次翻页必须等待新页面加载完成再采集。最终输出汇总结果并说明共采集的页数与条数。',
  },
  {
    name: '跨页任务',
    description: '多页面协同任务的执行约定(采集 → 记忆 → 切换 → 填写 → 汇总)',
    mode: 'manual',
    allowedTools: ['read_page','cache_content','switch_tab','open_tab','input_text','click_element','ask_user'],
    prompt:
      '执行跨页面任务时:1) 先在来源页面采集所需信息,并立即用 cache_content 或记忆记录关键数据;2) 切换或打开目标页面前,确认所需数据已经记录;3) 在目标页面严格依据记忆操作,不得凭空编造;4) 全部完成后,汇总说明每个页面做了什么、数据来自哪里。',
  },
  {
    name: '谨慎模式',
    description: '全局安全约束(建议设为 always 常驻)',
    mode: 'always',
    allowedTools: ['done','read_page','cache_content','wait','scroll_to_percent','scroll_to_top','scroll_to_bottom','previous_page','next_page','scroll_to_text','get_dropdown_options','input_text','click_element'],
    prompt:
      '始终谨慎操作:提交、删除、支付、发送、授权类按钮在点击前必须向用户确认;不要打开与当前任务无关的新标签页;不要在表单中填入用户未提供过的个人敏感信息。',
  },
];

export type SkillStorage = BaseStorage<{ skills: Skill[] }> & {
  getSkills: () => Promise<Skill[]>;
  upsertSkill: (skill: Skill) => Promise<void>;
  removeSkill: (id: string) => Promise<void>;
  setSkillEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Imports skills (e.g. from JSON file or starter pack); existing skills with the same id are overwritten. */
  importSkills: (skills: Array<Partial<Skill> & Pick<Skill, 'name' | 'prompt'>>) => Promise<number>;
};

const storage = createStorage<{ skills: Skill[] }>(
  'skills',
  { skills: [] },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const skillStore: SkillStorage = {
  ...storage,
  async getSkills() {
    return (await storage.get())?.skills ?? [];
  },
  async upsertSkill(skill) {
    const current = (await storage.get())?.skills ?? [];
    const idx = current.findIndex(s => s.id === skill.id);
    const next: Skill = { ...skill, updatedAt: Date.now() };
    if (idx >= 0) {
      current[idx] = next;
    } else {
      current.push({ ...next, createdAt: next.createdAt || Date.now() });
    }
    await storage.set({ skills: current });
  },
  async removeSkill(id) {
    const current = (await storage.get())?.skills ?? [];
    await storage.set({ skills: current.filter(s => s.id !== id) });
  },
  async setSkillEnabled(id, enabled) {
    const current = (await storage.get())?.skills ?? [];
    await storage.set({ skills: current.map(s => (s.id === id ? { ...s, enabled } : s)) });
  },
  async importSkills(incoming) {
    const existing = (await storage.get())?.skills ?? [];
    let count = 0;
    for (const item of incoming) {
      const match = existing.find(s => s.id === item.id || s.name === item.name);
      const skill = makeSkill({ ...item, id: match?.id ?? item.id });
      const idx = existing.findIndex(s => s.id === skill.id);
      if (idx >= 0) {
        existing[idx] = skill;
      } else {
        existing.push(skill);
      }
      count += 1;
    }
    await storage.set({ skills: existing });
    return count;
  },
};
