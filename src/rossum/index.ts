import { init as initSchemaIds, handleNode as handleSchemaId } from './features/schema-ids.js';
import {
  init as initResourceIds,
  handleNode as handleResourceId,
} from './features/resource-ids.js';
import { handleNode as handleExpandFormulas } from './features/expand-formulas.js';
import { handleNode as handleExpandReasoning } from './features/expand-reasoning.js';
import { initScrollLock } from './features/scroll-lock.js';
import {
  init as initClosableTooltips,
  handleNode as handleClosableTooltip,
} from './features/closable-tooltips.js';
import { init as initDatasetMgmtSuggest } from './features/dataset-mgmt-suggest.js';
import { init as initTrackViewed } from './features/track-viewed.js';
import { init as initTrainingQuest } from './features/training-quest.js';
import { init as initOrgName, handleNode as handleOrgName } from './features/org-name.js';
import { orgNameOn } from './orgName.js';

initClosableTooltips();
initDatasetMgmtSuggest();
initTrackViewed();
initTrainingQuest(); // self-gates on experimentalUnlocked; no popup toggle

const SETTINGS_KEYS = [
  'schemaAnnotationsEnabled',
  'expandFormulasEnabled',
  'expandReasoningFieldsEnabled',
  'scrollLockEnabled',
  'resourceIdsEnabled',
  'orgNameEnabled',
  'orgEnvEnabled',
];

chrome.storage.local.get(SETTINGS_KEYS).then((settings) => {
  // The one feature that defaults ON (see orgNameOn): knowing which organization you
  // are in is the default, not a preference.
  const showOrgName = orgNameOn(settings.orgNameEnabled);
  // The environment chip and line: its own switch, drawn by the same feature whether or
  // not the name is on, and OFF by default like every other toggle — a test org without
  // the sandbox flag shows Production, a call each user makes for themselves.
  const showOrgEnv = !!settings.orgEnvEnabled;
  const handlers = [handleClosableTooltip];
  if (showOrgName || showOrgEnv) handlers.push(handleOrgName);

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
    handlers.push((node: any) => {
      if (node.id === 'sidebar-scrollable' && !node.__saScrollLockAttached) {
        initScrollLock(node);
      }
    });
  }
  const body = document.querySelector('body');
  if (!body) return;

  function processNode(node: HTMLElement, fns: ((node: HTMLElement) => void)[]) {
    for (const fn of fns) fn(node);
    for (const child of node.children) processNode(child as HTMLElement, fns);
  }

  new MutationObserver((mutations) => {
    for (const { addedNodes } of mutations) {
      for (const node of addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processNode(node as HTMLElement, handlers);
        }
      }
    }
  }).observe(body, { subtree: true, childList: true });

  // The observer only fires for nodes added from here on, and the SPA has usually
  // mounted its header before a document_idle content script runs — so sweep what is
  // already on the page. After observe(), never before, or a header rendered in
  // between would be missed by both.
  if (showOrgName || showOrgEnv) initOrgName({ name: showOrgName, env: showOrgEnv });
});
