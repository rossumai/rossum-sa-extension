import { describe, it, expect } from 'vitest';
import { resourceFromApiUrl } from '../src/devtools/resourceFromApiUrl.js';

describe('resourceFromApiUrl', () => {
  it('maps known collections to type/label with an id and apiPath', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/schemas/42'))
      .toEqual({ type: 'schema', id: '42', apiPath: '/api/v1/schemas/42', label: 'Schema' });
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/workspaces/7'))
      .toEqual({ type: 'workspace', id: '7', apiPath: '/api/v1/workspaces/7', label: 'Workspace' });
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/organizations/1'))
      .toEqual({ type: 'organization', id: '1', apiPath: '/api/v1/organizations/1', label: 'Organization' });
  });
  it('tolerates a trailing slash / query', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/queues/9?x=1')!.id).toBe('9');
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/hooks/3/')!.id).toBe('3');
  });
  it('maps inboxes to type inbox with a mapped label', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/inboxes/5'))
      .toEqual({ type: 'inbox', id: '5', apiPath: '/api/v1/inboxes/5', label: 'Inbox' });
  });
  it('falls back generically for an unknown collection', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/unknowns/5'))
      .toEqual({ type: 'unknowns', id: '5', apiPath: '/api/v1/unknowns/5', label: 'Unknown' });
  });
  it('returns null for non-Rossum-API strings', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/queues/1')).toBeNull(); // dashboard URL, not /api/v1
    expect(resourceFromApiUrl('hello')).toBeNull();
    expect(resourceFromApiUrl(null)).toBeNull();
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/queues')).toBeNull(); // collection, no id
  });
  it('singularizes generic fallback labels correctly', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/pages/3')!.label).toBe('Page');
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/duplicates/4')!.label).toBe('Duplicate');
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/inboxes/5')!.label).toBe('Inbox');
  });
  it('captures a sub-resource path as a distinct read-only resource', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/annotations/123/content'))
      .toEqual({ type: 'annotations', id: '123', apiPath: '/api/v1/annotations/123/content', label: 'Content', readOnly: true });
  });
  it('captures a sub-resource path ending in a numeric id (e.g. a datapoint content)', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/annotations/138328520/content/19453284337'))
      .toEqual({
        type: 'annotations',
        id: '138328520',
        apiPath: '/api/v1/annotations/138328520/content/19453284337',
        label: 'Content 19453284337',
        readOnly: true,
      });
  });
  it('tolerates a trailing slash / query on a numeric sub-resource path', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/annotations/1/content/2/')!.apiPath)
      .toBe('/api/v1/annotations/1/content/2');
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/annotations/1/content/2?x=1')!.label)
      .toBe('Content 2');
  });
  it('a no-sub URL is unchanged (editable, no readOnly)', () => {
    const r = resourceFromApiUrl('https://acme.rossum.app/api/v1/schemas/9');
    expect(r).toEqual({ type: 'schema', id: '9', apiPath: '/api/v1/schemas/9', label: 'Schema' });
    expect(r!.readOnly).toBeUndefined();
  });
  it('still tolerates a trailing slash on a no-sub URL', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/hooks/3/')!.id).toBe('3');
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/hooks/3/')!.apiPath).toBe('/api/v1/hooks/3');
  });
  it('marks organization_groups read-only (viewable but not PATCHable)', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/organization_groups/49101'))
      .toEqual({ type: 'organization_group', id: '49101', apiPath: '/api/v1/organization_groups/49101', label: 'Organization group', readOnly: true });
  });
  it('a normal editable collection has no readOnly flag', () => {
    expect(resourceFromApiUrl('https://acme.rossum.app/api/v1/queues/1')!.readOnly).toBeUndefined();
  });
});

// append to tests/devtools-resourcefromurl.test.js
import { genericResourceFromPath } from '../src/devtools/resourceFromApiUrl.js';

describe('genericResourceFromPath', () => {
  it('builds a read-only descriptor for a bare collection', () => {
    expect(genericResourceFromPath('/api/v1/queues'))
      .toEqual({ type: 'queues', apiPath: '/api/v1/queues', label: 'queues', readOnly: true });
  });
  it('keeps the query string in apiPath and label', () => {
    const r = genericResourceFromPath('/api/v1/annotations?queue=1&status=to_review')!;
    expect(r.apiPath).toBe('/api/v1/annotations?queue=1&status=to_review');
    expect(r.type).toBe('annotations');
    expect(r.readOnly).toBe(true);
  });
  it('truncates a very long label with an ellipsis', () => {
    const long = '/api/v1/annotations?' + 'x=1&'.repeat(30);
    expect(genericResourceFromPath(long)!.label.length).toBeLessThanOrEqual(40);
  });
  it('returns null for a non /api/v1 path', () => {
    expect(genericResourceFromPath('/nope')).toBeNull();
  });
});
