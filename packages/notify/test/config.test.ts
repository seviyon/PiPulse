import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotifyConfigError, parseNotifyConfig, readNotifyFile, urlHost } from '../src/config.js';

const parse = (webhooks: unknown) =>
  parseNotifyConfig({ name: 'notify.json', text: JSON.stringify({ webhooks }) });
const fails = (webhooks: unknown, pattern: RegExp) =>
  expect(() => parse(webhooks)).toThrow(pattern);

describe('parseNotifyConfig', () => {
  it('applies defaults', () => {
    expect(parse([{ id: 'apprise', url: 'http://apprise.lan:8000/notify/pi' }])).toEqual([
      {
        id: 'apprise',
        url: 'http://apprise.lan:8000/notify/pi',
        method: 'POST',
        headers: {},
        events: ['raised', 'cleared'],
        minSeverity: 'warning',
        timeoutMs: 10_000
      }
    ]);
  });

  it('keeps a body template, headers and filters', () => {
    const [hook] = parse([
      {
        id: 'ntfy',
        url: 'https://ntfy.sh/pi',
        method: 'PUT',
        headers: { Authorization: 'Bearer x' },
        body: { message: '{{message}}' },
        events: ['raised'],
        minSeverity: 'critical',
        timeout: '30s'
      }
    ]);
    expect(hook).toMatchObject({
      method: 'PUT',
      headers: { Authorization: 'Bearer x' },
      body: { message: '{{message}}' },
      events: ['raised'],
      minSeverity: 'critical',
      timeoutMs: 30_000
    });
  });

  it('names the webhook and field for every problem', () => {
    fails(
      [{ id: 'a', url: 'http://x', bogus: 1 }],
      /notify\.json webhooks\[0\] \("a"\): unknown field "bogus"/
    );
    fails([{ id: 'Bad', url: 'http://x' }], /id must be lowercase snake_case/);
    expect(() => parse([{ id: 'Bad', url: 'http://x' }])).toThrow(NotifyConfigError);
    fails(
      [
        { id: 'a', url: 'http://x' },
        { id: 'a', url: 'http://y' }
      ],
      /webhook id "a" appears twice/
    );
    fails([{ id: 'a', url: 'ftp://x' }], /url must be an http:\/\/ or https:\/\/ URL/);
    fails([{ id: 'a', url: 'http://x', method: 'GET' }], /method must be POST or PUT/);
    fails([{ id: 'a', url: 'http://x', headers: { A: 1 } }], /headers must map names to strings/);
    fails(
      [{ id: 'a', url: 'http://x', events: ['acknowledged'] }],
      /events must be a non-empty list of raised, cleared/
    );
    fails(
      [{ id: 'a', url: 'http://x', minSeverity: 'info' }],
      /minSeverity must be warning or critical/
    );
    fails([{ id: 'a', url: 'http://x', timeout: '5m' }], /timeout/);
    fails([{ id: 'a', url: 'http://x', timeout: '2min' }], /timeout must be between 1s and 60s/);
    fails(
      [{ id: 'a', url: 'http://x', body: { t: '{{nope}}' } }],
      /\("a"\): body: unknown placeholder \{\{nope\}\}/
    );
    expect(() => parseNotifyConfig({ name: 'notify.json', text: '{' })).toThrow(
      /notify\.json is not valid JSON/
    );
    expect(() => parseNotifyConfig({ name: 'notify.json', text: '{}' })).toThrow(
      /must be an object with a "webhooks" array/
    );
  });
});

describe('readNotifyFile and urlHost', () => {
  it('reads the file and says whether others can read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-notify-'));
    const path = join(dir, 'notify.json');
    writeFileSync(path, '{"webhooks":[]}');
    chmodSync(path, 0o600);
    expect(readNotifyFile(path)).toEqual({
      name: path,
      text: '{"webhooks":[]}',
      worldReadable: false
    });
    chmodSync(path, 0o644);
    expect(readNotifyFile(path).worldReadable).toBe(true);
    expect(() => readNotifyFile(join(dir, 'missing.json'))).toThrow(
      /PIPULSE_NOTIFY_FILE .* could not be read: ENOENT/
    );
    expect(() => readNotifyFile(join(dir, 'missing.json'))).toThrow(NotifyConfigError);
  });

  it('shows the host only', () => {
    expect(urlHost('https://user:pass@apprise.lan:8000/notify/key?x=1')).toBe('apprise.lan:8000');
  });
});
