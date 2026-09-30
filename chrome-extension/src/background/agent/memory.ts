import { createLogger } from '../log';

const logger = createLogger('TaskMemory');

/**
 * Agent Loop v2 工作记忆(scratchpad):
 * 跨步骤 / 跨页面保存关键事实(采集到的数据、页面结论、失败教训),
 * 由规划器通过 memory_write 字段写入,注入到规划器与导航器的状态消息中,
 * 使长链路多页面任务不会"遗忘"此前步骤的成果。
 */
export class TaskMemory {
  private facts: string[] = [];
  private readonly maxFacts: number;
  private readonly maxFactLength: number;

  constructor(maxFacts = 20, maxFactLength = 400) {
    this.maxFacts = maxFacts;
    this.maxFactLength = maxFactLength;
  }

  add(fact: string): void {
    const trimmed = (fact || '').trim();
    if (!trimmed) return;
    const compact = trimmed.length > this.maxFactLength ? trimmed.slice(0, this.maxFactLength) + '…' : trimmed;
    if (this.facts[this.facts.length - 1] === compact) return;
    this.facts.push(compact);
    if (this.facts.length > this.maxFacts) {
      const dropped = this.facts.shift();
      logger.debug('Working memory evicted oldest fact:', dropped);
    }
  }

  /** 序列化为编号清单;空记忆返回空串(不注入)。 */
  serialize(): string {
    if (this.facts.length === 0) return '';
    return this.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  }
}
