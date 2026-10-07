// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { h, render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import Modal, { openModal, closeModal } from '../src/ui/Modal.jsx';

// Exactly one live host per test: a leaked prior host would leave a second
// <Modal/> instance subscribed to the same `modalContent` signal, so an
// unmount-cleanup assertion could in principle be satisfied by the STALE
// host's teardown rather than the one the test is actually exercising.
let liveRoot: HTMLDivElement | null = null;

function host() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<Modal />, root);
  liveRoot = root;
  return root;
}

beforeEach(() => closeModal());

afterEach(() => {
  if (liveRoot) {
    render(null, liveRoot);
    liveRoot.remove();
    liveRoot = null;
  }
});

describe('Modal — each modal owns its hooks', () => {
  // The body used to be invoked as a plain function call, so its hooks landed on
  // the shared Modal component's hook list. A second modal then read the first
  // one's state out of the reused slot.
  it('does not leak useState between two different modals', async () => {
    const root = host();
    openModal('A', () => {
      const [v] = useState('AAA');
      return <div class="probe">{v}</div>;
    });
    await Promise.resolve();
    expect(root.querySelector('.probe')!.textContent).toBe('AAA');

    closeModal();
    await Promise.resolve();

    openModal('B', () => {
      const [v] = useState('BBB');
      return <div class="probe">{v}</div>;
    });
    await Promise.resolve();
    expect(root.querySelector('.probe')!.textContent).toBe('BBB');
  });

  // Different hook COUNTS are the worse case: positional slots misalign.
  it('does not misalign when the two modals have different hook counts', async () => {
    const root = host();
    openModal('three hooks', () => {
      useState('x');
      useState('y');
      const [z] = useState('z');
      return <div class="probe">{z}</div>;
    });
    await Promise.resolve();
    closeModal();
    await Promise.resolve();

    openModal('one hook', () => {
      const [only] = useState('ONLY');
      return <div class="probe">{only}</div>;
    });
    await Promise.resolve();
    expect(root.querySelector('.probe')!.textContent).toBe('ONLY');
  });

  // A closure effect must be torn down when its modal closes, not left attached
  // to the long-lived Modal host.
  it('runs a body effect cleanup when the modal closes', async () => {
    const root = host();
    let cleaned = false;
    openModal('effect', () => {
      useEffect(
        () => () => {
          cleaned = true;
        },
        [],
      );
      return <div class="probe">x</div>;
    });
    await Promise.resolve();
    expect(root.querySelector('.probe')).not.toBeNull();
    // preact/hooks defers a mount `useEffect` to the next animation frame
    // (afterPaint/afterNextFrame) — a microtask never reaches a
    // macrotask-scheduled rAF callback, so the mount effect (which registers
    // the cleanup closeModal() will invoke below) needs two real
    // animation-frame ticks to actually run first. Measured empirically: one
    // tick is not enough (verified ran===false), two is deterministic across
    // repeated runs.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    closeModal();
    // Preact 11 defers a useEffect cleanup on unmount to after paint as well.
    await vi.waitFor(() => expect(cleaned).toBe(true));
  });
});
