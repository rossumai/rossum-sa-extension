import { describe, it, expect } from 'vitest';
import {
  MAX_PLAN_TASKS,
  MAX_TOTAL_TASKS,
  buildPlanPrompt,
  buildTaskPrompt,
  buildTaskCheckPrompt,
  parsePlan,
  parseDiscovered,
} from '../src/fabry/architect/plan.js';

describe('buildPlanPrompt', () => {
  it('includes "JSON array" and the cap number', () => {
    const prompt = buildPlanPrompt('Add VAT validation');
    expect(prompt).toContain('JSON array');
    expect(prompt).toContain(String(MAX_PLAN_TASKS));
  });

  it('includes "inspect" instruction', () => {
    const prompt = buildPlanPrompt('Add VAT validation');
    expect(prompt).toContain('inspect');
  });

  it('includes the requirement text', () => {
    const prompt = buildPlanPrompt('Add VAT validation');
    expect(prompt).toContain('Add VAT validation');
  });

  it('includes "REQUIREMENT:" label', () => {
    const prompt = buildPlanPrompt('Add VAT validation');
    expect(prompt).toContain('REQUIREMENT:');
  });

  it('handles empty requirement gracefully', () => {
    const prompt = buildPlanPrompt('');
    expect(prompt).toBeDefined();
    expect(prompt).toContain('JSON array');
  });
});

describe('buildTaskPrompt', () => {
  it('includes "Do THIS task only"', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('Do THIS task only');
  });

  it('includes safety rules: "BACKWARD COMPATIBILITY"', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('BACKWARD COMPATIBILITY');
  });

  it('includes safety rules: "NEVER lose customer DATA"', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('NEVER lose customer DATA');
  });

  it('includes "ALREADY DONE" section when doneTasks provided', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    }, {
      doneTasks: ['created queue'],
    });
    expect(prompt).toContain('ALREADY DONE');
    expect(prompt).toContain('created queue');
  });

  it('omits "ALREADY DONE" section when doneTasks is empty', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    }, {
      doneTasks: [],
    });
    expect(prompt).not.toContain('ALREADY DONE');
  });

  it('includes journal attempts with summary, verdict, and learnings', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    }, {
      journal: [{ attempt: 1, summary: 'tried X', verdict: 'fail', learnings: 'no fire' }],
    });
    expect(prompt).toContain('PREVIOUS ATTEMPTS');
    expect(prompt).toContain('attempt 1');
    expect(prompt).toContain('tried X');
    expect(prompt).toContain('fail');
    expect(prompt).toContain('no fire');
  });

  it('includes "NEW TASKS:" instruction', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('NEW TASKS:');
  });

  it('includes the task text under "THIS TASK:"', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('THIS TASK:');
    expect(prompt).toContain('create the VAT rule');
  });

  it('includes "DONE WHEN:" with acceptance criteria', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('DONE WHEN: a rule named VAT exists');
  });

  it('omits "DONE WHEN:" when acceptance is empty', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: '',
    });
    expect(prompt).not.toContain('DONE WHEN:');
  });

  it('includes the deliverable context under "SOW REQUIREMENT"', () => {
    const prompt = buildTaskPrompt('Add VAT validation', {
      text: 'create the VAT rule',
      acceptance: 'a rule named VAT exists',
    });
    expect(prompt).toContain('SOW REQUIREMENT');
    expect(prompt).toContain('Add VAT validation');
  });
});

describe('buildTaskCheckPrompt', () => {
  it('includes read-only instruction', () => {
    const prompt = buildTaskCheckPrompt('create the VAT rule', 'a rule named VAT exists');
    expect(prompt).toContain('READ-ONLY');
  });

  it('includes all three VERDICT options in instructions', () => {
    const prompt = buildTaskCheckPrompt('create the VAT rule', 'a rule named VAT exists');
    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('VERDICT: FAIL');
    expect(prompt).toContain('VERDICT: UNCERTAIN');
  });

  it('includes the task text under "TASK:"', () => {
    const prompt = buildTaskCheckPrompt('create the VAT rule', 'a rule named VAT exists');
    expect(prompt).toContain('TASK:');
    expect(prompt).toContain('create the VAT rule');
  });

  it('includes "DONE WHEN:" with acceptance criteria', () => {
    const prompt = buildTaskCheckPrompt('create the VAT rule', 'a rule named VAT exists');
    expect(prompt).toContain('DONE WHEN: a rule named VAT exists');
  });

  it('omits "DONE WHEN:" when acceptance is empty', () => {
    const prompt = buildTaskCheckPrompt('create the VAT rule', '');
    expect(prompt).not.toContain('DONE WHEN:');
  });
});

