import { taskRunStore } from '@extension/storage';
import { HumanMessage, type SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { wrapUntrustedContent } from '../messages/utils';
import { createLogger } from '@src/background/log';

const logger = createLogger('BasePrompt');
/**
 * Abstract base class for all prompt types
 */
abstract class BasePrompt {
  /**
   * Returns the system message that defines the AI's role and behavior
   * @returns SystemMessage from LangChain
   */
  abstract getSystemMessage(): SystemMessage;

  /**
   * Returns the user message for the specific prompt type
   * @param context - Optional context data needed for generating the user message
   * @returns HumanMessage from LangChain
   */
  abstract getUserMessage(context: AgentContext): Promise<HumanMessage>;

  /**
   * Builds the user message containing the browser state
   * @param context - The agent context
   * @returns HumanMessage from LangChain
   */
  async buildBrowserStateUserMessage(context: AgentContext): Promise<HumanMessage> {
    const browserState = await context.browserContext.getState(context.options.useVision);
    const rawElementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);

    let formattedElementsText = '';
    if (rawElementsText !== '') {
      const scrollInfo = `[Scroll info of current page] window.scrollY: ${browserState.scrollY}, document.body.scrollHeight: ${browserState.scrollHeight}, window.visualViewport.height: ${browserState.visualViewportHeight}, visual viewport height as percentage of scrollable distance: ${Math.round((browserState.visualViewportHeight / (browserState.scrollHeight - browserState.visualViewportHeight)) * 100)}%\n`;
      logger.info(scrollInfo);
      const elementsText = wrapUntrustedContent(rawElementsText);
      formattedElementsText = `${scrollInfo}[Start of page]\n${elementsText}\n[End of page]\n`;
    } else {
      formattedElementsText = 'empty page';
    }

    let stepInfoDescription = '';
    if (context.stepInfo) {
      stepInfoDescription = `Current step: ${context.stepInfo.stepNumber + 1}/${context.stepInfo.maxSteps}`;
    }

    const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' '); // Format: YYYY-MM-DD HH:mm
    stepInfoDescription += `Current date and time: ${timeStr}`;

    let actionResultsDescription = '';
    if (context.actionResults.length > 0) {
      for (let i = 0; i < context.actionResults.length; i++) {
        const result = context.actionResults[i];
        if (result.extractedContent) {
          actionResultsDescription += `\nAction result ${i + 1}/${context.actionResults.length}: ${result.extractedContent}`;
        }
        if (result.error) {
          // only use last line of error
          const error = result.error.split('\n').pop();
          actionResultsDescription += `\nAction error ${i + 1}/${context.actionResults.length}: ...${error}`;
        }
      }
    }

    // Agent Loop v2: 工作记忆注入(对规划器与导航器同时可见)
    const memoryBlock = context.taskMemory ? context.taskMemory.serialize() : '';
    const evidence = await taskRunStore.getEvidence(context.taskId, 12).catch(() => []);
    const evidenceSection = evidence.length
      ? wrapUntrustedContent(
          '\\n[Persistent evidence index / 持久证据索引]\\n' + evidence.map(e =>
            '- ' + e.id + ': ' + e.source + ' | ' + e.title + ' | ' + e.url + ' | ' + new Date(e.capturedAt).toISOString() +
            (e.pageNumber ? ' | page=' + e.pageNumber : '')
          ).join('\\n') + '\\n',
        )
      : '';
    const planSection = context.plan.length
      ? '\\n[Runtime-owned task plan / 运行时任务计划]\n' +
        wrapUntrustedContent(JSON.stringify(context.plan.map(step => ({
          id: step.id,
          title: step.title,
          successCriteria: step.successCriteria,
          status: step.status,
          evidenceIds: step.evidenceIds,
        })), null, 2)) + '\\n'
      : '';
    const pendingWriteSection = context.pendingWrite
      ? '\\n[Pending browser write / 尚待核验的浏览器写操作]\n' +
        wrapUntrustedContent(JSON.stringify({
          toolName: context.pendingWrite.toolName,
          tabId: context.pendingWrite.tabId,
          url: context.pendingWrite.url,
          startedAt: context.pendingWrite.startedAt,
          parameterHash: context.pendingWrite.parameterHash,
        })) + '\\n'
      : '';
    const approvalSection = context.approvedAction
      ? '\\n[Approved single-use action / 一次性批准动作]\n' +
        wrapUntrustedContent(JSON.stringify({
          toolName: context.approvedAction.toolName,
          argsSummary: context.approvedAction.argsSummary,
          tabId: context.approvedAction.tabId,
          url: context.approvedAction.url,
          targetUrl: context.approvedAction.targetUrl,
          expiresAt: context.approvedAction.expiresAt,
          parameterHash: context.approvedAction.parameterHash,
        })) + '\\n'
      : '';
    const memorySection = memoryBlock
      ? `\\n[Task memory / 工作记忆 - 关键事实来自此前步骤]\\n${wrapUntrustedContent(memoryBlock)}\\n`
      : '';

    const currentTab = wrapUntrustedContent(
      `{id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}`,
    );
    const otherTabs = wrapUntrustedContent(
      browserState.tabs
        .filter(tab => tab.id !== browserState.tabId)
        .map(tab => `- {id: ${tab.id}, url: ${tab.url}, title: ${tab.title}`)
        .join('\n'),
    );
    const stateDescription = `
[Task history memory ends]
[Current state starts here]
The following is one-time information - if you need to remember it write it to memory:
Current tab: ${currentTab}
Other available tabs:
  ${otherTabs}
Interactive elements from top layer of the current page inside the viewport:
${formattedElementsText}
${stepInfoDescription}
${actionResultsDescription}
${planSection}${pendingWriteSection}${approvalSection}
${memorySection}${evidenceSection}
`;

    if (browserState.screenshot && context.options.useVision) {
      return new HumanMessage({
        content: [
          { type: 'text', text: stateDescription },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${browserState.screenshot}` },
          },
        ],
      });
    }

    return new HumanMessage(stateDescription);
  }
}

export { BasePrompt };
