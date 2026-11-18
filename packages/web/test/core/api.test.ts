import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadResponse, getJson, HttpError, parse, segment, sendJson } from '../../src/core/api.js';
import type { Guard } from '../../src/core/guards.js';

const isNumberBox: Guard<{ n: number }> = (v): v is { n: number } =>
  typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number';

afterEach(() => vi.unstubAllGlobals());

describe('segment', () => {
  it('keeps every character that could change the path or the query inside one segment', () => {
    expect(segment('cpu_load')).toBe('cpu_load');
    expect(segment('a/b')).toBe('a%2Fb');
    expect(segment('a?b#c')).toBe('a%3Fb%23c');
    expect(segment('..')).toBe('..');
    expect(segment('../../x')).toBe('..%2F..%2Fx');
    expect(segment('100%')).toBe('100%25');
    expect(segment('a b')).toBe('a%20b');
  });

  it('turns a number into its digits', () => {
    expect(segment(7)).toBe('7');
  });
});

describe('parse, getJson and sendJson check what the server answered', () => {
  const answer = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status }))
    );

  it('returns a body the guard accepts', async () => {
    answer(200, { n: 1 });
    expect(await getJson('/x', isNumberBox)).toEqual({ n: 1 });
    expect(await sendJson('POST', '/x', isNumberBox, { any: 1 })).toEqual({ n: 1 });
  });

  it('refuses a 200 that is not what the page expects, and says which path', async () => {
    answer(200, { n: 'x' });
    await expect(getJson('/api/thing', isNumberBox)).rejects.toBeInstanceOf(BadResponse);
    await expect(getJson('/api/thing', isNumberBox)).rejects.toThrow('/api/thing');
    await expect(sendJson('PUT', '/api/thing', isNumberBox)).rejects.toBeInstanceOf(BadResponse);
  });

  it('refuses a 200 that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy</html>', { status: 200 }))
    );
    await expect(getJson('/x', isNumberBox)).rejects.toBeInstanceOf(BadResponse);
  });

  it('keeps an error status an HttpError with its body, whatever the guard says', async () => {
    answer(409, { errors: { id: 'taken' } });
    const error = await getJson('/x', isNumberBox).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    expect((error as HttpError).body).toEqual({ errors: { id: 'taken' } });
  });

  it('parse works on a response the caller fetched itself', async () => {
    expect(await parse(Response.json({ n: 2 }), isNumberBox)).toEqual({ n: 2 });
    await expect(
      parse(Response.json({ n: 2 }, { status: 500 }), isNumberBox)
    ).rejects.toBeInstanceOf(HttpError);
    await expect(parse(Response.json([]), isNumberBox, '/p')).rejects.toBeInstanceOf(BadResponse);
  });
});
