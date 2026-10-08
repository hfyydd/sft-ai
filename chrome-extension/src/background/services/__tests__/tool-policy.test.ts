import { describe, expect, it } from 'vitest';
import { ToolPolicy } from '../toolPolicy';

describe('ToolPolicy', () => {
  it('allows tools without an active whitelist', () => {
    expect(new ToolPolicy().decide('read_page').allowed).toBe(true);
  });
  it('enforces the whitelist', () => {
    const policy = new ToolPolicy(new Set(['read_page']));
    expect(policy.decide('read_page').allowed).toBe(true);
    expect(policy.decide('click_element').allowed).toBe(false);
  });
  it('identifies high impact actions', () => {
    expect(new ToolPolicy().isHighImpact('click_element')).toBe(true);
    expect(new ToolPolicy().isHighImpact('read_page')).toBe(false);
  });
});
