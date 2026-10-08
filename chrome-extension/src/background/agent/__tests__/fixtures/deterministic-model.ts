import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';

export class DeterministicChatModel extends SimpleChatModel {
  private cursor = 0;

  constructor(private readonly outputs: string[]) {
    super({});
  }

  _llmType() {
    return 'deterministic';
  }

  async _call(messages: BaseMessage[]) {
    void messages;
    const output = this.outputs[Math.min(this.cursor++, this.outputs.length - 1)];
    return output ?? '{}';
  }
}
