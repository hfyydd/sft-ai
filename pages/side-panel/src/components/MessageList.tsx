import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo } from 'react';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
}

export default memo(function MessageList({ messages, isDarkMode = false }: MessageListProps) {
  return (
    <div className="max-w-full space-y-3">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
          isDarkMode={isDarkMode}
        />
      ))}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
  isDarkMode?: boolean;
}

function MessageBlock({ message, isSameActor, isDarkMode = false }: MessageBlockProps) {
  if (!message.actor) {
    console.error('No actor found');
    return <div />;
  }
  const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES];
  const isProgress = message.content === 'Showing progress...';
  const isUser = message.actor === 'user';

  // 用户消息:右侧气泡,无头像
  if (isUser && !isProgress) {
    return (
      <div className="flex max-w-full justify-end">
        <div className="max-w-[85%]">
          <div
            className={`whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-3.5 py-2 text-sm ${
              isDarkMode ? 'bg-sky-600 text-white' : 'bg-sky-500 text-white'
            }`}>
            {message.content}
          </div>
          <div className={`mt-1 text-right text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            {formatTimestamp(message.timestamp)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex max-w-full gap-2.5 ${
        !isSameActor
          ? `mt-3 pt-3 first:mt-0 first:pt-0 ${isDarkMode ? 'border-t border-slate-700/60' : 'border-t border-sky-100'} first:border-t-0`
          : ''
      }`}>
      {!isSameActor && (
        <div
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: actor.iconBackground }}>
          <img src={actor.icon} alt={actor.name} className="size-5" />
        </div>
      )}
      {isSameActor && <div className="w-7 shrink-0" />}

      <div className="min-w-0 flex-1">
        {!isSameActor && (
          <div className={`mb-1 text-xs font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            {actor.name}
          </div>
        )}

        <div
          className={`inline-block max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-tl-md px-3 py-2 text-sm ${
            isDarkMode ? 'bg-slate-800 text-gray-200' : 'bg-white/90 text-gray-700 shadow-sm ring-1 ring-sky-100'
          }`}>
          {isProgress ? (
            <div className={`h-1 w-24 overflow-hidden rounded ${isDarkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
              <div className="h-full animate-progress bg-blue-500" />
            </div>
          ) : (
            message.content
          )}
        </div>
        {!isProgress && (
          <div className={`mt-1 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            {formatTimestamp(message.timestamp)}
          </div>
        )}
      </div>
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
