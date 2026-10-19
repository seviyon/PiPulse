import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { StatusIcon } from '../../src/core/status-icon.js';

const root = document.createElement('div');
afterEach(() => render(null, root));

describe('StatusIcon', () => {
  it('is a red octagon with a bar for critical, hidden from screen readers', () => {
    render(<StatusIcon level="critical" />, root);
    const svg = root.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('var(--critical)');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelector('circle')).not.toBeNull();
  });

  it('is an amber triangle for warning, hidden from screen readers', () => {
    render(<StatusIcon level="warning" />, root);
    const svg = root.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('var(--warning)');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
  });

  it('is 14 px square, so it sits in a line of text', () => {
    render(<StatusIcon level="warning" />, root);
    const svg = root.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['14', '14']);
  });
});
