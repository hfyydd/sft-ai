import type { MemoryFact } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('TaskMemory');

export class TaskMemory {
  private facts: MemoryFact[] = [];
  private readonly maxFacts: number;
  private readonly maxFactLength: number;

  constructor(maxFacts = 40, maxFactLength = 600) {
    this.maxFacts = maxFacts;
    this.maxFactLength = maxFactLength;
  }

  add(content: string, evidenceIds: string[] = [], stepId?: string): void {
    const trimmed = (content || '').trim();
    if (!trimmed) return;
    const compact = trimmed.length > this.maxFactLength ? trimmed.slice(0, this.maxFactLength) + '…' : trimmed;
    const prev = this.facts[this.facts.length - 1];
    if (prev?.content === compact && JSON.stringify(prev.evidenceIds) === JSON.stringify(evidenceIds)) return;
    this.facts.push({ id: crypto.randomUUID(), content: compact, evidenceIds: [...evidenceIds], createdAt: Date.now(), stepId });
    if (this.facts.length > this.maxFacts) {
      const dropped = this.facts.shift();
      logger.debug('Working memory evicted oldest fact:', dropped?.id);
    }
  }

  addFact(fact: MemoryFact): void {
    if (!fact.content?.trim()) return;
    this.facts.push({ ...fact, evidenceIds: [...fact.evidenceIds], content: fact.content.slice(0, this.maxFactLength) });
    while (this.facts.length > this.maxFacts) this.facts.shift();
  }

  loadFacts(facts: MemoryFact[] | string[]): void {
    this.facts = [];
    for (const fact of facts) {
      if (typeof fact === 'string') this.add(fact);
      else this.addFact(fact);
    }
  }

  getFacts(): MemoryFact[] {
    return this.facts.map(f => ({ ...f, evidenceIds: [...f.evidenceIds] }));
  }

  serialize(): string {
    if (this.facts.length === 0) return '';
    return this.facts.map((f, i) => (i + 1) + '. ' + f.content + (f.evidenceIds.length ? ' [evidence: ' + f.evidenceIds.join(', ') + ']' : '')).join('\n');
  }
}