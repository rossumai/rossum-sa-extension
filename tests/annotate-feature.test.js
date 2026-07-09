// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { annotationIdFromPath, injectButton, handleNode, isAnnotateEnabled, BUTTON_ID } from '../src/rossum/features/annotate-for-me.js';
import { createPanel, PANEL_ID } from '../src/rossum/annotate/panel.js';

beforeEach(() => {
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/document/138328520');
});

describe('annotationIdFromPath', () => {
  it('extracts the annotation id from /document/<id>', () => {
    expect(annotationIdFromPath('/document/138328520')).toBe('138328520');
    expect(annotationIdFromPath('/annotation/999?x=1')).toBe('999');
    expect(annotationIdFromPath('/queues/5')).toBeNull();
  });
});

describe('injectButton', () => {
  it('injects exactly one button and is idempotent', () => {
    injectButton(document, () => {});
    injectButton(document, () => {});
    expect(document.querySelectorAll(`#${BUTTON_ID}`)).toHaveLength(1);
  });
  it('calls the run handler on click', () => {
    let clicked = 0;
    injectButton(document, () => { clicked++; });
    document.getElementById(BUTTON_ID).click();
    expect(clicked).toBe(1);
  });
  it('docks the button in the bottom-right corner', () => {
    injectButton(document, () => {});
    const style = document.getElementById('rossum-sa-extension-annotate-btn-style');
    expect(style.textContent).toContain('bottom:16px');
    expect(style.textContent).not.toContain('top:16px');
  });
});

describe('handleNode off-route cleanup', () => {
  it('removes both the button and the panel when navigating off /document/<id>', () => {
    window.history.pushState({}, '', '/queues/5');
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    document.body.appendChild(btn);
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);

    handleNode();

    expect(document.getElementById(BUTTON_ID)).toBeNull();
    expect(document.getElementById(PANEL_ID)).toBeNull();
  });
});

describe('isAnnotateEnabled (experimental double-gate)', () => {
  it('requires BOTH the toggle and the experimental unlock', () => {
    expect(isAnnotateEnabled({ annotateForMeEnabled: true, experimentalUnlocked: true })).toBe(true);
    expect(isAnnotateEnabled({ annotateForMeEnabled: true })).toBe(false); // toggle alone → off
    expect(isAnnotateEnabled({ experimentalUnlocked: true })).toBe(false); // unlock alone → off
    expect(isAnnotateEnabled({})).toBe(false);
    expect(isAnnotateEnabled(undefined)).toBe(false);
  });
});

describe('panel dedup', () => {
  it('remove-existing-then-mount (as run() does) leaves exactly one panel', () => {
    const first = createPanel(document);
    document.body.appendChild(first.el);

    // Replicates run()'s dedup step before mounting a fresh panel.
    document.getElementById(PANEL_ID)?.remove();
    const second = createPanel(document);
    document.body.appendChild(second.el);

    expect(document.querySelectorAll(`#${PANEL_ID}`)).toHaveLength(1);
  });
});
