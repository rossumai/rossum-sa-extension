// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import MdhProvenancePanel from '../src/popup/components/MdhProvenancePanel.jsx';

// Condition-based wait — never fixed timeouts (repo rule).
async function waitFor(cond: any, timeout = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const TAB = { id: 1, windowId: 7, index: 0, url: 'https://org.rossum.app/document/5' };
let root: any;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  vi.stubGlobal('chrome', {
    // Token-less context: the card settles on a message without any network.
    scripting: {
      executeScript: vi.fn(async () => [{
        result: { token: null, domain: 'https://org.rossum.app', annotationId: null, queueId: null },
      }]),
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    runtime: { sendMessage: vi.fn() },
  });
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe('MDH card pin button', () => {
  it('renders no pin button when no onPin is given', async () => {
    render(<MdhProvenancePanel tab={TAB} />, root);
    await waitFor(() => !!root.querySelector('.mdh-card'));
    expect(root.querySelector('.mdh-pin-btn')).toBeNull();
    expect(root.querySelector('.mdh-refresh-btn')).not.toBeNull();
  });

  it('renders the pin button and calls onPin when clicked', async () => {
    const onPin = vi.fn();
    render(<MdhProvenancePanel tab={TAB} onPin={onPin} />, root);
    await waitFor(() => !!root.querySelector('.mdh-pin-btn'));
    root.querySelector('.mdh-pin-btn').click();
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('keeps Refresh working alongside the pin button', async () => {
    render(<MdhProvenancePanel tab={TAB} onPin={vi.fn()} />, root);
    await waitFor(() => !!root.querySelector('.mdh-refresh-btn:not(.mdh-pin-btn)'));
    const before = vi.mocked(chrome.scripting.executeScript).mock.calls.length;
    root.querySelector('.mdh-refresh-btn:not(.mdh-pin-btn)').click();
    await waitFor(() => vi.mocked(chrome.scripting.executeScript).mock.calls.length > before);
  });
});
