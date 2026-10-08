import { formatPageEvidence } from '../messages/pageEvidence';
import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { t } from '@extension/i18n';
import {
  clickElementActionSchema,
  doneActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  cacheContentActionSchema,
  readPageActionSchema,
  selectDropdownOptionActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
  waitActionSchema,
  previousPageActionSchema,
  scrollToPercentActionSchema,
  nextPageActionSchema,
  scrollToTopActionSchema,
  scrollToBottomActionSchema,
  fillFormActionSchema,
  askUserActionSchema,
} from './schemas';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { ExecutionState, Actors } from '../event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { wrapUntrustedContent } from '../messages/utils';
import { HumanMessage } from '@langchain/core/messages';
import { decodeBase64ToBytes, extractPdfTextFromBytes, extractPdfTextFromUrl } from '../pdf';
import { requestApproval } from '../../task/approval-gate';
import { requiresApproval as policyRequiresApproval } from '../../task/approval-policy';
import { taskRunStore } from '@extension/storage';
import { askUser } from '../../task/user-gate';

const logger = createLogger('Action');

const SENSITIVE_INTENT = /(提交|删除|购买|支付|付款|发送|授权|下载|保存|确认|结算|下单|注销|关闭账号|submit|delete|purchase|pay|checkout|send|authorize|download)/i;

