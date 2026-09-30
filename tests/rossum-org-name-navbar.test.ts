// @vitest-environment jsdom
//
// The organization name in the Rossum navbar, immediately after the logo. It is
// anchored on the nav tabs, which every organization has, so unlike the chip it
// appears everywhere — which makes the tests that matter the placement, the
// re-entry guards, and the bounded width that stops a long name shoving the tabs
// off the bar. jsdom has no layout, so the width itself is asserted as the style
// that produces it; the geometry was measured in a browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const LABEL_ID = 'rossum-sa-extension-org-label';
const ENV_ID = 'rossum-sa-extension-org-env';
const DIVIDER_ID = 'rossum-sa-extension-org-divider';

function navbar() {
  document.body.innerHTML = `
    <div class="left-stack">
      <img class="logo" alt="logo">
      <div class="badge-row">
        <span class="MuiChip-root sandbox-chip"><span class="MuiChip-label">Sandbox</span></span>
        <span class="MuiChip-root dev-chip"><span class="MuiChip-label">Developer mode</span></span>
        <div class="MuiTabs-root">
          <div class="MuiTabs-scroller">
            <div class="MuiTabs-flexContainer" role="tablist" aria-label="nav-bar-tabs">
              <a class="MuiTab-root">Documents</a>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  return document.querySelector<HTMLElement>('[aria-label="nav-bar-tabs"]')!;
}

const row = () => document.querySelector<HTMLElement>('.badge-row')!;

async function loadModule(fetchRossumApi: any) {
  vi.resetModules();
  vi.doMock('../src/rossum/api.js', () => ({ fetchRossumApi }));
  return await import('../src/rossum/features/org-name-navbar.js');
}

const oneOrg = () =>
  vi.fn().mockResolvedValue({ results: [{ name: 'Acme Corporation', sandbox: true }] });
const prodOrg = (extra: Record<string, unknown> = {}) =>
  vi.fn().mockResolvedValue({ results: [{ name: 'Acme Corporation', ...extra }] });

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.doUnmock('../src/rossum/api.js');
});

describe('org name in the navbar', () => {
  it('puts the name at the head of the badge row, right after the logo', async () => {
    const { handleNode } = await loadModule(oneOrg());
    const tabs = navbar();

    handleNode(tabs);

    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
    const kids = [...row().children].map((c) => c.id || c.className.split(' ')[0]);
    expect(kids).toEqual([DIVIDER_ID, LABEL_ID, 'MuiChip-root', 'MuiChip-root', 'MuiTabs-root']);
    // textContent now carries both lines, so assert each element's own text.
    expect(document.getElementById(LABEL_ID)!.firstElementChild!.textContent).toBe(
      'Acme Corporation',
    );
  });

  it('bounds its own width and keeps the full name on hover', async () => {
    const { handleNode } = await loadModule(oneOrg());
    handleNode(navbar());

    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
    const label = document.getElementById(LABEL_ID)!;
    // The left group does not shrink, so an unbounded label pushes the tabs off
    // the bar. This is what keeps a long organization name from doing that: the
    // cap is on the column, the ellipsis on the name line inside it.
    expect(label.style.maxWidth).toBe('220px');
    expect((label.children[0] as HTMLElement).style.textOverflow).toBe('ellipsis');
    expect(label.title).toBe('Acme Corporation');
  });

  it('replaces Rossum\u2019s own Sandbox and Developer mode chips', async () => {
    const { handleNode } = await loadModule(oneOrg());
    handleNode(navbar());

    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });
    expect(document.querySelector<HTMLElement>('.sandbox-chip')!.style.display).toBe('none');
    expect(document.querySelector<HTMLElement>('.dev-chip')!.style.display).toBe('none');
  });

  it('hides a Rossum chip that only arrives after our badge is painted', async () => {
    const { handleNode } = await loadModule(oneOrg());
    handleNode(navbar());
    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });

    // The features behind these chips resolve asynchronously, so one can turn up
    // after the navbar mounted and after our badge landed.
    const late = document.createElement('span');
    late.className = 'MuiChip-root late-chip';
    late.innerHTML = '<span class="MuiChip-label">Sandbox</span>';
    row().append(late);
    handleNode(late);

    expect(late.style.display).toBe('none');
  });

  it('leaves a chip alone when it arrives before our badge', async () => {
    const { handleNode } = await loadModule(oneOrg());
    navbar();
    const early = document.querySelector<HTMLElement>('.sandbox-chip')!;

    handleNode(early); // nothing of ours is in the row yet

    expect(early.style.display).toBe('');
  });

  it('gives the two lines room to breathe', async () => {
    const { handleNode } = await loadModule(oneOrg());
    handleNode(navbar());
    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });
    // jsdom has no layout, so these assert the spacing rules rather than the gaps.
    const env = document.getElementById(ENV_ID)!;
    expect(env.style.marginTop).toBe('3px');
    // Verified by reading rendered pixel rows, not font metrics: 8 rows of
    // capitals inside a 12px content box leave 2px above and 2px below. An odd
    // amount of spare space cannot be split evenly, which is what tilted it at
    // 13px.
    expect(env.style.padding).toBe('1px 6px');
    expect(env.style.lineHeight).toBe('1');
  });

  it('leaves Rossum\u2019s chips visible when the lookup fails', async () => {
    const { handleNode } = await loadModule(vi.fn().mockRejectedValue(new Error('API 403')));
    handleNode(navbar());

    await Promise.resolve();
    await Promise.resolve();

    // Hiding them without painting ours would leave the bar saying nothing about
    // the environment at all — strictly worse than what Rossum shipped.
    expect(document.querySelector<HTMLElement>('.sandbox-chip')!.style.display).toBe('');
    expect(document.querySelector<HTMLElement>('.dev-chip')!.style.display).toBe('');
  });

  it('draws a sandbox in Rossum\u2019s own chip colours', async () => {
    const { handleNode } = await loadModule(oneOrg());
    handleNode(navbar());
    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });
    const sandbox = document.getElementById(ENV_ID)!;
    expect(sandbox.textContent).toBe('SANDBOX');
    // Sampled from Rossum's own Sandbox chip on the live navbar, so the calm
    // state reads as the product's rather than as a warning that failed to fire.
    expect(sandbox.style.background).toBe('rgb(213, 237, 242)');
    expect(sandbox.style.color).toBe('rgb(27, 33, 38)');
    expect(sandbox.style.borderColor).toBe('rgb(112, 204, 225)');
    // The SAME weight as production: the states differ by fill against outline.
    // A heavier weight on one moved its ink by a pixel and broke the centring.
    expect(sandbox.style.fontWeight).toBe('700');
  });

  it('warns under the name when the organization is not a sandbox', async () => {
    const { handleNode } = await loadModule(prodOrg({ sandbox: false }));
    handleNode(navbar());

    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });
    const label = document.getElementById(LABEL_ID)!;
    const warning = document.getElementById(ENV_ID)!;
    expect(warning.textContent).toBe('PRODUCTION');
    // Under the name, not beside it: the label is a column and the warning is
    // its second line, so it costs no width against the 220px cap.
    expect(label.style.flexDirection).toBe('column');
    expect(label.children[1]).toBe(warning);
    expect(warning.style.fontWeight).toBe('700');
    // White on a filled red badge, not red text: the badge brings its own ground,
    // so it reads the same whatever colour the navbar is.
    expect(warning.style.background).toBe('rgb(211, 47, 47)');
    expect(warning.style.color).toBe('rgb(255, 255, 255)');
    // Without this the badge stretches the whole width of the column.
    expect(warning.style.alignSelf).toBe('flex-start');
  });

  it('warns when the API does not say the organization is a sandbox at all', async () => {
    const { handleNode } = await loadModule(prodOrg());
    handleNode(navbar());

    // A missing flag is treated as production: crying wolf is the safe failure
    // here, and staying silent on a live org is not.
    await vi.waitFor(() => {
      expect(document.getElementById(ENV_ID)).not.toBeNull();
    });
  });

  it('inserts one label however often the node is handled', async () => {
    const { handleNode } = await loadModule(oneOrg());
    const tabs = navbar();

    handleNode(tabs);
    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
    handleNode(tabs);
    handleNode(tabs);
    await Promise.resolve();

    expect(document.querySelectorAll(`#${LABEL_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll(`#${DIVIDER_ID}`)).toHaveLength(1);
  });

  it('inserts one label when the same node is handled twice before the lookup resolves', async () => {
    const { handleNode } = await loadModule(oneOrg());
    const tabs = navbar();

    handleNode(tabs);
    handleNode(tabs);

    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
    await Promise.resolve();
    expect(document.querySelectorAll(`#${LABEL_ID}`)).toHaveLength(1);
  });

  it('re-inserts after the navbar remounts', async () => {
    const { handleNode } = await loadModule(oneOrg());

    handleNode(navbar());
    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });

    const remounted = navbar(); // Slide unmountOnExit tore the old navbar down
    expect(document.getElementById(LABEL_ID)).toBeNull();
    handleNode(remounted);

    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
  });

  it('sweeps a navbar that was already mounted before the observer attached', async () => {
    const { init } = await loadModule(oneOrg());
    navbar(); // the SPA rendered it during boot, so nothing is "added"

    init();

    await vi.waitFor(() => {
      expect(document.getElementById(LABEL_ID)).not.toBeNull();
    });
  });

  it('sweeps nothing when the navbar has not rendered yet', async () => {
    const fetchRossumApi = oneOrg();
    const { init } = await loadModule(fetchRossumApi);

    init();
    await Promise.resolve();

    expect(document.getElementById(LABEL_ID)).toBeNull();
    expect(fetchRossumApi).not.toHaveBeenCalled();
  });

  it('ignores any other element, and never calls the API for one', async () => {
    const fetchRossumApi = oneOrg();
    const { handleNode } = await loadModule(fetchRossumApi);
    navbar();

    handleNode(document.querySelector<HTMLElement>('.MuiChip-root')!);
    handleNode(document.querySelector<HTMLElement>('.MuiTabs-root')!);
    await Promise.resolve();

    expect(document.getElementById(LABEL_ID)).toBeNull();
    expect(fetchRossumApi).not.toHaveBeenCalled();
  });

  it('adds nothing when the lookup fails', async () => {
    const { handleNode } = await loadModule(vi.fn().mockRejectedValue(new Error('API 403')));
    handleNode(navbar());

    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById(LABEL_ID)).toBeNull();
    expect(row().children).toHaveLength(3); // Rossum's two chips and the tabs, untouched
  });

  it('adds nothing when the response carries no organization', async () => {
    const { handleNode } = await loadModule(vi.fn().mockResolvedValue({ results: [] }));
    handleNode(navbar());

    await Promise.resolve();
    await Promise.resolve();

    expect(document.getElementById(LABEL_ID)).toBeNull();
  });
});
