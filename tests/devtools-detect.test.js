// tests/devtools-detect.test.js
import { describe, it, expect } from 'vitest';
import { detectResource } from '../src/devtools/detect.js';

describe('detectResource', () => {
  it('detects a queue detail page', () => {
    expect(detectResource({ pathname: '/queues/42/settings/basic' }))
      .toEqual({ type: 'queue', id: '42', apiPath: '/api/v1/queues/42', label: 'Queue' });
  });
  it('detects a hook detail page', () => {
    expect(detectResource({ pathname: '/extensions/my-extensions/7' }))
      .toEqual({ type: 'hook', id: '7', apiPath: '/api/v1/hooks/7', label: 'Hook' });
  });
  it('detects a user detail page', () => {
    expect(detectResource({ pathname: '/settings/users/9' }))
      .toEqual({ type: 'user', id: '9', apiPath: '/api/v1/users/9', label: 'User' });
  });
  it('returns null on list pages and unknown routes', () => {
    expect(detectResource({ pathname: '/queues' })).toBeNull();
    expect(detectResource({ pathname: '/annotations' })).toBeNull();
    expect(detectResource({ pathname: '/' })).toBeNull();
  });
  it('is null-safe', () => {
    expect(detectResource(null)).toBeNull();
    expect(detectResource({})).toBeNull();
  });
  it('detects a rule detail page (nested under a queue) as a rule, not the queue', () => {
    expect(detectResource({ pathname: '/queues/5/settings/rules/9/detail' }))
      .toEqual({ type: 'rule', id: '9', apiPath: '/api/v1/rules/9', label: 'Rule' });
  });
  it('detects a queue settings page (no rule) as a queue', () => {
    expect(detectResource({ pathname: '/queues/5/settings/basic' }))
      .toEqual({ type: 'queue', id: '5', apiPath: '/api/v1/queues/5', label: 'Queue' });
  });
  it('detects a schema (field-manager detail) page', () => {
    expect(detectResource({ pathname: '/settings/field-manager/detail/42' }))
      .toEqual({ type: 'schema', id: '42', apiPath: '/api/v1/schemas/42', label: 'Schema' });
  });
  it('detects an engine detail page', () => {
    expect(detectResource({ pathname: '/automation/engines/7' }))
      .toEqual({ type: 'engine', id: '7', apiPath: '/api/v1/engines/7', label: 'Engine' });
  });
  it('detects an annotation via /document/<id>, tolerating a query string', () => {
    expect(detectResource({ pathname: '/document/18970431', search: '?datapointPath=1,2' }))
      .toEqual({ type: 'annotation', id: '18970431', apiPath: '/api/v1/annotations/18970431', label: 'Annotation' });
  });
  it('detects an annotation via /annotation/<id>', () => {
    expect(detectResource({ pathname: '/annotation/555' }))
      .toEqual({ type: 'annotation', id: '555', apiPath: '/api/v1/annotations/555', label: 'Annotation' });
  });
  it('resolves a queue emails page to an inbox-via-queue descriptor (before the queue route)', () => {
    expect(detectResource({ pathname: '/queues/5/settings/emails' }))
      .toEqual({ type: 'inbox', via: 'queue-inbox', queueId: '5', queueApiPath: '/api/v1/queues/5', label: 'Inbox' });
  });
  it('a plain /queues/5/settings/basic is still the queue, not emails', () => {
    expect(detectResource({ pathname: '/queues/5/settings/basic' }))
      .toEqual({ type: 'queue', id: '5', apiPath: '/api/v1/queues/5', label: 'Queue' });
  });
  it('resolves a queue fields page to a schema-via-queue descriptor (before the queue route)', () => {
    expect(detectResource({ pathname: '/queues/3927215/settings/fields' }))
      .toEqual({ type: 'schema', via: 'queue', queueId: '3927215', queueApiPath: '/api/v1/queues/3927215', label: 'Schema' });
  });
  it('also matches a deeper fields path', () => {
    expect(detectResource({ pathname: '/queues/5/settings/fields/88' }).via).toBe('queue');
  });

  it('detects a queue on /documents filtered to a single queue (level=queue)', () => {
    const filtering = JSON.stringify({ items: [{ field: 'queue', operator: 'isAnyOf', value: ['42'] }], logicOperator: 'and' });
    const search = '?filtering=' + encodeURIComponent(filtering) + '&level=queue&page=1';
    expect(detectResource({ pathname: '/documents', search }))
      .toEqual({ type: 'queue', id: '42', apiPath: '/api/v1/queues/42', label: 'Queue' });
  });

  it('does NOT detect on /documents with multiple queues selected (ambiguous)', () => {
    const filtering = JSON.stringify({ items: [{ field: 'queue', value: ['42', '43'] }] });
    expect(detectResource({ pathname: '/documents', search: '?filtering=' + encodeURIComponent(filtering) + '&level=queue' })).toBeNull();
  });

  it('does NOT detect on /documents when level is not queue', () => {
    const filtering = JSON.stringify({ items: [{ field: 'queue', value: ['42'] }] });
    expect(detectResource({ pathname: '/documents', search: '?filtering=' + encodeURIComponent(filtering) + '&level=annotation' })).toBeNull();
  });

  it('null on /documents with no queue filter', () => {
    expect(detectResource({ pathname: '/documents', search: '?level=queue' })).toBeNull();
    expect(detectResource({ pathname: '/documents' })).toBeNull();
  });

  it('detects read-only list pages', () => {
    expect(detectResource({ pathname: '/extensions/my-extensions' })).toEqual({ type: 'hook', apiPath: '/api/v1/hooks', label: 'Hooks', readOnly: true });
    expect(detectResource({ pathname: '/settings/users' })).toEqual({ type: 'user', apiPath: '/api/v1/users', label: 'Users', readOnly: true });
    expect(detectResource({ pathname: '/settings/labels' })).toEqual({ type: 'label', apiPath: '/api/v1/labels', label: 'Labels', readOnly: true });
  });

  it('list routes do not shadow the per-id detail routes', () => {
    expect(detectResource({ pathname: '/extensions/my-extensions/5' })).toEqual({ type: 'hook', id: '5', apiPath: '/api/v1/hooks/5', label: 'Hook' });
    expect(detectResource({ pathname: '/settings/users/9' })).toEqual({ type: 'user', id: '9', apiPath: '/api/v1/users/9', label: 'User' });
  });

  it('/documents?level=all → organization descriptor', () => {
    expect(detectResource({ pathname: '/documents', search: '?level=all&page=1' })).toEqual({ type: 'organization', via: 'org', label: 'Organization' });
  });
});
