import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotifyConfig } from '../src/config.js';
import { TemplateError } from '../src/template.js';

// `checkTemplate` only ever throws a TemplateError, which becomes a message naming the field.
// Anything else it throws is a bug, and must reach the operator as itself, not as a config error
// that blames their file: the check is replaced here to prove that.
const check = vi.hoisted(() => vi.fn());
vi.mock('../src/template.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/template.js')>()),
  checkTemplate: check
}));

const parse = (webhook: Record<string, unknown>) =>
  parseNotifyConfig({
    name: 'notify.json',
    text: JSON.stringify({ webhooks: [{ id: 'a', url: 'http://x', ...webhook }] })
  });

beforeEach(() => {
  // A block, not an expression: a function returned from beforeEach is run as its cleanup.
  check.mockReset();
});

describe.each(['body', 'summaryBody'])(
  'an error from the %s check that is not a template error',
  (field) => {
    it('is rethrown as it is', () => {
      check.mockImplementation(() => {
        throw new RangeError('a bug in the check');
      });
      expect(() => parse({ [field]: { t: 'x' } })).toThrow(RangeError);
    });

    it('still becomes a message naming the field when it is a template error', () => {
      check.mockImplementation(() => {
        throw new TemplateError('unknown placeholder {{nope}}');
      });
      expect(() => parse({ [field]: { t: 'x' } })).toThrow(
        `${field}: unknown placeholder {{nope}}`
      );
    });
  }
);
