import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_PORTS,
  NotifyConfigError,
  parseNotifyConfig,
  RESERVED_HEADERS,
  readNotifyFile,
  urlHost
} from '../src/config.js';

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

  it('refuses headers fetch rejects when sending, in any letter case', () => {
    for (const name of ['Transfer-Encoding', 'keep-alive', 'Upgrade', 'expect', 'Content-Length']) {
      fails(
        [{ id: 'a', url: 'http://x', headers: { [name]: '1' } }],
        new RegExp(`headers: "${name}" is set by PiPulse's HTTP client and can't be used`)
      );
    }
  });

  it('lists only headers fetch really rejects when sending', async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => response.end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      for (const name of RESERVED_HEADERS) {
        const error = await fetch(url, {
          method: 'POST',
          headers: { [name]: '999' },
          body: '{}'
        }).then(
          () => undefined,
          (e: unknown) => e
        );
        expect(error, name).toBeInstanceOf(Error);
      }
    } finally {
      server.close();
    }
  });

  it('refuses a port fetch blocks, which would fail every delivery', () => {
    fails(
      [{ id: 'a', url: 'https://apprise.lan:9/notify/key' }],
      /url uses port 9, which fetch refuses to connect to/
    );
    expect(parse([{ id: 'a', url: 'https://apprise.lan:8443/notify' }])[0]!.url).toBe(
      'https://apprise.lan:8443/notify'
    );
  });

  it('lists only ports that fetch really blocks', async () => {
    for (const port of BLOCKED_PORTS) {
      const error = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
      expect((error as { cause?: Error }).cause?.message, `port ${port}`).toBe('bad port');
    }
  });

  it('refuses a header fetch would reject, naming it without its value', () => {
    fails(
      [{ id: 'a', url: 'http://x', headers: { 'Bad Name': 'v' } }],
      /headers: "Bad Name" is not a valid header name/
    );
    const secret = { id: 'a', url: 'http://x', headers: { Authorization: 'Bearer s3cret\nX: y' } };
    fails([secret], /headers: the value of "Authorization" is not a valid header value/);
    expect(() => parse([secret])).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('s3cret') })
    );
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
