import type { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentContext, AgentOutput } from '../types';
import type { BasePrompt } from '../prompts/base';
import type { BaseMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { Action } from '../actions/builder';
import { convertInputMessages, extractJsonFromModelOutput, removeThinkTags } from '../messages/utils';
import { isAbortedError, ResponseParseError } from './errors';
import { ProviderTypeEnum } from '@extension/storage';

const logger = createLogger('agent');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CallOptions = Record<string, any>;

// Update options to use Zod schema
export interface BaseAgentOptions {
  chatLLM: BaseChatModel;
  context: AgentContext;
  prompt: BasePrompt;
  provider?: string;
}
export interface ExtraAgentOptions {
  id?: string;
  toolCallingMethod?: string;
  callOptions?: CallOptions;
}

/**
 * Base class for all agents
 * @param T - The Zod schema for the model output
 * @param M - The type of the result field of the agent output
 */
export abstract class BaseAgent<T extends z.ZodType, M = unknown> {
  protected id: string;
  protected chatLLM: BaseChatModel;
  protected prompt: BasePrompt;
  protected context: AgentContext;
  protected actions: Record<string, Action> = {};
  protected modelOutputSchema: T;
  protected toolCallingMethod: string | null;
  protected chatModelLibrary: string;
  protected modelName: string;
  protected provider: string;
  protected withStructuredOutput: boolean;
  protected callOptions?: CallOptions;
  protected modelOutputToolName: string;
  declare ModelOutput: z.infer<T>;

  constructor(modelOutputSchema: T, options: BaseAgentOptions, extraOptions?: Partial<ExtraAgentOptions>) {
    // base options
    this.modelOutputSchema = modelOutputSchema;
    this.chatLLM = options.chatLLM;
    this.prompt = options.prompt;
    this.context = options.context;
    this.provider = options.provider || '';
    // TODO: fix this, the name is not correct in production environment
    this.chatModelLibrary = this.chatLLM.constructor.name;
    this.modelName = this.getModelName();
    this.withStructuredOutput = this.setWithStructuredOutput();
    // extra options
    this.id = extraOptions?.id || 'agent';
    this.toolCallingMethod = this.setToolCallingMethod(extraOptions?.toolCallingMethod);
    this.callOptions = extraOptions?.callOptions;
    this.modelOutputToolName = `${this.id}_output`;
  }

  // Set the model name
  private getModelName(): string {
    if ('modelName' in this.chatLLM) {
      return this.chatLLM.modelName as string;
    }
    if ('model_name' in this.chatLLM) {
      return this.chatLLM.model_name as string;
    }
    if ('model' in this.chatLLM) {
      return this.chatLLM.model as string;
    }
    return 'Unknown';
  }

  // Set the tool calling method
  private setToolCallingMethod(toolCallingMethod?: string): string | null {
    if (toolCallingMethod === 'auto') {
      switch (this.chatModelLibrary) {
        case 'ChatGoogleGenerativeAI':
          return null;
        case 'ChatOpenAI':
        case 'AzureChatOpenAI':
        case 'ChatGroq':
        case 'ChatXAI':
          return 'function_calling';
        default:
          return null;
      }
    }
    return toolCallingMethod || null;
  }

  // Check if model is a Llama model (only for Llama-specific handling)
  private isLlamaModel(modelName: string): boolean {
    return modelName.includes('Llama-4') || modelName.includes('Llama-3.3') || modelName.includes('llama-3.3');
  }

  // Set whether to use structured output based on the model name
  private setWithStructuredOutput(): boolean {
    if (this.modelName === 'deepseek-reasoner' || this.modelName === 'deepseek-r1') {
      return false;
    }

    // DeepSeek V4 系列在强制 tool_choice 的结构化输出下不稳定(2026-09-30 实测,
    // 规划连续多轮 "Could not parse response with structured output"),
    // 统一走普通调用 + jsonrepair 手工提取的兜底路径(更稳)
    if (this.modelName.startsWith('deepseek')) {
      logger.debug(`[${this.modelName}] DeepSeek model: using manual JSON extraction instead of structured output`);
      return false;
    }

    // Llama API models don't support json_schema response format
    if (this.provider === ProviderTypeEnum.Llama || this.isLlamaModel(this.modelName)) {
      logger.debug(`[${this.modelName}] Llama API doesn't support structured output, using manual JSON extraction`);
      return false;
    }

    return true;
  }

  async invoke(inputMessages: BaseMessage[]): Promise<this['ModelOutput']> {
    // Use structured output
    if (this.withStructuredOutput) {
      logger.debug(`[${this.modelName}] Preparing structured output call with schema:`, {
        schemaName: this.modelOutputToolName,
        messageCount: inputMessages.length,
        modelProvider: this.provider,
      });

      const structuredLlm = this.chatLLM.withStructuredOutput(this.modelOutputSchema, {
        includeRaw: true,
        name: this.modelOutputToolName,
      });

      let response = undefined;
      try {
        logger.debug(`[${this.modelName}] Invoking LLM with structured output...`);
        response = await structuredLlm.invoke(inputMessages, {
          signal: this.context.controller.signal,
          ...this.callOptions,
        });

        logger.debug(`[${this.modelName}] LLM response received:`, {
          hasParsed: !!response.parsed,
          hasRaw: !!response.raw,
          rawContent: response.raw?.content?.slice(0, 500) + (response.raw?.content?.length > 500 ? '...' : ''),
        });

        if (response.parsed) {
          logger.debug(`[${this.modelName}] Successfully parsed structured output`);
          return response.parsed;
        }

        // DeepSeek 等模型偶发结构化输出解析失败:raw 响应里往往是合法 JSON,
        // 先尝试手工提取兜底,而不是直接抛错(抛错会让整轮规划作废)
        const rawContentOnParsed = response.raw?.content;
        if (typeof rawContentOnParsed === 'string' && rawContentOnParsed.trim()) {
          const salvaged = this.manuallyParseResponse(rawContentOnParsed);
          if (salvaged) {
            logger.info(`[${this.modelName}] Structured output parse failed, manual salvage succeeded`);
            return salvaged;
          }
        }
        const salvagedFromToolCalls = this.salvageFromToolCalls(response.raw);
        if (salvagedFromToolCalls) {
          logger.info(`[${this.modelName}] Structured output parse failed, tool_calls salvage succeeded`);
          return salvagedFromToolCalls;
        }
        logger.error('Failed to parse response', response);
        throw new Error('Could not parse response with structured output');
      } catch (error) {
        if (isAbortedError(error)) {
          throw error;
        }

        // Try to extract JSON from raw response manually if possible
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (response?.raw?.content && typeof response.raw.content === 'string') {
          const parsed = this.manuallyParseResponse(response.raw.content);
          if (parsed) {
            logger.info(`[${this.modelName}] Structured output failed, manual salvage succeeded`);
            return parsed;
          }
        }
        const salvagedFromToolCalls2 = this.salvageFromToolCalls(response.raw);
        if (salvagedFromToolCalls2) {
          logger.info(`[${this.modelName}] Structured output failed, tool_calls salvage succeeded`);
          return salvagedFromToolCalls2;
        }
        logger.error(`[${this.modelName}] LLM call failed with error: \n${errorMessage}`);
        throw new Error(`Failed to invoke ${this.modelName} with structured output: \n${errorMessage}`);
      }
    }

    // Fallback: Without structured output support, need to extract JSON from model output manually
    logger.debug(`[${this.modelName}] Using manual JSON extraction fallback method`);
    const convertedInputMessages = convertInputMessages(inputMessages, this.modelName);

    let response;
    try {
      response = await this.chatLLM.invoke(convertedInputMessages, {
        signal: this.context.controller.signal,
        ...this.callOptions,
      });

      if (typeof response.content === 'string') {
        const parsed = this.manuallyParseResponse(response.content);
        if (parsed) {
          return parsed;
        }
        logger.error(
          `[${this.modelName}] Manual parse failed. Raw model content (first 2000 chars):`,
          String(response.content).slice(0, 2000),
        );
      } else {
        logger.error(`[${this.modelName}] Manual path: non-string content:`, typeof response.content);
      }
    } catch (error) {
      logger.error(`[${this.modelName}] LLM call failed in manual extraction mode:`, error);
      throw error;
    }
    logger.error(
      `[${this.modelName}] raw content at failure:`,
      JSON.stringify(response?.content ?? null).slice(0, 2000),
    );
    const errorMessage = `Failed to parse response from ${this.modelName}`;
    logger.error(errorMessage);
    throw new ResponseParseError('Could not parse response');
  }

  // Execute the agent and return the result
  abstract execute(): Promise<AgentOutput<M>>;

  // Helper method to validate metadata
  protected validateModelOutput(data: unknown): this['ModelOutput'] | undefined {
    if (!this.modelOutputSchema || !data) return undefined;
    try {
      return this.modelOutputSchema.parse(data);
    } catch (error) {
      logger.error('validateModelOutput', error);
      throw new ResponseParseError('Could not validate model output');
    }
  }

  /** Agent Loop v2:从 tool_calls 参数中兜底提取结构化输出 */
  protected salvageFromToolCalls(raw: any): this['ModelOutput'] | undefined {
    const calls = raw?.additional_kwargs?.tool_calls || raw?.tool_calls;
    const argsStr = calls?.[0]?.function?.arguments;
    if (typeof argsStr !== 'string' || !argsStr.trim()) return undefined;
    try {
      const validated = this.validateModelOutput(JSON.parse(argsStr));
      if (validated) return validated;
    } catch {
      // arguments 不是合法 JSON 时,复用手工解析(jsonrepair + 容错提取)
      return this.manuallyParseResponse(argsStr);
    }
    return undefined;
  }

  // Helper method to manually parse the response content
  protected manuallyParseResponse(content: string): this['ModelOutput'] | undefined {
    const cleanedContent = removeThinkTags(content);

    // DeepSeek V4 会以自有 DSML 标记格式输出工具调用(plain completion 模式):
    // <｜｜DSML｜｜ invoke name="X"> <｜｜DSML｜｜ parameter name="K" ...>value
    // 把各 parameter 段解析回对象,再走统一校验
    if (cleanedContent.includes('DSML')) {
      const obj: Record<string, unknown> = {};
      const re = /<｜｜DSML｜｜ parameter name="([^"]+)"[^>]*>([\s\S]*?)(?=<｜｜DSML｜｜ |<\/｜｜DSML｜｜|$)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(cleanedContent))) {
        const name = m[1];
        let rawVal = m[2].replace(/<\/｜｜DSML｜｜ parameter>\s*$/, '').trim();
        try {
          obj[name] = JSON.parse(rawVal);
        } catch {
          obj[name] = rawVal;
        }
      }
      if (Object.keys(obj).length > 0) {
        logger.debug('DSML salvage parsed keys:', Object.keys(obj));
        let validated = this.validateModelOutput(obj as this['ModelOutput']);
        if (!validated) {
          // 宽容合并:DSML 参数可能只覆盖部分字段,缺失的规划字段补默认值后再校验
          const merged = {
            observation: '',
            challenges: '',
            done: false,
            next_steps: '',
            final_answer: '',
            reasoning: '',
            web_task: true,
            memory_write: '',
            ...(obj as Record<string, unknown>),
          };
          validated = this.validateModelOutput(merged as this['ModelOutput']);
        }
        if (validated) {
          logger.info('DSML salvage succeeded');
          return validated;
        }
      }
    }

    try {
      const extractedJson = extractJsonFromModelOutput(cleanedContent);
      return this.validateModelOutput(extractedJson);
    } catch (error) {
      logger.warning('manuallyParseResponse failed', error);
      return undefined;
    }
  }
}
