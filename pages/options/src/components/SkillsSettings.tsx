import React, { useEffect, useState } from 'react';
import { FiEdit2, FiPlus, FiTrash2, FiDownload, FiUpload, FiBookOpen } from 'react-icons/fi';
import { skillStore, STARTER_SKILLS, makeSkill } from '@extension/storage';
import type { Skill, SkillMode } from '@extension/storage';

interface SkillsSettingsProps {
  isDarkMode: boolean;
}

type EditingSkill = Skill;

const emptyDraft = (): Skill =>
  makeSkill({
    name: '',
    prompt: '',
    description: '',
    mode: 'manual',
    allowedTools: '*',
    enabled: false,
  });

export const SkillsSettings: React.FC<SkillsSettingsProps> = ({ isDarkMode }) => {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditingSkill | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const load = async () => {
      try {
        setSkills(await skillStore.getSkills());
      } catch (err) {
        console.error('Failed to load skills:', err);
      } finally {
        setLoading(false);
      }
    };
    void load();
    return skillStore.subscribe(load);
  }, []);

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.prompt.trim()) {
      setError('名称和提示词不能为空。');
      return;
    }
    setError('');
    await skillStore.upsertSkill(editing);
    setEditing(null);
  };

  const handleDelete = async (id: string) => {
    await skillStore.removeSkill(id);
    if (editing?.id === id) setEditing(null);
  };

  const handleToggle = async (skill: Skill, enabled: boolean) => {
    await skillStore.setSkillEnabled(skill.id, enabled);
  };

  const handleLoadStarters = async () => {
    await skillStore.importSkills(STARTER_SKILLS);
    setSkills(await skillStore.getSkills());
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify({ skills }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sft-ai-skills.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const incoming: Array<Partial<Skill> & Pick<Skill, 'name' | 'prompt'>> = Array.isArray(data) ? data : data.skills;
      if (!Array.isArray(incoming)) throw new Error('内容格式应为 { skills: [...] } 或数组');
      await skillStore.importSkills(incoming);
      setSkills(await skillStore.getSkills());
    } catch (err) {
      setError(`导入失败:${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const cardCls = `rounded-lg border p-4 ${
    isDarkMode ? 'border-slate-700 bg-slate-700' : 'border-gray-200 bg-gray-100'
  }`;
  const inputCls = `w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500 ${
    isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-200' : 'border-gray-300 bg-white text-gray-900'
  }`;
  const btnPrimary = `rounded-lg px-4 py-2 text-sm font-medium text-white bg-sky-600 hover:bg-sky-700 transition-colors`;
  const btnGhost = `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isDarkMode ? 'bg-slate-700 text-gray-200 hover:bg-slate-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
  }`;

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        <h2 className={`mb-2 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>技能</h2>
        <p className={`mb-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          技能是可复用的指令,会注入到 agent 的系统提示中。<b>常驻</b>技能对每个任务生效;<b>手动</b>技能保留备用,
          会话内可选用。工具白名单由执行器强制生效，且任何 Skill 都不能放宽全局 URL 策略或高影响动作审批。
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          <button className={btnPrimary} onClick={() => setEditing(emptyDraft())}>
            <span className="flex items-center gap-1">
              <FiPlus /> 添加技能
            </span>
          </button>
          <button className={btnGhost} onClick={handleLoadStarters}>
            <span className="flex items-center gap-1">
              <FiBookOpen /> 加载内置技能包
            </span>
          </button>
          <button className={btnGhost} onClick={handleExport}>
            <span className="flex items-center gap-1">
              <FiDownload /> 导出 JSON
            </span>
          </button>
          <label className={`${btnGhost} cursor-pointer`}>
            <span className="flex items-center gap-1">
              <FiUpload /> 导入 JSON
            </span>
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>

        {error && <p className={`mb-3 text-sm ${isDarkMode ? 'text-red-400' : 'text-red-600'}`}>{error}</p>}

        {editing && (
          <div className={`${cardCls} mb-6 space-y-3`}>
            <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              {skills.some(s => s.id === editing.id) ? '编辑技能' : '新建技能'}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`mb-1 block text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>名称</label>
                <input
                  className={inputCls}
                  value={editing.name}
                  onChange={e => setEditing({ ...editing, name: e.target.value })}
                  placeholder="例如:自动填表"
                />
              </div>
              <div>
                <label className={`mb-1 block text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>模式</label>
                <select
                  className={inputCls}
                  value={editing.mode}
                  onChange={e => setEditing({ ...editing, mode: e.target.value as SkillMode })}>
                  <option value="manual">手动(按会话选用)</option>
                  <option value="always">常驻(注入每个任务)</option>
                </select>
              </div>
            </div>
            <div>
              <label className={`mb-1 block text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>描述</label>
              <input
                className={inputCls}
                value={editing.description}
                onChange={e => setEditing({ ...editing, description: e.target.value })}
                placeholder="这个技能用来做什么?"
              />
            </div>
            <div>
              <label className={`mb-1 block text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                提示词(注入到系统提示)
              </label>
              <textarea
                className={`${inputCls} min-h-[140px]`}
                value={editing.prompt}
                onChange={e => setEditing({ ...editing, prompt: e.target.value })}
                placeholder="技能生效时 agent 需要遵循的指令…"
              />
            </div>
            <div>
              <label className={`mb-1 block text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                工具白名单(逗号分隔,留空 = 全部工具;高风险动作仍需单独审批)
              </label>
              <input
                className={inputCls}
                value={editing.allowedTools === '*' ? '' : editing.allowedTools.join(', ')}
                onChange={e => {
                  const raw = e.target.value.trim();
                  setEditing({
                    ...editing,
                    allowedTools:
                      raw === ''
                        ? '*'
                        : raw
                            .split(',')
                            .map(x => x.trim())
                            .filter(Boolean),
                  });
                }}
                placeholder="click、type_text、scroll …"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button className={btnPrimary} onClick={handleSave}>
                保存
              </button>
              <button className={btnGhost} onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>加载中…</p>
        ) : skills.length === 0 ? (
          <p className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            还没有技能。手动添加,或一键加载内置技能包。
          </p>
        ) : (
          <div className="space-y-3">
            {skills.map(skill => (
              <div key={skill.id} className={cardCls}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-medium ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                        {skill.name}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs ${
                          skill.mode === 'always'
                            ? 'bg-emerald-500/20 text-emerald-500'
                            : isDarkMode
                              ? 'bg-slate-600 text-gray-300'
                              : 'bg-gray-300 text-gray-700'
                        }`}>
                        {skill.mode === 'always' ? '常驻' : '手动'}
                      </span>
                      <span className="rounded bg-slate-500/10 px-2 py-0.5 text-xs text-slate-500">
                        v{skill.version ?? 1}
                      </span>
                      {!skill.enabled && (
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                          未启用
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                        {skill.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="relative inline-block w-12 select-none">
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={e => void handleToggle(skill, e.target.checked)}
                        className="sr-only"
                        id={`skill-enabled-${skill.id}`}
                      />
                      <label
                        htmlFor={`skill-enabled-${skill.id}`}
                        className={`block h-6 cursor-pointer overflow-hidden rounded-full ${
                          skill.enabled ? 'bg-blue-500' : isDarkMode ? 'bg-gray-600' : 'bg-gray-300'
                        }`}>
                        <span
                          className={`block size-6 rounded-full bg-white shadow transition-transform ${
                            skill.enabled ? 'translate-x-6' : 'translate-x-0'
                          }`}
                        />
                      </label>
                    </div>
                    <button
                      className={`rounded p-2 hover:bg-sky-500/20`}
                      title="编辑"
                      onClick={() => setEditing(skill)}>
                      <FiEdit2 className={isDarkMode ? 'text-gray-300' : 'text-gray-600'} />
                    </button>
                    <button
                      className={`rounded p-2 hover:bg-red-500/20`}
                      title="删除"
                      onClick={() => void handleDelete(skill.id)}>
                      <FiTrash2 className={isDarkMode ? 'text-gray-300' : 'text-gray-600'} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
