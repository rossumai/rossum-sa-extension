import { handleNode as handleSchemaId } from './features/schema-ids.js';
import { handleNode as handleResourceId } from './features/resource-ids.js';
import { handleNode as handleExpandFormulas } from './features/expand-formulas.js';
import { handleNode as handleExpandReasoning } from './features/expand-reasoning.js';
import { initScrollLock, initFocusPatch } from './features/scroll-lock.js';
import { initDevFlags } from './features/dev-flags.js';

initDevFlags();

const SETTINGS_KEYS = [
  'schemaAnnotationsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'resourceIdsEnabled',
];

chrome.storage.local.get(SETTINGS_KEYS).then((settings) => {
  if (settings.scrollLockEnabled) {
    initFocusPatch();
  }

  const handlers = [];

  if (settings.schemaAnnotationsEnabled) handlers.push(handleSchemaId);
  if (settings.resourceIdsEnabled) handlers.push(handleResourceId);
  if (settings.expandFormulasEnabled) handlers.push(handleExpandFormulas);
  if (settings.expandReasoningFieldsEnabled) handlers.push(handleExpandReasoning);
  if (settings.scrollLockEnabled) {
    handlers.push((node) => {
      if (node.id === 'sidebar-scrollable' && !node.__saScrollLockAttached) {
        initScrollLock(node);
      }
    });
  }

  if (handlers.length === 0) return;

  const body = document.querySelector('body');
  if (!body) return;

  function processNode(node, fns) {
    for (const fn of fns) fn(node);
    for (const child of node.children) processNode(child, fns);
  }

  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processNode(node, handlers);
        }
      }
    }
  }).observe(body, { subtree: true, childList: true });
});
