import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

describe('side panel manifest', () => {
  it('declares the sidePanel permission and a default path', () => {
    expect(manifest.permissions).toContain('sidePanel');
    expect(manifest.side_panel?.default_path).toBe('sidepanel/sidepanel.html');
  });

  // Adding a permission that triggers a warning DISABLES every existing install
  // until each user re-approves it. tab.url is readable through the Rossum
  // host_permissions we already hold, so "tabs" is never needed here.
  it('adds no permission that triggers a Chrome permission warning', () => {
    const WARNS = [
      'tabs',
      'webNavigation',
      'history',
      'bookmarks',
      'downloads',
      'management',
      'debugger',
      'proxy',
      'clipboardRead',
      '<all_urls>',
    ];
    expect(manifest.permissions.filter((p: any) => WARNS.includes(p))).toEqual([]);
  });

  it('leaves host_permissions untouched (the field that disables installs)', () => {
    expect(manifest.host_permissions).toEqual([
      'http://localhost:3000/*',
      'https://*.rossum.ai/*',
      'https://*.rossum.app/*',
      'https://*.r8.lol/*',
      'https://*.rossum.cloud/*',
    ]);
  });
});