const needsApproval = (toolName:string, intent:string, args:unknown, elementText = '') =>
  toolName === 'close_tab' ||
  policyRequiresApproval(toolName, { ...((args && typeof args === 'object') ? args : {}), intent }, elementText) ||
  SENSITIVE_INTENT.test(intent) ||
  SENSITIVE_INTENT.test(elementText);

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    if (isEmptySchema) {
      return await this.handler({});
    }

    const parsedArgs = this.schema.schema.safeParse(input);
    if (!parsedArgs.success) {
      const errorMessage = parsedArgs.error.message;
      throw new InvalidInputError(errorMessage);
    }
    return await this.handler(parsedArgs.data);
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }

  /**
   * Set the index argument in the input if this action has an index
   * @param input The input to update the index in
   * @param newIndex The new index value to set
   * @returns Whether the index was set successfully
   */
  setIndexArg(input: unknown, newIndex: number): boolean {
    if (!this.hasIndex) {
      return false;
    }
    if (input && typeof input === 'object') {
      (input as { index: number }).index = newIndex;
      return true;
    }
    return false;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema;
    schema = schema.extend({
      [action.name()]: actionSchema.nullable().optional().describe(action.schema.description),
    });
  }
  return schema;
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: BaseChatModel;

  constructor(context: AgentContext, extractorLLM: BaseChatModel) {
    this.context = context;
    this.extractorLLM = extractorLLM;
  }

  private formatPdfEvidenceForModel(
    tabId: number,
    url: string,
    title: string,
    text: string,
    startPage: number,
  ) {
    const re = /--- 第 (\\d+) 页 ---\\n([\\s\\S]*?)(?=\\n--- 第 \\d+ 页 ---\\n|$)/g;
    const chunks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      chunks.push(
        formatPageEvidence(
          'pdf',
          {
            tabId,
            url,
            title,
            capturedAt: new Date().toISOString(),
            pageNumber: Number(match[1]),
          },
          match[2].trim(),
        ),
      );
    }
    if (!chunks.length) {
      return formatPageEvidence(
        'pdf',
        { tabId, url, title, capturedAt: new Date().toISOString(), pageNumber: startPage },
        text,
      );
    }
    return chunks.join('\n\n');
  }

  private async persistPdfEvidence(tabId: number, url: string, title: string, text: string, startPage: number) {
    const re = /(?:^|\n)--- 第 (\d+) 页 ---\n([\s\S]*?)(?=\n--- 第 \d+ 页 ---\n|$)/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = re.exec(text))) {
      found = true;
      await this.persistEvidence('pdf', tabId, url, title, match[2].trim(), Number(match[1]));
    }
    if (!found) await this.persistEvidence('pdf', tabId, url, title, text, startPage);
  }

  private async persistEvidence(source:'dom'|'pdf'|'vision'|'cache', tabId:number, url:string, title:string, content:string, pageNumber?:number){
    const evidenceId = crypto.randomUUID();
    try {
      await taskRunStore.addEvidence({
        id: evidenceId,
        runId: this.context.taskId,
        source, tabId, url, title, capturedAt: Date.now(), pageNumber,
        content: content.length > 50000 ? content.slice(0,50000) + '\\n…[证据已截断]' : content,
      });
      const running = this.context.plan.find(step => step.status === 'running');
      if (running) running.evidenceIds = [...new Set([...running.evidenceIds, evidenceId])];
      return evidenceId;
    } catch (error) {
      logger.warning('Failed to persist page evidence:', error);
      return null;
    }
  }
  buildDefaultActions() {
    const actions = [];

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, t('act_done_start'));
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.ACT_OK,
        input.text && input.text.trim().toLowerCase() !== 'done' ? input.text : t('act_done_ok'),
      );
      return new ActionResult({
        isDone: true,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    const searchGoogle = new Action(async (input: z.infer<typeof searchGoogleActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || t('act_searchGoogle_start', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`);

      const msg2 = t('act_searchGoogle_ok', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const goToUrl = new Action(async (input: z.infer<typeof goToUrlActionSchema.schema>) => {
      const intent = input.intent || t('act_goToUrl_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const currentPage = await this.context.browserContext.getCurrentPage();
      const currentUrl = currentPage.url();
      const crossDomain = (() => {
        try { return new URL(currentUrl).hostname !== new URL(input.url).hostname; } catch { return true; }
      })();
      if (crossDomain) {
        const approved = await requestApproval({
          runId: this.context.taskId, toolName: 'go_to_url', args: input,
          tabId: currentPage.tabId, url: currentUrl, reason: '跨域导航需要确认',
        });
        if (!approved) return new ActionResult({ error: 'Cross-domain navigation was not approved', includeInMemory: true });
      }

      await this.context.browserContext.navigateTo(input.url);
      const msg2 = t('act_goToUrl_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (input: z.infer<typeof goBackActionSchema.schema>) => {
      const intent = input.intent || t('act_goBack_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.goBack();
      const msg2 = t('act_goBack_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
      const seconds = input.seconds || 3;
      const intent = input.intent || t('act_wait_start', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      const msg = t('act_wait_ok', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, waitActionSchema);
    actions.push(wait);

    const askUserAction = new Action(async (input: z.infer<typeof askUserActionSchema.schema>) => {
      const intent = input.intent || '需要用户补充信息';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const answer = await askUser({ runId: this.context.taskId, question: input.question, reason: intent });
      if (answer === null) return new ActionResult({ error: '等待用户介入超时', includeInMemory: true });
      const msg = '用户补充信息已收到';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: wrapUntrustedContent('用户回答：' + answer), success: true, includeInMemory: true });
    }, askUserActionSchema);
    actions.push(askUserAction);

    const fillForm = new Action(async (input: z.infer<typeof fillFormActionSchema.schema>) => {
      const intent = input.intent || '填写表单草稿并逐字段回读校验';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      const state = await page.getState();
      const ordered = [...input.fields];
      const failures: string[] = [];
      for (const field of ordered) {
        const node = state?.selectorMap.get(field.index);
        if (!node) { failures.push('字段 index=' + field.index + ' 不存在'); continue; }
        await page.inputTextElementNode(this.context.options.useVision, node, field.value);
        if (!(await page.verifyInputValue(node, field.value))) {
          failures.push('字段 index=' + field.index + ' 回读不一致');
        }
      }
      if (failures.length) {
        const msg = '表单草稿校验失败：' + failures.join('；');
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
      const msg = '表单草稿已填写并完成回读校验，尚未提交';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, success: true, includeInMemory: true });
    }, fillFormActionSchema);
    actions.push(fillForm);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const intent = input.intent || t('act_click_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        const elementText = elementNode.getAllTextTillNextClickableElement(3);
        const href = elementNode.attributes?.href || '';
        let linkedUrl = '';
        let crossDomainLink = false;
        if (href) {
          try {
            linkedUrl = new URL(href, page.url()).href;
            crossDomainLink = new URL(linkedUrl).hostname !== new URL(page.url()).hostname;
          } catch {
            crossDomainLink = false;
          }
        }
        if (needsApproval('click_element', intent, input, elementText) || crossDomainLink) {
          const approved = await requestApproval({
            runId: this.context.taskId,
            toolName: 'click_element',
            args: { ...input, elementText: elementText.slice(0, 500), linkedUrl },

            tabId: page.tabId,
            url: page.url(),
            reason: crossDomainLink ? '点击将跳转到其他域名：' + linkedUrl : intent || elementText,
          });
          if (!approved) return new ActionResult({ error: 'User approval was not granted', includeInMemory: true });
        }

        // Check if element is a file uploader
        if (page.isFileUploader(elementNode)) {
          const msg = t('act_click_fileUploader', [input.index.toString()]);
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        try {
          const initialTabIds = await this.context.browserContext.getAllTabIds();
          const initialUrl = page.url();
          await page.clickElementNode(this.context.options.useVision, elementNode);
          let msg = t('act_click_ok', [input.index.toString(), elementNode.getAllTextTillNextClickableElement(2)]);
          logger.info(msg);

          // TODO: could be optimized by chrome extension tab api
          const currentTabIds = await this.context.browserContext.getAllTabIds();
          if (currentTabIds.size > initialTabIds.size) {
            const newTabMsg = t('act_click_newTabOpened');
            msg += ` - ${newTabMsg}`;
            logger.info(newTabMsg);
            // find the tab id that is not in the initial tab ids
            const newTabId = Array.from(currentTabIds).find(id => !initialTabIds.has(id));
            if (newTabId) {
              await this.context.browserContext.switchTab(newTabId);
            }
          }
          const verified = currentTabIds.size > initialTabIds.size || await page.verifyClickEffect(input.index, initialUrl);
          if (!verified) {
            const uncertain = `点击已执行但页面未观察到可验证变化: index=${input.index}`;
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, uncertain);
            return new ActionResult({ error: uncertain, includeInMemory: true });
          }
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, success: true, includeInMemory: true });
        } catch (error) {
          const msg = t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }
        if (needsApproval('input_text', intent, input)) {
          const approved = await requestApproval({ runId: this.context.taskId, toolName: 'input_text', args: input, tabId: page.tabId, url: page.url(), reason: intent });
          if (!approved) return new ActionResult({ error: 'User approval was not granted', includeInMemory: true });
        }

        await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text);
        const verified = await page.verifyInputValue(elementNode, input.text);
        if (!verified) {
          const msg = `输入已执行但回读校验失败: index=${input.index}`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({ error: msg, includeInMemory: true });
        }
        const msg = t('act_inputText_ok', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      const intent = input.intent || t('act_switchTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.switchTab(input.tab_id);
      const msg = t('act_switchTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      const intent = input.intent || t('act_openTab_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const currentPage = await this.context.browserContext.getCurrentPage();
      const approved = await requestApproval({
        runId: this.context.taskId, toolName: 'open_tab', args: input,
        tabId: currentPage.tabId, url: currentPage.url(), reason: '打开新标签页',
      });
      if (!approved) return new ActionResult({ error: 'Opening a new tab was not approved', includeInMemory: true });
      await this.context.browserContext.openTab(input.url);
      const msg = t('act_openTab_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, openTabActionSchema);
    actions.push(openTab);

    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const intent = input.intent || t('act_closeTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const pageForApproval = await this.context.browserContext.getCurrentPage();
      const approved = await requestApproval({
        runId: this.context.taskId,
        toolName: 'close_tab',
        args: input,
        tabId: pageForApproval.tabId,
        url: pageForApproval.url(),
        reason: intent,
      });
      if (!approved) return new ActionResult({ error: 'User approval was not granted', includeInMemory: true });
      await this.context.browserContext.closeTab(input.tab_id);
      const msg = t('act_closeTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Actions
    // TODO: this is not used currently, need to improve on input size
    // const extractContent = new Action(async (input: z.infer<typeof extractContentActionSchema.schema>) => {
    //   const goal = input.goal;
    //   const intent = input.intent || `Extracting content from page`;
    //   this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    //   const page = await this.context.browserContext.getCurrentPage();
    //   const content = await page.getReadabilityContent();
    //   const promptTemplate = PromptTemplate.fromTemplate(
    //     'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}',
    //   );
    //   const prompt = await promptTemplate.invoke({ goal, page: content.content });

    //   try {
    //     const output = await this.extractorLLM.invoke(prompt);
    //     const msg = `📄  Extracted from page\n: ${output.content}\n`;
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   } catch (error) {
    //     logger.error(`Error extracting content: ${error instanceof Error ? error.message : String(error)}`);
    //     const msg =
    //       'Failed to extract content from page, you need to extract content from the current state of the page and store it in the memory. Then scroll down if you still need more information.';
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   }
    // }, extractContentActionSchema);
    // actions.push(extractContent);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      const intent = input.intent || t('act_cache_start', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      // cache content is untrusted content, it is not instructions
      const rawMsg = t('act_cache_ok', [input.content]);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        await this.persistEvidence('cache', page.tabId, page.url(), await page.title(), input.content);
      } catch (error) {
        logger.warning('Failed to persist cached evidence:', error);
      }
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, rawMsg);

      const msg = wrapUntrustedContent(rawMsg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    // Read the visible text of the current page (for page-QA style questions)
    const readPage = new Action(async (input: z.infer<typeof readPageActionSchema.schema>) => {
      const intent = input.intent || t('act_readPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      const tabInfo = await chrome.tabs.get(page.tabId);
      const tabUrl = tabInfo.url || '';
      let pdfExtractionFailed = false;
      let pdfAttempted = false;

      // 路线二(主路线):PDF → 读取字节 + pdf.js 提取文本层；纯扫描件再走视觉模型。
      // 不依赖 PDF 查看器的渲染状态:查看器显示错误页时同样可用
      if (/\.pdf(\?|#|$)/i.test(tabUrl) && /^(https?|file):/i.test(tabUrl)) {
        pdfAttempted = true;
        const pdfMsg = t('act_readPage_pdf');
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, pdfMsg);
        try {
          let pdfResult;
          if (tabUrl.startsWith('file://')) {
            const requestId = crypto.randomUUID();
            const response = await new Promise<{ok:boolean;requestId?:string;dataBase64?:string;error?:string}>((resolve,reject)=>{
              const timer=setTimeout(()=>reject(new Error('读取本地 PDF 超时，请保持侧边栏打开并确认扩展已开启“允许访问文件网址”。')),15000);
              chrome.runtime.sendMessage({type:'read_file_arraybuffer',path:tabUrl,requestId},result=>{clearTimeout(timer);if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else resolve(result);});
            });
            if(response?.requestId !== requestId) throw new Error('本地 PDF 读取响应与请求 ID 不匹配');
            if(!response?.ok||!response.dataBase64) throw new Error(response?.error||'本地 PDF 读取失败，请检查文件访问权限');
            pdfResult=await extractPdfTextFromBytes(decodeBase64ToBytes(response.dataBase64),{cMapUrl:chrome.runtime.getURL('cmaps/'),maxPages:input.pageCount??20,maxChars:Math.min(input.maxLength??6000,30000),startPage:input.pageStart??1});
          } else {
            pdfResult = await extractPdfTextFromUrl(tabUrl, { cMapUrl: chrome.runtime.getURL('cmaps/'), maxPages: input.pageCount ?? 20, maxChars: Math.min(input.maxLength ?? 6000, 30000), startPage: input.pageStart ?? 1 });
          }
          if (pdfResult.text) {
            const okMsg = `已解析 PDF 文本(共 ${pdfResult.numPages} 页,提取 ${pdfResult.extractedPages} 页${pdfResult.truncated ? ',内容已截断' : ''})`;
            await this.persistPdfEvidence(page.tabId, tabUrl, tabInfo.title || '', pdfResult.text, pdfResult.startPage);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, okMsg);
            return new ActionResult({
              extractedContent: formatPageEvidence(
                'pdf',
                { tabId: page.tabId, url: tabUrl, title: tabInfo.title || '', capturedAt: new Date().toISOString() },
                `${okMsg}:\\n${pdfResult.text}`,
              ),
              includeInMemory: true,
            });
          }
          pdfExtractionFailed = true; // 文本层为空(纯扫描件)→ 继续走截屏视觉
          logger.info('PDF 无文本层(纯扫描件),回退到截图识别');
        } catch (pdfError) {
          logger.warning('PDF 文本层提取失败,回退到截图识别:', pdfError);
          pdfExtractionFailed = true;
        }
      }

      // 常规页面:注入脚本读取 DOM 文本(错误页等注入失败时 text 保持为空)
      let text = '';
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: page.tabId },
          func: (maxLen: number) => {
            const text = document.body?.innerText ?? '';
            return text.length > maxLen ? text.slice(0, maxLen) + '…[已截断]' : text;
          },
          args: [input.maxLength || 6000],
        });
        text = ((result?.result as string) || '').trim();
      } catch (error) {
        logger.warning('read_page: DOM 文本读取失败:', error);
      }

      // 兜底:截屏 + 视觉模型识别
      if (!text) {
        const visionMsg = t('act_readPage_vision');
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, visionMsg);
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 85 });
          const vision = await this.extractorLLM.invoke([
            new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: '这是浏览器当前标签页的截图(可能是 PDF 或特殊页面)。请用简体中文完整提取/总结图中全部可见内容,包括标题、正文要点与关键数字。',
                },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            }),
          ]);
          text = (typeof vision.content === 'string' ? vision.content : JSON.stringify(vision.content)).trim();
        } catch (error) {
          logger.warning('read_page 视觉识别失败:', error);
        }
        if (!text) {
          // PDF 场景:文本层与截图识别都失败时,给确定性答复而不是让 agent 无限重试
          if (pdfAttempted) {
            const failMsg = `这是一个 PDF 文件(${tabUrl}),浏览器未能加载或无法提取其文本内容。请向用户说明该情况,并建议其确认文件可正常打开后重试,或提供文件所在系统的入口页面。`;
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, failMsg);
            return new ActionResult({ extractedContent: failMsg, includeInMemory: true });
          }
          const emptyMsg = t('act_readPage_empty');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, emptyMsg);
          return new ActionResult({ extractedContent: emptyMsg, includeInMemory: true });
        }
        const okMsg = t('act_readPage_vision_ok');
        await this.persistEvidence('vision', page.tabId, tabUrl, tabInfo.title || '', text);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, okMsg);
        return new ActionResult({
          extractedContent: formatPageEvidence(
            'vision',
            { tabId: page.tabId, url: tabUrl, title: tabInfo.title || '', capturedAt: new Date().toISOString() },
            `${okMsg}:\\n${text}`,
          ),
          includeInMemory: true,
        });
      }
      await this.persistEvidence('dom', page.tabId, tabUrl, tabInfo.title || '', text);
      return new ActionResult({
        extractedContent: formatPageEvidence(
          'dom',
          { tabId: page.tabId, url: tabUrl, title: tabInfo.title || '', capturedAt: new Date().toISOString() },
          text,
        ),
        includeInMemory: true,
      });
    }, readPageActionSchema);
    actions.push(readPage);

    // Scroll to percent
    const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToPercent_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
        await page.scrollToPercent(input.yPercent, elementNode);
      } else {
        await page.scrollToPercent(input.yPercent);
      }
      const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToPercentActionSchema);
    actions.push(scrollToPercent);

    // Scroll to top
    const scrollToTop = new Action(async (input: z.infer<typeof scrollToTopActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToTop_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(0, elementNode);
      } else {
        await page.scrollToPercent(0);
      }
      const msg = t('act_scrollToTop_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToTopActionSchema);
    actions.push(scrollToTop);

    // Scroll to bottom
    const scrollToBottom = new Action(async (input: z.infer<typeof scrollToBottomActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToBottom_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(100, elementNode);
      } else {
        await page.scrollToPercent(100);
      }
      const msg = t('act_scrollToBottom_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToBottomActionSchema);
    actions.push(scrollToBottom);

    // Scroll to previous page
    const previousPage = new Action(async (input: z.infer<typeof previousPageActionSchema.schema>) => {
      const intent = input.intent || t('act_previousPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at top of its scrollable area
        try {
          const [elementScrollTop] = await page.getElementScrollInfo(elementNode);
          if (elementScrollTop === 0) {
            const msg = t('act_errors_alreadyAtTop', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToPreviousPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToPreviousPage(elementNode);
      } else {
        // Check if page is already at top
        const [initialScrollY] = await page.getScrollInfo();
        if (initialScrollY === 0) {
          const msg = t('act_errors_pageAlreadyAtTop');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToPreviousPage();
      }
      const msg = t('act_previousPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, previousPageActionSchema);
    actions.push(previousPage);

    // Scroll to next page
    const nextPage = new Action(async (input: z.infer<typeof nextPageActionSchema.schema>) => {
      const intent = input.intent || t('act_nextPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at bottom of its scrollable area
        try {
          const [elementScrollTop, elementClientHeight, elementScrollHeight] =
            await page.getElementScrollInfo(elementNode);
          if (elementScrollTop + elementClientHeight >= elementScrollHeight) {
            const msg = t('act_errors_alreadyAtBottom', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToNextPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToNextPage(elementNode);
      } else {
        // Check if page is already at bottom
        const [initialScrollY, initialVisualViewportHeight, initialScrollHeight] = await page.getScrollInfo();
        if (initialScrollY + initialVisualViewportHeight >= initialScrollHeight) {
          const msg = t('act_errors_pageAlreadyAtBottom');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToNextPage();
      }
      const msg = t('act_nextPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, nextPageActionSchema);
    actions.push(nextPage);

    // Scroll to text
    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToText_start', [input.text, input.nth.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      try {
        const scrolled = await page.scrollToText(input.text, input.nth);
        const msg = scrolled
          ? t('act_scrollToText_ok', [input.text, input.nth.toString()])
          : t('act_scrollToText_notFound', [input.text, input.nth.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = t('act_scrollToText_failed', [error instanceof Error ? error.message : String(error)]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const intent = input.intent || t('act_sendKeys_start', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      if (needsApproval('send_keys', intent, input)) {
        const approved = await requestApproval({ runId: this.context.taskId, toolName: 'send_keys', args: input, tabId: page.tabId, url: page.url(), reason: intent || input.keys });
        if (!approved) return new ActionResult({ error: 'User approval was not granted', includeInMemory: true });
      }
      await page.sendKeys(input.keys);
      const msg = t('act_sendKeys_ok', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(input.index);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\n' + t('act_getDropdownOptions_useExactText');
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              t('act_getDropdownOptions_ok', [options.length.toString()]),
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = t('act_getDropdownOptions_noOptions');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = t('act_selectDropdownOption_notSelect', [
            input.index.toString(),
            elementNode.tagName || 'unknown',
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

        if (needsApproval('select_dropdown_option', intent, input, elementNode.getAllTextTillNextClickableElement(3))) {
          const approved = await requestApproval({ runId: this.context.taskId, toolName: 'select_dropdown_option', args: input, tabId: page.tabId, url: page.url(), reason: intent });
          if (!approved) return new ActionResult({ error: 'User approval was not granted', includeInMemory: true });
        }

        try {
          const result = await page.selectDropdownOption(input.index, input.text);
          const verified = await page.verifyDropdownSelection(input.index, input.text);
          if (!verified) {
            const errorMsg = '下拉框写入后回读校验失败: index=' + input.index;
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
            return new ActionResult({ error: errorMsg, includeInMemory: true });
          }
          const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: result, success: true, includeInMemory: true });
        } catch (error) {
          const errorMsg = t('act_selectDropdownOption_failed', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    return actions;
  }
}
