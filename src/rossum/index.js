import { init as initSchemaIds, handleNode as handleSchemaId } from './features/schema-ids.js';
import { init as initResourceIds, handleNode as handleResourceId } from './features/resource-ids.js';
import { handleNode as handleExpandFormulas } from './features/expand-formulas.js';
import { handleNode as handleExpandReasoning } from './features/expand-reasoning.js';
import { initScrollLock } from './features/scroll-lock.js';
import { init as initClosableTooltips, handleNode as handleClosableTooltip } from './features/closable-tooltips.js';
import { init as initDatasetMgmtSuggest } from './features/dataset-mgmt-suggest.js';
import { init as initTrackViewed } from './features/track-viewed.js';
import { init as initTrainingQuest } from './features/training-quest.js';

initClosableTooltips();
initDatasetMgmtSuggest();
initTrackViewed();
initTrainingQuest(); // self-gates on trainingUnlocked; no popup toggle

const SETTINGS_KEYS = [
  'schemaAnnotationsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'resourceIdsEnabled',
];

chrome.storage.local.get(SETTINGS_KEYS).then((settings) => {
  const handlers = [handleClosableTooltip];

  if (settings.schemaAnnotationsEnabled) {
    initSchemaIds();
    handlers.push(handleSchemaId);
  }
  if (settings.resourceIdsEnabled) {
    initResourceIds();
    handlers.push(handleResourceId);
  }
  if (settings.expandFormulasEnabled) handlers.push(handleExpandFormulas);
  if (settings.expandReasoningFieldsEnabled) handlers.push(handleExpandReasoning);
  if (settings.scrollLockEnabled) {
    handlers.push((node) => {
      if (node.id === 'sidebar-scrollable' && !node.__saScrollLockAttached) {
        initScrollLock(node);
      }
    });
  }
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
