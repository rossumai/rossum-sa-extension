// @vitest-environment jsdom
//
// The organization's environment in the Rossum header: a Sandbox / Production chip in the
// name pill, taking over from Rossum's own Sandbox chip, and a line under the header in
// the chip's colour. Its own switch, independent of the name's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  at,
  documentsHeader,
  el,
  reviewHeader,
  rossumApi,
  stubRossumApi,
} from './support/rossumHeader.js';

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const pill = () => document.querySelector<HTMLElement>('.rossum-sa-extension-org-name');
const text = () => document.querySelector<HTMLElement>('.rossum-sa-extension-org-name-text');
const chip = () => document.querySelector<HTMLElement>('.rossum-sa-extension-org-chip');
const band = () => document.querySelector<HTMLElement>('.rossum-sa-extension-org-band');
const shown = (node: HTMLElement | null) => !!node && !node.hidden;
const rossumChip = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.MuiChip-root')].find(
    (c) => c.querySelector('.MuiChip-label')!.textContent === label,
  )!;

let feature: typeof import('../src/rossum/features/org-name.js');
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.localStorage.setItem('secureToken', 'tok-sandbox');
  rossumApi.orgsByToken = {
    'tok-sandbox': [{ id: 7, name: 'Acme HQ - TEST', sandbox: true }],
    'tok-prod': [{ id: 8, name: 'Acme HQ - PROD', sandbox: false }],
  };
  rossumApi.holdList = {};
  stubRossumApi();
  sendMessage = vi.fn();
  globalThis.chrome = { runtime: { sendMessage } } as any;
  feature = await import('../src/rossum/features/org-name.js');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the environment chip', () => {
  it('says Production right before the name, inside the pill', async () => {
    window.localStorage.setItem('secureToken', 'tok-prod');
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    const env = chip()!;
    expect(env.parentElement).toBe(pill());
    // The name stays next to the header's buttons, where the user menu names it too.
    expect(env.nextElementSibling).toBe(text());
    expect(shown(env)).toBe(true);
    expect(env.textContent).toBe('Production');
    expect(env.dataset.env).toBe('production');
  });

  it('says Sandbox for a sandbox', async () => {
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    const env = chip()!;
    expect(env.textContent).toBe('Sandbox');
    expect(env.dataset.env).toBe('sandbox');
  });

  it('sits in the same place on the review screen', async () => {
    reviewHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(shown(pill())).toBe(true);
    expect(shown(chip())).toBe(true);
    expect(document.querySelector('[data-cy="file-name"]')!.nextElementSibling).toBeNull();
  });

  it('shows on its own when the name is switched off', async () => {
    documentsHeader();
    feature.init({ intervalMs: 0, name: false, env: true });
    await flush();

    expect(shown(pill())).toBe(true);
    expect(shown(text())).toBe(false);
    expect(shown(chip())).toBe(true);
    expect(pill()!.textContent).toBe('Sandbox');
  });

  it('adds nothing when it is switched off', async () => {
    documentsHeader({ chips: ['Sandbox'] });
    feature.init({ intervalMs: 0 });
    await flush();

    expect(shown(chip())).toBe(false);
    expect(pill()!.textContent).toBe('Acme HQ - TEST: 7');
    expect(shown(band())).toBe(false);
    expect(rossumChip('Sandbox').style.display).toBe('');
  });

  it('needs room for itself as well as a readable name', async () => {
    // (920 - 12) - (785 + 12) = 111px: a name alone would fit, a name and a 90px chip not.
    documentsHeader({ chatLeft: 920 });
    feature.init({ intervalMs: 0, env: true });
    await flush();
    // In a browser: a 150px name and a 90px chip. jsdom measures text as 0px.
    Object.defineProperty(text()!, 'scrollWidth', { configurable: true, value: 150 });
    at(chip()!, [0, 0, 90, 24]);
    window.dispatchEvent(new Event('resize'));

    expect(shown(pill())).toBe(false);
  });

  it('moves the pill left when the name and the chip together do not fit', async () => {
    const header = documentsHeader();
    header.append(el('button', [1300, 6, 100, 36])); // leaves 1400–1517 by the buttons
    feature.init({ intervalMs: 0, env: true });
    await flush();
    // In a browser: an 80px name, an 80px chip and the 8px between them make 168px,
    // more than the 93px by the buttons.
    Object.defineProperty(text()!, 'scrollWidth', { configurable: true, value: 80 });
    at(chip()!, [0, 0, 80, 24]);
    window.dispatchEvent(new Event('resize'));

    // The gap 785–1300 holds it: right = 1705 - 1300 + 12
    expect(pill()!.style.right).toBe('417px');
  });
});

describe('the environment line', () => {
  it('runs under the header in the production colour', async () => {
    window.localStorage.setItem('secureToken', 'tok-prod');
    const header = documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    const line = band()!;
    expect(line.parentElement).toBe(header);
    expect(shown(line)).toBe(true);
    expect(line.dataset.env).toBe('production');
  });

  it('runs in the sandbox colour on a sandbox', async () => {
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(band()!.dataset.env).toBe('sandbox');
  });

  it('calls an organization without the sandbox flag production', async () => {
    rossumApi.orgsByToken['tok-sandbox'] = [{ id: 7, name: 'Acme HQ - TEST' }];
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(band()!.dataset.env).toBe('production');
    expect(chip()!.textContent).toBe('Production');
  });

  it('draws nothing while the organization is unknown', async () => {
    window.localStorage.setItem('secureToken', 'tok-unknown');
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(shown(band())).toBe(false);
    expect(shown(pill())).toBe(false);
  });

  it('stays even when the pill has no room', async () => {
    const header = documentsHeader({ chatLeft: 800 });
    header.append(el('img', [0, 0, 290, 48]));
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(shown(pill())).toBe(false);
    expect(shown(band())).toBe(true);
  });
});

