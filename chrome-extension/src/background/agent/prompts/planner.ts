/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';

export class PlannerPrompt extends BasePrompt {
  private systemMessage: SystemMessage;

  constructor(extraInstructions = '') {
    super();
    const trimmed = extraInstructions.trim();
    const promptText = trimmed ? `${plannerSystemPromptTemplate.trimEnd()}\n\n${trimmed}` : plannerSystemPromptTemplate;
    this.systemMessage = new SystemMessage(promptText);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
