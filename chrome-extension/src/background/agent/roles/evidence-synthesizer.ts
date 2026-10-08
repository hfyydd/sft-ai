import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EvidenceRecord } from '@extension/storage';
import { wrapUntrustedContent } from '../messages/utils';

export class EvidenceSynthesizer {
  constructor(private readonly llm: BaseChatModel) {}

  async summarize(goal: string, evidence: EvidenceRecord[]): Promise<string> {
    const context = evidence.map(e =>
      '[evidenceId=' + e.id + '] source=' + e.source + ' url=' + e.url + ' title=' + e.title +
      ' page=' + (e.pageNumber ?? '-') + '\n' + wrapUntrustedContent(e.content)
    ).join('\n\n');
    const response = await this.llm.invoke([
      {
        role: 'system',
        content: '你是只读证据综合角色。只能根据带 evidenceId 的证据回答；不得执行浏览器动作、不得扩大工具权限；结论必须引用 evidenceId。',
      },
      {
        role: 'user',
        content: '用户目标：' + goal + '\n\n证据：\n' + context,
      },
    ]);
    return typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  }
}
