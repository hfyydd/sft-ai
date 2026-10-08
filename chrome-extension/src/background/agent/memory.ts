import { createLogger } from '../log';
import type { MemoryFact } from '@extension/storage';

const logger = createLogger('TaskMemory');

export class TaskMemory {
  private facts: MemoryFact[] = [];
  private readonly maxFacts: number;
  private readonly maxFactLength: number;

  constructor(maxFacts = 20, maxFactLength = 400) {
    this.maxFacts = maxFacts;
    this.maxFactLength = maxFactLength;
  }

  add(content: string, evidenceIds: string[] = [], stepId?: string, confidence: MemoryFact['confidence'] = 'medium'): void {
    const trimmed = (content || '').trim();
    if (!trimmed) return;
    const compact = trimmed.length > this.maxFactLength ? trimmed.slice(0, this.maxFactLength) + '…' : trimmed;
    const normalizedEvidence = [...new Set(evidenceIds.filter(Boolean))].slice(0, 20);
    const previous = this.facts[this.facts.length - 1];
    if (previous?.content === compact && JSON.stringify(previous.evidenceIds) === JSON.stringify(normalizedEvidence)) return;

    this.facts.push({
      id: globalThis.crypto?.randomUUID?.() ?? `memory_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content: compact,
      evidenceIds: normalizedEvidence,
      createdAt: Date.now(),
      confidence,
      stepId,
    });
    if (this.facts.length > this.maxFacts) {
      const dropped = this.facts.shift();
      logger.debug('Working memory evicted oldest fact:', dropped?.content);
    }
  }

  addFact(fact: MemoryFact): void {
    const trimmed = (fact.content || '').trim();
    if (!trimmed) return;
    const compact = trimmed.length > this.maxFactLength ? trimmed.slice(0, this.maxFactLength) + '…' : trimmed;
    const normalized: MemoryFact = {
      id: fact.id || (globalThis.crypto?.randomUUID?.() ?? 'memory_' + Date.now()),
      content: compact,
      evidenceIds: [...new Set(fact.evidenceIds ?? [])].slice(0, 20),
      createdAt: fact.createdAt || Date.now(),
      confidence: fact.confidence ?? 'medium',
      stepId: fact.stepId,
    };
    const previous = this.facts[this.facts.length - 1];
    if (previous?.id === normalized.id) return;
    this.facts.push(normalized);
    if (this.facts.length > this.maxFacts) this.facts.shift();
  }

  getFacts(): MemoryFact[] {
    return this.facts.map(fact => ({ ...fact, evidenceIds: [...fact.evidenceIds] }));
  }

  loadFacts(facts: MemoryFact[] | string[]): void {
    this.facts = [];
    for (const item of facts) {
      if (typeof item === 'string') this.add(item);
      else this.addFact(item);
    }
  }

  serialize(): string {
    if (!this.facts.length) return '';
    return this.facts
      .map((fact, index) => {
        const refs = fact.evidenceIds.length ? ` [evidence:${fact.evidenceIds.join(',')}]` : '';
        return `${index + 1}. ${fact.content}${refs}`;
      })
      .join('\n');
  }
}
