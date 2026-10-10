import type { Message } from '@extension/storage';
import { memo, useState } from 'react';
import ThinkingIndicator from './ThinkingIndicator';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
  /** 任务运行中:消息流底部显示轮换的「思考中」状态语 */
  running?: boolean;
}

/** 现代化消息流:用户右对齐气泡;规划=安静思考块;连续执行动作收敛为步骤组;最后一条规划消息按正式回答呈现 */
export default memo(function MessageList({ messages, isDarkMode = false, running = false }: MessageListProps) {
  const nodes: JSX.Element[] = [];
  let key = 0;
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.actor === 'navigator') {
      const group: { message: Message; failed: boolean }[] = [];
      let j = i;
      while (j < messages.length && messages[j].actor === 'navigator') {
        // 进度条消息单独渲染,不进步骤组
        if (messages[j].content === 'Showing progress...') {
          j++;
          continue;
        }
        group.push({ message: messages[j], failed: /失败|错误|failed|error|cannot/i.test(messages[j].content) });
        j++;
      }
      if (group.length === 0) {
        i = j;
        continue;
      }
      nodes.push(<NavigatorGroup key={`g${key++}`} items={group} isDarkMode={isDarkMode} />);
      i = j;
      continue;
    }
    nodes.push(
      <MessageBlock key={`m${key++}`} message={message} isLast={i === messages.length - 1} isDarkMode={isDarkMode} />,
    );
    i++;
  }
  return (
    <div className="max-w-full space-y-5">
      {nodes}
      {running && <ThinkingIndicator isDarkMode={isDarkMode} />}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isLast: boolean;
  isDarkMode?: boolean;
}

function MessageBlock({ message, isLast, isDarkMode = false }: MessageBlockProps) {
  if (!message.actor) {
    console.error('No actor found');
    return <div />;
  }
  const isProgress = message.content === 'Showing progress...';
  const isUser = message.actor === 'user';
  const isPlanner = message.actor === 'planner';

  if (isProgress) {
    return (
      <div className={`h-1 w-28 overflow-hidden rounded ${isDarkMode ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
        <div className="h-full w-1/2 animate-progress rounded bg-zinc-400" />
      </div>
    );
  }

  // 用户消息:右对齐中性气泡
  if (isUser) {
    return (
      <div className="flex max-w-full justify-end">
        <div className="max-w-[88%]">
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2.5 text-sm leading-relaxed ${
              isDarkMode ? 'bg-zinc-800 text-zinc-100' : 'bg-zinc-100 text-zinc-800'
            }`}>
            {message.content}
          </div>
          <div className={`mt-1 text-right text-[11px] ${isDarkMode ? 'text-zinc-600' : 'text-zinc-400'}`}>
            {formatTimestamp(message.timestamp)}
          </div>
        </div>
      </div>
    );
  }

  // 系统消息:居中弱化
  if (message.actor === 'system') {
    return (
      <div className={`py-1 text-center text-xs ${isDarkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
        {message.content}
      </div>
    );
  }

  // 规划消息:最后一条视为正式回答(平文、正常色),其余为安静的思考块
  if (isPlanner) {
    if (isLast) {
      return (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
          {message.content}
        </div>
      );
    }
    return (
      <div>
        <SectionLabel text="思考与规划" isDarkMode={isDarkMode} />
        <div
          className={`whitespace-pre-wrap break-words pl-3 text-sm leading-relaxed ${
            isDarkMode ? 'text-zinc-400' : 'text-zinc-500'
          } ${isDarkMode ? 'border-l-2 border-zinc-800' : 'border-l-2 border-zinc-200'}`}>
          {message.content}
        </div>
      </div>
    );
  }

  // 兜底:其他 actor 按普通回答呈现
  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
      {message.content}
    </div>
  );
}

/** 连续的导航器动作收敛为一个步骤组 */
function NavigatorGroup({
  items,
  isDarkMode,
}: {
  items: { message: Message; failed: boolean }[];
  isDarkMode: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div
      className={`rounded-lg border p-2 ${
        isDarkMode ? 'border-zinc-800 bg-zinc-900/60' : 'border-zinc-200/80 bg-zinc-50'
      }`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex w-full items-center gap-1.5 text-left text-[11px] font-medium uppercase tracking-wide transition-colors ${
          isDarkMode ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600'
        }`}>
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        执行动作 · {items.length}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {items.map((it, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <span
                className={`mt-1.5 inline-block size-1.5 shrink-0 rounded-full ${
                  it.failed ? 'bg-red-500' : isDarkMode ? 'bg-zinc-600' : 'bg-zinc-300'
                }`}
              />
              <span
                className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${
                  it.failed ? 'text-red-500 dark:text-red-400' : isDarkMode ? 'text-zinc-400' : 'text-zinc-600'
                }`}>
                {it.message.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ text, isDarkMode }: { text: string; isDarkMode: boolean }) {
  return (
    <div
      className={`mb-1 text-[11px] font-medium uppercase tracking-wide ${
        isDarkMode ? 'text-zinc-500' : 'text-zinc-400'
      }`}>
      {text}
    </div>
  );
}

/**
 * Formats a timestamp (in milliseconds) to a readable Chinese time string
 * @param timestamp Unix timestamp in milliseconds
 * @returns Formatted time string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const isToday = date.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  const isThisYear = date.getFullYear() === now.getFullYear();

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr;
  }

  if (isYesterday) {
    return `昨天 ${timeStr}`;
  }

  if (isThisYear) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
  }

  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${timeStr}`;
}
