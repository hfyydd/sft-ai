import { describe, expect, it } from 'vitest';
import { isUrlAllowed } from '../util';

describe('navigation policy', () => {
  const allow = ['example.com'];
  const deny = ['blocked.example.com'];

  it('allows the requested domain and its subdomains', () => {
    expect(isUrlAllowed('https://example.com/path', allow, deny)).toBe(true);
    expect(isUrlAllowed('https://www.example.com/path', allow, deny)).toBe(true);
  });

  it('denies explicitly blocked domains even when the allow list contains a parent', () => {
    expect(isUrlAllowed('https://blocked.example.com/form', allow, deny)).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<h1>unsafe</h1>',
    'chrome://settings',
    'chrome-extension://example/page.html',
    'ws://example.com/socket',
  ])('denies dangerous scheme %s', url => {
    expect(isUrlAllowed(url, [], [])).toBe(false);
  });

  it('denies empty or malformed URLs', () => {
    expect(isUrlAllowed('', [], [])).toBe(false);
    expect(isUrlAllowed('not a url', [], [])).toBe(false);
  });

  it('supports explicitly allowed about:blank as a safe recovery page', () => {
    expect(isUrlAllowed('about:blank', ['example.com'], ['blocked.example.com'])).toBe(true);
  });
});
