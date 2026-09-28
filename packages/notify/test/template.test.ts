import { describe, expect, it } from 'vitest';
import type { Alert } from '@pipulse/alerts';
import {
  checkTemplate,
  defaultBody,
  fieldsFor,
  formatDuration,
  formatValue,
  renderPayload,
  renderTemplate,
  TemplateError
} from '../src/template.js';

const MIN = 60_000;
const alert: Alert = {
  id: 7,
  ruleId: 'cpu_hot',
  metric: 'cpu_temperature',
  severity: 'critical',
  message: 'CPU running hot',
  value: 82.44,
  raisedAt: new Date(2026, 8, 24, 10, 42).getTime(),
  clearedAt: null,
  clearedBy: null,
  acknowledgedAt: null,
  ruleHash: null
};
const context = {
  hostname: 'Io',
  metrics: [{ id: 'cpu_temperature', label: 'CPU temperature', unit: '°C' }]
};

describe('templates', () => {
  it('replaces placeholders only inside strings and keeps a lone placeholder typed', () => {
    const fields = fieldsFor('raised', alert, context);
    expect(
      renderTemplate(
        {
          n: 3,
          t: '{{severity}}: {{message}}',
          v: '{{rawValue}}',
          c: '{{clearedAt}}',
          s: 'at {{clearedAt}}.'
        },
        fields
      )
    ).toEqual({ n: 3, t: 'critical: CPU running hot', v: 82.44, c: null, s: 'at .' });
    expect(renderTemplate(['{{hostname}}', { deep: ['{{metric}}'] }], fields)).toEqual([
      'Io',
      { deep: ['cpu_temperature'] }
    ]);
  });

  it('renders a silence alert value as null (lone) and "" (in text)', () => {
    const silent = { ...alert, value: null };
    const silentFields = fieldsFor('raised', silent, context);
    expect(silentFields.rawValue).toBeNull();
    expect(silentFields.value).toBeNull();
    expect(
      renderTemplate({ v: '{{rawValue}}', vv: '{{value}}', s: 'v={{value}}' }, silentFields)
    ).toEqual({ v: null, vv: null, s: 'v=' });
  });

  it('keeps JSON valid and never re-expands braces from a value', () => {
    const tricky = { ...alert, message: 'Disk "/" at {{90%}} \\ done' };
    const payload = renderPayload({ text: '{{message}}' }, 'raised', tricky, context);
    expect(JSON.parse(payload)).toEqual({ text: 'Disk "/" at {{90%}} \\ done' });
  });

  it('refuses unknown placeholders anywhere in the template', () => {
    expect(() => checkTemplate({ a: ['x {{nope}}'] })).toThrow(TemplateError);
    expect(() => checkTemplate({ a: ['x {{nope}}'] })).toThrow(/nope/);
    expect(() => checkTemplate({ a: '{{message}} {{hostname}}' })).not.toThrow();
  });

  it('fills fields for a raise and a clear', () => {
    expect(fieldsFor('raised', alert, context)).toMatchObject({
      event: 'raised',
      metricLabel: 'CPU temperature',
      value: '82.4 °C',
      rawValue: 82.44,
      raisedAt: '2026-09-24 10:42',
      clearedAt: null,
      duration: null,
      clearedBy: null,
      hostname: 'Io'
    });
    const cleared = {
      ...alert,
      clearedAt: alert.raisedAt + 12 * MIN,
      clearedBy: 'condition' as const
    };
    expect(fieldsFor('cleared', cleared, context)).toMatchObject({
      event: 'cleared',
      duration: '12 min',
      clearedBy: 'condition'
    });
  });

  it('formats durations and values', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(3 * 60 * MIN + 5 * MIN)).toBe('3 h');
    expect(formatDuration(2 * 24 * 60 * MIN)).toBe('2 d');
    expect(formatValue(81, '%')).toBe('81 %');
    expect(formatValue(3, '')).toBe('3');
    expect(formatValue(0x50005, 'flags')).toBe('0x50005');
  });

  it('builds the Apprise default body with a type per event', () => {
    const body = (event: 'raised' | 'cleared' | 'test', severity: 'warning' | 'critical') =>
      JSON.parse(renderPayload(undefined, event, { ...alert, severity }, context));
    expect(body('raised', 'critical')).toEqual({
      title: 'Io: CPU running hot',
      body: 'CPU temperature 82.4 °C (critical, raised)',
      type: 'failure'
    });
    expect(body('raised', 'warning').type).toBe('warning');
    expect(body('cleared', 'critical').type).toBe('success');
    expect(body('test', 'warning').type).toBe('info');
    expect(defaultBody('raised', 'warning')).toMatchObject({ title: '{{hostname}}: {{message}}' });
  });
});
