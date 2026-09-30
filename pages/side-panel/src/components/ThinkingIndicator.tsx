import { useEffect, useState } from 'react';

/** 任务运行中的趣味状态文案(原创,风格参考主流 agent 产品的过程提示) */
const PHRASES = [
  '正在烧水,馅料马上下锅',
  '翻页面翻得飞起,别催',
  '正在和表单斗智斗勇',
  '按钮们已经排好队了',
  '眼睛扫过整页,在找重点',
  '深呼吸,规划最佳路线',
  '小本本记下关键信息',
  '浏览器暂时归我指挥',
  '正在把数据一颗颗装进口袋',
  '页面的角落都替你看过了',
  '脑内风暴中,思路正在收敛',
  '把大任务切成小块逐个击破',
  '回忆一下工作记忆里有什么',
  '链接、按钮、输入框,逐一确认',
  '最后一步,打磨细节中',
];

/** 运行中的状态行:「思考中 | <轮换文案>」 */
export default function ThinkingIndicator({ isDarkMode = false }: { isDarkMode?: boolean }) {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * PHRASES.length));

  useEffect(() => {
    const timer = setInterval(() => setIdx(i => (i + 1) % PHRASES.length), 2800);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center gap-2 py-1" aria-live="polite">
      <span
        className={`inline-block size-1.5 shrink-0 animate-pulse rounded-full ${
          isDarkMode ? 'bg-zinc-500' : 'bg-zinc-400'
        }`}
      />
      <span className={`text-xs font-medium ${isDarkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>思考中</span>
      <span className={`h-3 w-px ${isDarkMode ? 'bg-zinc-700' : 'bg-zinc-300'}`} />
      <span
        className={`text-xs transition-opacity duration-300 ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}
        key={idx}>
        {PHRASES[idx]}
      </span>
    </div>
  );
}
