import { describe, expect, it } from 'vitest';
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
  it('is dev when the build did not stamp one (tests, npm run dev)', () => {
    expect(WEB_VERSION).toBe('dev');
  });
});
