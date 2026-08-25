// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import ReviewingLockBanner, { probeLock } from '../src/popup/components/ReviewingLockBanner.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const DOMAIN = 'https://org.rossum.app';
const CTX = { token: 'tok', domain: DOMAIN, annotationId: '138328520', queueId: null };
const ME = `${DOMAIN}/api/v1/users/1`;
const OTHER = `${DOMAIN}/api/v1/users/2`;

// getJson stub routed by URL substring.
function makeGetJson({ ann, me, holder }: any) {
  return vi.fn(async (url) => {
    if (url.includes('/api/v1/annotations/')) return ann;
    if (url.includes('/api/v1/auth/user')) return me;
    if (url.includes('/api/v1/users/')) return holder;
    throw new Error(`unexpected url ${url}`);
  });
}

const LOCKED_ANN = {
  status: 'reviewing',
  modified_by: OTHER,
};

function makeDeps(overrides = {}) {
  return {
    readCtx: vi.fn().mockResolvedValue(CTX),
    getJson: makeGetJson({
      ann: LOCKED_ANN,
      me: { url: ME },
      holder: { first_name: 'Jane', last_name: 'Doe', username: 'jd@x.com' },
    }),
    patch: vi.fn().mockResolvedValue({ status: 'to_review' }),
    reloadTab: vi.fn(),
    closePopup: vi.fn(),
    ...overrides,
  };
}

function mount(deps: any) {
  const root = document.createElement('div');
  render(<ReviewingLockBanner tab={{ id: 42 }} deps={deps} />, root);
  return root;
}

describe('probeLock', () => {
  it('returns null when there is no annotation in the tab', async () => {
    const deps = makeDeps({ readCtx: vi.fn().mockResolvedValue({ ...CTX, annotationId: null }) });
    expect(await probeLock(42, deps)).toBeNull();
    expect(deps.getJson).not.toHaveBeenCalled();
  });

  it('returns null when the annotation is not reviewing', async () => {
    const deps = makeDeps();
    deps.getJson = makeGetJson({ ann: { ...LOCKED_ANN, status: 'to_review' }, me: { url: ME } });
    expect(await probeLock(42, deps)).toBeNull();
  });

  it('returns null when I am the modifier myself', async () => {
    const deps = makeDeps();
    deps.getJson = makeGetJson({ ann: { ...LOCKED_ANN, modified_by: ME }, me: { url: ME } });
    expect(await probeLock(42, deps)).toBeNull();
  });

  it('resolves the plain holder name when locked by another user', async () => {
    const deps = makeDeps();
    const res = (await probeLock(42, deps))!;
    expect(res.holderName).toBe('Jane Doe');
    expect(res.ctx).toEqual(CTX);
    // no queue/session_timeout read anymore — only annotation, auth/user, users/{id}
    const urls = deps.getJson.mock.calls.map(([u]) => u);
    expect(urls.some((u) => u.includes('/api/v1/queues/'))).toBe(false);
  });

  it('degrades to "another user" when the holder read fails', async () => {
    const deps = makeDeps();
    const base = deps.getJson;
    deps.getJson = vi.fn(async (url) => {
      if (url.includes('/api/v1/users/')) throw new Error('HTTP 403');
      return base(url);
    });
    const res = await probeLock(42, deps);
    expect(res!.holderName).toBe('another user');
  });

  it('returns null when the annotation read itself fails', async () => {
    const deps = makeDeps({ getJson: vi.fn().mockRejectedValue(new Error('HTTP 500')) });
    expect(await probeLock(42, deps)).toBeNull();
  });
});

describe('ReviewingLockBanner', () => {
  it('renders nothing when not locked-by-other', async () => {
    const deps = makeDeps({ readCtx: vi.fn().mockResolvedValue({ ...CTX, annotationId: null }) });
    const root = mount(deps);
    await waitFor(() => deps.readCtx.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector('.reviewing-lock-banner')).toBeNull();
  });

  it('renders the banner: lock icon, title, sub, Unlock button — no time info', async () => {
    const root = mount(makeDeps());
    await waitFor(() => root.querySelector('.reviewing-lock-banner'));
    expect(root.textContent).toContain('Document locked by Jane Doe');
    expect(root.textContent).toContain('Read-only while they review');
    expect(root.querySelector('.rlb-icon svg')).toBeTruthy();
    expect(root.querySelector('.rlb-release')!.textContent).toBe('Unlock');
    // the redesign removed staleness/consequence copy
    expect(root.textContent).not.toMatch(/min|expires|session|timed out/i);
  });

  it('unlock success: PATCHes status, reloads the tab, closes the popup', async () => {
    const deps = makeDeps();
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector<HTMLElement>('.rlb-release')!.click();
    await waitFor(() => deps.reloadTab.mock.calls.length > 0);
    expect(deps.patch).toHaveBeenCalledWith(`${DOMAIN}/api/v1/annotations/138328520`, 'tok', {
      status: 'to_review',
    });
    expect(deps.reloadTab).toHaveBeenCalledWith(42);
    expect(deps.closePopup).toHaveBeenCalled();
  });

  it('unlock 403: shows the permission error and re-enables the button', async () => {
    const deps = makeDeps({ patch: vi.fn().mockRejectedValue(new Error('HTTP 403')) });
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector<HTMLElement>('.rlb-release')!.click();
    await waitFor(() => root.querySelector('.rlb-error'));
    expect(root.querySelector('.rlb-error')!.textContent).toBe(
      "You don't have permission to release this document.",
    );
    expect(root.querySelector<HTMLButtonElement>('.rlb-release')!.disabled).toBe(false);
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  it('unlock 401: shows the sign-in error', async () => {
    const deps = makeDeps({ patch: vi.fn().mockRejectedValue(new Error('HTTP 401')) });
    const root = mount(deps);
    await waitFor(() => root.querySelector('.rlb-release'));
    root.querySelector<HTMLElement>('.rlb-release')!.click();
    await waitFor(() => root.querySelector('.rlb-error'));
    expect(root.querySelector('.rlb-error')!.textContent).toBe(
      'Sign in to Rossum in this tab first.',
    );
  });
});