describe('Rossum’s own Sandbox chip', () => {
  it('is hidden while ours says Sandbox, so the bar says it once', async () => {
    documentsHeader({ chips: ['Sandbox', 'Developer mode'] });
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(rossumChip('Sandbox').style.display).toBe('none');
    // Developer mode is not an environment and is not ours to move.
    expect(rossumChip('Developer mode').style.display).toBe('');
  });

  it('is recognised by its colour when the UI is not in English', async () => {
    documentsHeader({ chips: ['Sandbox'] });
    rossumChip('Sandbox').querySelector('.MuiChip-label')!.textContent = 'Pískoviště';
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(document.querySelector<HTMLElement>('.MuiChip-colorInfo')!.style.display).toBe('none');
  });

  it('is hidden when it renders after ours', async () => {
    const header = documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    const late = el('div', [110, 12, 80, 24], { class: 'MuiChip-root MuiChip-colorInfo' });
    const label = document.createElement('span');
    label.className = 'MuiChip-label';
    label.textContent = 'Sandbox';
    late.append(label);
    header.querySelector('.badge-row')!.prepend(late);
    feature.handleNode(late);

    expect(late.style.display).toBe('none');
  });

  it('comes back whenever ours is not on screen', async () => {
    const header = documentsHeader({ chatLeft: 800, chips: ['Sandbox'] });
    header.append(el('img', [0, 0, 100, 48]));
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(shown(pill())).toBe(false);
    expect(rossumChip('Sandbox').style.display).toBe('');
  });

  it('is told apart from other blue chips by sitting beside the nav tabs', async () => {
    // A status chip on the review screen is MUI's info colour too.
    const header = reviewHeader();
    const status = el('div', [300, 12, 80, 24], { class: 'MuiChip-root MuiChip-colorInfo' });
    status.innerHTML = '<span class="MuiChip-label">To review</span>';
    header.querySelector('[data-cy="document-topbar-start"]')!.append(status);
    feature.init({ intervalMs: 0, env: true });
    feature.handleNode(status);
    await flush();

    expect(status.style.display).toBe('');
  });

  it('touches no chip at all while the environment is switched off', async () => {
    // An inline style of Rossum's own must survive: writing `display` would replace it.
    const header = documentsHeader({ chips: ['Sandbox'] });
    const rossums = rossumChip('Sandbox');
    rossums.style.display = 'inline-flex';
    feature.init({ intervalMs: 0 });
    await flush();
    const late = el('div', [110, 12, 80, 24], { class: 'MuiChip-root MuiChip-colorInfo' });
    late.innerHTML = '<span class="MuiChip-label">Sandbox</span>';
    late.style.display = 'inline-flex';
    header.querySelector('.badge-row')!.prepend(late);
    feature.handleNode(late);

    expect(rossums.style.display).toBe('inline-flex');
    expect(late.style.display).toBe('inline-flex');
  });

  it('is never hidden while ours says Production', async () => {
    window.localStorage.setItem('secureToken', 'tok-prod');
    documentsHeader({ chips: ['Sandbox'] });
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(rossumChip('Sandbox').style.display).toBe('');
  });

  it('follows a switch between organizations', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('secureToken', 'tok-prod');
    documentsHeader({ chips: ['Sandbox'] });
    feature.init({ intervalMs: 1500, env: true });
    await flush();
    expect(rossumChip('Sandbox').style.display).toBe('');

    window.localStorage.setItem('secureToken', 'tok-sandbox');
    await vi.advanceTimersByTimeAsync(1500);
    await flush();

    expect(rossumChip('Sandbox').style.display).toBe('none');
    expect(chip()!.textContent).toBe('Sandbox');
    expect(band()!.dataset.env).toBe('sandbox');
  });
});

describe('usage', () => {
  it('reports the chip once per page, naming nothing about the organization', async () => {
    documentsHeader();
    feature.init({ intervalMs: 0, name: false, env: true });
    await flush();
    window.dispatchEvent(new Event('resize'));
    await flush();

    const events = sendMessage.mock.calls.map(([m]) => m);
    expect(events).toEqual([{ type: 'sa-usage', name: 'sa_rossum_org_env' }]);
  });

  it('reports the environment when only the line has room', async () => {
    const header = documentsHeader({ chatLeft: 800 });
    header.append(el('img', [0, 0, 290, 48]));
    feature.init({ intervalMs: 0, env: true });
    await flush();

    expect(shown(pill())).toBe(false);
    const names = sendMessage.mock.calls.map(([m]) => m.name);
    expect(names).toEqual(['sa_rossum_org_env']);
  });

  it('reports each feature that showed', async () => {
    documentsHeader();
    feature.init({ intervalMs: 0, env: true });
    await flush();

    const names = sendMessage.mock.calls.map(([m]) => m.name).sort();
    expect(names).toEqual(['sa_rossum_org_env', 'sa_rossum_org_name']);
  });
});
