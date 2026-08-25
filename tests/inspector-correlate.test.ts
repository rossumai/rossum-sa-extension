import { describe, it, expect } from 'vitest';
import { correlateMessage, correlateField } from '../src/inspector/correlate.js';
import { REL } from '../src/inspector/culprit.js';

describe('correlateMessage', () => {
  const hooksById = { 50: { id: 50, name: 'Rejector' } };
  it('ties a message to a hook by request_id (VERIFIED)', () => {
    const msg = { requestId: 'r1', culprit: null };
    const out = correlateMessage(msg, {
      hookLogs: [{ hook_id: 50, request_id: 'r1' }],
      ruleLogs: [],
      hooksById,
    });
    expect(out).toEqual({
      culprit: { kind: 'hook', id: 50, name: 'Rejector' },
      reliability: REL.VERIFIED,
    });
  });
  it('matches on the log uuid when request_id differs', () => {
    const out = correlateMessage(
      { requestId: 'u9' },
      { hookLogs: [{ hook_id: 50, uuid: 'u9' }], ruleLogs: [], hooksById },
    );
    expect(out).toEqual({
      culprit: { kind: 'hook', id: 50, name: 'Rejector' },
      reliability: REL.VERIFIED,
    });
  });
  it('falls back to a rule log (BEST_EFFORT) when no hook log matches', () => {
    const out = correlateMessage(
      { requestId: 'r2' },
      { hookLogs: [], ruleLogs: [{ rule_id: 7, rule_name: 'Tag', request_id: 'r2' }], hooksById },
    );
    expect(out).toEqual({
      culprit: { kind: 'rule', id: 7, name: 'Tag' },
      reliability: REL.BEST_EFFORT,
    });
  });
  it('returns null with no request_id or no match', () => {
    expect(
      correlateMessage({ requestId: null }, { hookLogs: [], ruleLogs: [], hooksById }),
    ).toBeNull();
    expect(
      correlateMessage(
        { requestId: 'x' },
        { hookLogs: [{ hook_id: 1, request_id: 'y' }], ruleLogs: [], hooksById },
      ),
    ).toBeNull();
  });
  it('still VERIFIED when several logs share the request_id but all belong to ONE hook', () => {
    const out = correlateMessage(
      { requestId: 'r1' },
      {
        hookLogs: [
          { hook_id: 50, request_id: 'r1', action: 'started' },
          { hook_id: 50, request_id: 'r1', action: 'export' },
        ],
        ruleLogs: [],
        hooksById,
      },
    );
    expect(out).toEqual({
      culprit: { kind: 'hook', id: 50, name: 'Rejector' },
      reliability: REL.VERIFIED,
    });
  });
  it('does NOT over-claim: a request_id shared across DIFFERENT hooks downgrades to BEST_EFFORT (first candidate), not VERIFIED', () => {
    const out = correlateMessage(
      { requestId: 'shared' },
      {
        hookLogs: [
          { hook_id: 50, request_id: 'shared' },
          { hook_id: 51, request_id: 'shared' },
        ],
        ruleLogs: [],
        hooksById,
      },
    );
    // Not invocation-unique → keep the first hook as an honest best-effort candidate
    // (so a culprit still shows when the AI tier is offline), but never claim VERIFIED.
    expect(out).toEqual({
      culprit: { kind: 'hook', id: 50, name: 'Rejector' },
      reliability: REL.BEST_EFFORT,
    });
  });
});

describe('correlateField', () => {
  const rules = [{ id: 7, name: 'Set terms', actions: [{ payload: { schema_id: 'terms' } }] }];
  it('ties a rules-sourced field to a fired rule that targets it (BEST_EFFORT)', () => {
    const out = correlateField('terms', {
      ruleLogs: [{ rule_id: 7, execution_result: 'success' }],
      rules,
    });
    expect(out).toEqual({
      culprit: { kind: 'rule', id: 7, name: 'Set terms' },
      reliability: REL.BEST_EFFORT,
    });
  });
  it('ignores a rule that did not fire, or does not target the field', () => {
    expect(
      correlateField('terms', { ruleLogs: [{ rule_id: 7, execution_result: 'skipped' }], rules }),
    ).toBeNull();
    expect(
      correlateField('other', { ruleLogs: [{ rule_id: 7, execution_result: 'success' }], rules }),
    ).toBeNull();
  });
});
