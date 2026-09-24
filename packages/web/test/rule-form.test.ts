import { describe, expect, it } from 'vitest';
import { bodyOf, draftOf, emptyDraft, formErrors, toggleRequest } from '../src/rule-form.js';
import type { RuleEntry } from '../src/types.js';

const written = {
  id: 'cpu_hot',
  metric: 'cpu_temperature',
  atLeast: 80,
  for: '2min',
  clearAfter: '2min',
  severity: 'critical',
  message: 'CPU running hot'
};

describe('draftOf / bodyOf', () => {
  it('round-trips a threshold rule', () => {
    const draft = draftOf(written);
    expect(draft).toMatchObject({ condition: 'atLeast', value: '80', for: '2min' });
    expect(bodyOf(draft)).toEqual({ ok: true, body: written });
  });

  it('shows a bit mask in hex and reads hex or decimal back', () => {
    const draft = draftOf({ ...written, atLeast: undefined, bitsSet: 15 });
    expect(draft).toMatchObject({ condition: 'bitsSet', value: '0xf' });
    expect(bodyOf({ ...draft, value: '0x50000' })).toMatchObject({
      ok: true,
      body: { bitsSet: 0x50000 }
    });
    expect(bodyOf({ ...draft, value: '16' })).toMatchObject({ ok: true, body: { bitsSet: 16 } });
  });

  it('sends no for or clearAfter with a silence rule, and leaves empty ones out', () => {
    const silence = {
      ...emptyDraft('*'),
      id: 'quiet',
      condition: 'noReadingFor' as const,
      value: 'auto',
      for: '5min',
      message: 'Quiet'
    };
    const result = bodyOf(silence);
    expect(result).toMatchObject({ ok: true, body: { noReadingFor: 'auto' } });
    expect(result.ok && 'for' in result.body).toBe(false);
    const threshold = bodyOf({
      ...emptyDraft('cpu_load'),
      id: 'x',
      value: '5',
      for: '',
      message: 'm'
    });
    expect(threshold.ok && 'for' in threshold.body).toBe(false);
  });

  it('catches a value that is not a number before asking the server', () => {
    expect(bodyOf({ ...emptyDraft('cpu_load'), value: 'lots' })).toEqual({
      ok: false,
      errors: { value: 'Enter a number.' }
    });
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '0xZZ' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
    // bitsSet must be positive integers
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '2.5' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '-5' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '0' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
    expect(bodyOf({ ...emptyDraft('cpu_load'), condition: 'bitsSet', value: '0x0' })).toEqual({
      ok: false,
      errors: { value: 'Enter a mask like 0xf.' }
    });
    // atLeast still accepts negative numbers and decimals
    expect(
      bodyOf({ ...emptyDraft('cpu_load'), condition: 'atLeast', value: '-2.5' })
    ).toMatchObject({
      ok: true,
      body: { atLeast: -2.5 }
    });
  });
});

describe('formErrors', () => {
  it('puts each server error under its form field', () => {
    expect(formErrors({ atLeast: 'a', bitsSet: 'b' }).value).toBe('b');
    expect(formErrors({ for: 'f', condition: 'c', rule: 'r' })).toEqual({
      for: 'f',
      condition: 'c',
      form: 'r'
    });
  });
});

describe('toggleRequest', () => {
  const entry = (over: Partial<RuleEntry>): RuleEntry => ({
    id: 'cpu_hot',
    kind: 'built-in',
    disabled: false,
    rule: null,
    written,
    overrides: null,
    problem: null,
    saved: false,
    ...over
  });
  it('disables a built-in with a bare entry and enables it by removing that entry', () => {
    expect(toggleRequest(entry({}))).toEqual({
      method: 'PUT',
      body: { id: 'cpu_hot', disabled: true }
    });
    expect(toggleRequest(entry({ disabled: true, saved: true }))).toEqual({ method: 'DELETE' });
  });
  it('keeps the settings of an edited or added rule while it is off', () => {
    expect(toggleRequest(entry({ kind: 'added' }))).toEqual({
      method: 'PUT',
      body: { ...written, disabled: true }
    });
    expect(
      toggleRequest(
        entry({ kind: 'edited', disabled: true, written: { ...written, disabled: true } })
      )
    ).toEqual({
      method: 'PUT',
      body: written
    });
  });
});
