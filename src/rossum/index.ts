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
import {
  init as initOrgNameNavbar,
  handleNode as handleOrgNameNavbar,
} from './features/org-name-navbar.js';
import { init as initDatasetMgmtSuggest } from './features/dataset-mgmt-suggest.js';
import { init as initTrackViewed } from './features/track-viewed.js';
import { init as initOrgNameTitle } from './features/org-name-title.js';
import { init as initTrainingQuest } from './features/training-quest.js';

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
  'orgBadgeEnabled',
];

chrome.storage.local.get(SETTINGS_KEYS).then((settings) => {
  // The organization badge is the one toggle that defaults ON: an ABSENT key
  // means enabled, and only an explicit `false` turns it off. Every other
  // feature here reads a missing key as disabled, so this comparison is
  // load-bearing — `!settings.x` would hide it from everyone who has never
  // opened the popup. One switch covers every place the organization is named:
  // the navbar badge, the tab title, and the Console (see src/console/index.tsx).
  const orgBadgeOn = settings.orgBadgeEnabled !== false;
  if (orgBadgeOn) initOrgNameTitle();
  const handlers = [handleClosableTooltip];
  if (orgBadgeOn) handlers.push(handleOrgNameNavbar);

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

  // The observer only fires for nodes added from here on, and the SPA has
  // usually mounted its navbar before a document_idle content script runs — so
  // sweep what is already on the page. After observe(), never before, or a
  // navbar rendered in between would be missed by both.
  if (orgBadgeOn) initOrgNameNavbar();
});
