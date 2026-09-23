import { describe, expect, it } from 'vitest';
import { applyAlertEvent, worstAlert } from '../src/alerts.js';
import type { Alert } from '../src/types.js';

const alert = (id: number, severity: Alert['severity'], raisedAt: number): Alert => ({
  id,
  ruleId: `r${id}`,
  metric: 'cpu_temperature',
  severity,
  message: 'm',
  value: 1,
  raisedAt,
  clearedAt: null,
  clearedBy: null
});

describe('applyAlertEvent', () => {
  it('adds a raised alert first, replaces a known one, and drops a cleared one', () => {
    const a = alert(1, 'warning', 10);
    const b = alert(2, 'critical', 20);
    expect(applyAlertEvent([a], 'raised', b)).toEqual([b, a]);
    expect(applyAlertEvent([a, b], 'raised', { ...a, message: 'new' })).toEqual([
      { ...a, message: 'new' },
      b
    ]);
    expect(
      applyAlertEvent([a, b], 'cleared', { ...b, clearedAt: 30, clearedBy: 'condition' })
    ).toEqual([a]);
  });
});

describe('worstAlert', () => {
  it('prefers critical, then the longest open', () => {
    const warm = alert(1, 'warning', 10);
    const hot = alert(2, 'critical', 30);
    const hotter = alert(3, 'critical', 20);
    expect(worstAlert([warm, hot, hotter])).toBe(hotter);
    expect(worstAlert([warm])).toBe(warm);
    expect(worstAlert([])).toBeUndefined();
  });
});