describe('parsePlan', () => {
  it('parses raw JSON array with {text, acceptance} objects', () => {
    const json = '[{"text":"task 1","acceptance":"check 1"},{"text":"task 2","acceptance":"check 2"}]';
    const result = parsePlan(json);
    expect(result).toEqual([
      { text: 'task 1', acceptance: 'check 1' },
      { text: 'task 2', acceptance: 'check 2' },
    ]);
  });

  it('parses fenced JSON array', () => {
    const fenced = '```json\n[{"text":"task 1","acceptance":"check 1"}]\n```';
    const result = parsePlan(fenced);
    expect(result).toEqual([{ text: 'task 1', acceptance: 'check 1' }]);
  });

  it('parses prose-wrapped array with text before/after', () => {
    const prose = 'Here is the plan:\n[{"text":"task 1","acceptance":"check 1"}]\nEnd of plan.';
    const result = parsePlan(prose);
    expect(result).toEqual([{ text: 'task 1', acceptance: 'check 1' }]);
  });

  it('converts string elements to {text, acceptance:""}', () => {
    const json = '["task 1","task 2"]';
    const result = parsePlan(json);
    expect(result).toEqual([
      { text: 'task 1', acceptance: '' },
      { text: 'task 2', acceptance: '' },
    ]);
  });

  it('trims whitespace from text and acceptance', () => {
    const json = '[{"text":"  task 1  ","acceptance":"  check 1  "}]';
    const result = parsePlan(json);
    expect(result).toEqual([{ text: 'task 1', acceptance: 'check 1' }]);
  });

  it('filters out empty text elements', () => {
    const json = '[{"text":"task 1"},{"text":""},{"text":"task 2"}]';
    const result = parsePlan(json);
    expect(result).toEqual([
      { text: 'task 1', acceptance: '' },
      { text: 'task 2', acceptance: '' },
    ]);
  });

  it('returns empty array for invalid JSON', () => {
    const result = parsePlan('not json at all');
    expect(result).toEqual([]);
  });

  it('caps results at MAX_PLAN_TASKS (12)', () => {
    const items = Array(15).fill(0).map((_, i) => ({ text: `task ${i}`, acceptance: '' }));
    const json = JSON.stringify(items);
    const result = parsePlan(json);
    expect(result).toHaveLength(MAX_PLAN_TASKS);
  });

  it('respects custom cap parameter', () => {
    const json = '[{"text":"t1"},{"text":"t2"},{"text":"t3"},{"text":"t4"},{"text":"t5"}]';
    const result = parsePlan(json, 3);
    expect(result).toHaveLength(3);
  });

  it('handles null/undefined gracefully', () => {
    expect(parsePlan(null)).toEqual([]);
    expect(parsePlan(undefined)).toEqual([]);
  });
});

