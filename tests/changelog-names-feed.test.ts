import { describe, it, expect } from 'vitest';
import { modifierLabel, versionPageUrl } from '../src/changelog/names.js';
import { relativeAgo } from '../src/changelog/feed.js';

const e = (over: any = {}) =>
  ({
    version_id: 10,
    object_type: 'hook',
    object_id: 48,
    name: 'Export to ERP',
    version_event: 'update',
    changed_fields: ['config'],
    version_created_at: '2026-09-29T09:00:00Z',
    modifier_id: 7,
    ...over,
  }) as any;

const NOW = Date.parse('2026-09-29T12:00:00Z');

describe('modifierLabel', () => {
  it('distinguishes system, resolved and unresolved users (§2p)', () => {
    const users = new Map([[7, 'Jane Doe']]);
    expect(modifierLabel(null, users)).toBe('System');
    expect(modifierLabel(7, users)).toBe('Jane Doe');
    expect(modifierLabel(12345, users)).toBe('User 12345');
  });
});

describe('links and labels', () => {
  it("builds Rossum's version page URL (§2m)", () => {
    expect(versionPageUrl('https://org.rossum.app', e())).toBe(
      'https://org.rossum.app/settings/configuration-changelog/10?objectType=hook&objectId=48',
    );
  });
});

describe('relativeAgo', () => {
  it('formats minutes, hours, yesterday and days', () => {
    expect(relativeAgo('2026-09-29T11:59:40Z', NOW)).toBe('just now');
    expect(relativeAgo('2026-09-29T11:30:00Z', NOW)).toBe('30 min ago');
    expect(relativeAgo('2026-09-29T09:00:00Z', NOW)).toBe('3 h ago');
    expect(relativeAgo('2026-09-28T09:00:00Z', NOW)).toBe('yesterday');
    expect(relativeAgo('2026-09-25T09:00:00Z', NOW)).toBe('4 d ago');
    expect(relativeAgo('garbage', NOW)).toBe('');
  });
});
