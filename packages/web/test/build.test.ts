import { afterEach, describe, expect, it, vi } from 'vitest';
import { staleDashboard, WEB_VERSION } from '../src/build.js';

describe('staleDashboard', () => {
  it('is true only when both versions are known and differ', () => {
    expect(staleDashboard('0.7.0', '0.7.1')).toBe(true);
    expect(staleDashboard('0.7.1', '0.7.0')).toBe(true);
    expect(staleDashboard('0.7.1', '0.7.1')).toBe(false);
  });

  it('never calls a development build or an unversioned server stale', () => {
    expect(staleDashboard('dev', '0.7.1')).toBe(false);
    expect(staleDashboard('0.7.1', 'dev')).toBe(false);
    expect(staleDashboard('0.7.1', undefined)).toBe(false);
    expect(staleDashboard('', '0.7.1')).toBe(false);
  });
});

describe('WEB_VERSION', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('is dev when the build did not stamp one (tests, npm run dev)', () => {
    expect(WEB_VERSION).toBe('dev');
  });

  it('is the version the build stamped (the define Vite replaces at build time)', async () => {
    vi.stubGlobal('__PIPULSE_WEB_VERSION__', '0.7.1');
    vi.resetModules();
    expect((await import('../src/build.js')).WEB_VERSION).toBe('0.7.1');
  });

  it('is dev when the stamp is empty', async () => {
    vi.stubGlobal('__PIPULSE_WEB_VERSION__', '');
    vi.resetModules();
    expect((await import('../src/build.js')).WEB_VERSION).toBe('dev');
  });
});