describe('parseDiscovered', () => {
  it('parses "NEW TASKS:" section with dash-separated lines', () => {
    const text = 'Some text\nNEW TASKS:\n- do X :: X exists\n- do Y :: Y exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([
      { text: 'do X', acceptance: 'X exists' },
      { text: 'do Y', acceptance: 'Y exists' },
    ]);
  });

  it('parses with bullet points instead of dashes', () => {
    const text = 'NEW TASKS:\n* do X :: X exists\n* do Y :: Y exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([
      { text: 'do X', acceptance: 'X exists' },
      { text: 'do Y', acceptance: 'Y exists' },
    ]);
  });

  it('handles lines with no "::" (acceptance is empty)', () => {
    const text = 'NEW TASKS:\n- do X\n- do Y :: Y exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([
      { text: 'do X', acceptance: '' },
      { text: 'do Y', acceptance: 'Y exists' },
    ]);
  });

  it('returns empty array when no "NEW TASKS:" section found', () => {
    const text = 'Some text without new tasks';
    const result = parseDiscovered(text);
    expect(result).toEqual([]);
  });

  it('stops at MAX_TOTAL_TASKS cap', () => {
    const tasks = Array(25)
      .fill(0)
      .map((_, i) => `- task ${i} :: check ${i}`)
      .join('\n');
    const text = `NEW TASKS:\n${tasks}`;
    const result = parseDiscovered(text);
    expect(result).toHaveLength(MAX_TOTAL_TASKS);
  });

  it('respects custom cap parameter', () => {
    const text = 'NEW TASKS:\n- task 1 :: check 1\n- task 2 :: check 2\n- task 3 :: check 3\n- task 4 :: check 4\n- task 5 :: check 5';
    const result = parseDiscovered(text, 3);
    expect(result).toHaveLength(3);
  });

  it('skips empty lines', () => {
    const text = 'NEW TASKS:\n- do X :: X exists\n\n\n- do Y :: Y exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([
      { text: 'do X', acceptance: 'X exists' },
      { text: 'do Y', acceptance: 'Y exists' },
    ]);
  });

  it('ignores case for "NEW TASKS:" label', () => {
    const text = 'Some text\nnew tasks:\n- do X :: X exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([{ text: 'do X', acceptance: 'X exists' }]);
  });

  it('skips "NEW TASKS:" label if it appears as a line item', () => {
    const text = 'NEW TASKS:\n- new tasks: something\n- do X :: X exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([{ text: 'do X', acceptance: 'X exists' }]);
  });

  it('skips lines that start with "VERDICT:" but continues parsing tasks', () => {
    const text = 'NEW TASKS:\n- do X :: X exists\nVERDICT: PASS\n- do Y :: Y exists';
    const result = parseDiscovered(text);
    expect(result).toEqual([
      { text: 'do X', acceptance: 'X exists' },
      { text: 'do Y', acceptance: 'Y exists' },
    ]);
  });

  it('handles null/undefined gracefully', () => {
    expect(parseDiscovered(null)).toEqual([]);
    expect(parseDiscovered(undefined)).toEqual([]);
  });

  it('trims whitespace from task text and acceptance', () => {
    const text = 'NEW TASKS:\n-   do X   ::   X exists   ';
    const result = parseDiscovered(text);
    expect(result).toEqual([{ text: 'do X', acceptance: 'X exists' }]);
  });

  it('handles multiple "::" in a line (splits on first)', () => {
    const text = 'NEW TASKS:\n- do X :: check with :: double colon';
    const result = parseDiscovered(text);
    expect(result).toEqual([{ text: 'do X', acceptance: 'check with :: double colon' }]);
  });

  it('does NOT turn free-form "no tasks" prose into a phantom task', () => {
    // The model commonly ends a write turn with prose, not a bullet list. Prose
    // (no bullet) must never become a write-enabled task against the live org.
    expect(parseDiscovered('NEW TASKS: none required — the queue was already configured.')).toEqual([]);
    expect(parseDiscovered('NEW TASKS:\nnone needed, everything is already in place')).toEqual([]);
    expect(parseDiscovered('NEW TASKS:\nI do not think any further tasks are needed here.')).toEqual([]);
  });

  it('ignores a bulleted whole-line no-op marker', () => {
    expect(parseDiscovered('NEW TASKS:\n- none')).toEqual([]);
    expect(parseDiscovered('NEW TASKS:\n- n/a')).toEqual([]);
    expect(parseDiscovered('NEW TASKS:\n- nothing needed')).toEqual([]);
  });

  it('accepts numbered-list markers ("1." / "2)") as tasks, still rejecting prose', () => {
    const result = parseDiscovered('NEW TASKS:\n1. create the MDH dataset :: dataset exists\n2) add the lookup rule');
    expect(result).toEqual([
      { text: 'create the MDH dataset', acceptance: 'dataset exists' },
      { text: 'add the lookup rule', acceptance: '' },
    ]);
    // a bare unmarked prose line is still not a task
    expect(parseDiscovered('NEW TASKS:\ncreate the MDH dataset first')).toEqual([]);
  });
  it('still keeps a genuine bulleted task even when it happens to start with "No"', () => {
    // Only WHOLE-line no-op markers are skipped; a real task with a "::" is kept.
    const result = parseDiscovered('NEW TASKS:\n- No VAT rule exists yet, so create one :: a VAT rule exists');
    expect(result).toEqual([{ text: 'No VAT rule exists yet, so create one', acceptance: 'a VAT rule exists' }]);
  });
});
