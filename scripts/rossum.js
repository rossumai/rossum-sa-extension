// @flow

/*::

declare const chrome: any; // TODO

*/

const styleSchemaID = document.createElement('style');
styleSchemaID.textContent = `
[data-sa-extension-schema-id] {
  position: relative;
}

.rossum-sa-extension-schema-id {
  position: absolute;
  top: 0;
  right: 0;
  color: red;
  font-size: 10px;
  transition: all 0.25s ease-in-out;
  opacity: .7;
  margin-inline: 3px;
}

.rossum-sa-extension-schema-id:hover {
  font-size: 16px;
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.7);
  border-radius: 3px;
  padding-inline: 3px;
}`;
document.head?.appendChild(styleSchemaID);

const styleResourceID = document.createElement('style');
styleResourceID.textContent = `
[data-cy="sidebar-queue"],
[data-cy="workspace"],
[data-cy="queue"],
[data-cy="extensions-list-name"],
[data-cy="rule-tile"],
[data-field="original_file_name"],
[data-field="name"],
[data-sentry-component="LabelChip"] {
  position: relative !important;
  overflow: visible !important;
}

.rossum-sa-extension-resource-id {
  position: absolute;
  top: 0;
  right: 0;
  color: red;
  font-size: 10px;
  transition: font-size 0.25s ease-in-out, opacity 0.25s ease-in-out, background-color 0.25s ease-in-out;
  opacity: .7;
  margin-inline: 3px;
  z-index: 100;
  background-color: rgba(255,255,255,0.5);
  pointer-events: auto;
  cursor: pointer;
}

.rossum-sa-extension-resource-id:hover {
  font-size: 16px;
  opacity: 1;
  background-color: rgba(255, 255, 255, 0.9);
  border-radius: 3px;
  padding-inline: 3px;
  z-index: 9999;
}

.rossum-sa-extension-resource-id--bottom-left {
  top: auto;
  right: auto;
  bottom: 2px;
  left: 0;
}

.rossum-sa-extension-resource-id--below {
  top: 100%;
  right: auto;
  left: 0;
}

.rossum-sa-extension-resource-id--left-offset {
  right: auto;
  left: 100%;
}`;
document.head?.appendChild(styleResourceID);

function displaySchemaID(node /*: $FlowFixMe */) {
  const span = document.createElement('span');
  span.className = 'rossum-sa-extension-schema-id';
  span.innerHTML = node.getAttribute('data-sa-extension-schema-id');
  node.appendChild(span);
}

function displayResourceId(node /*: $FlowFixMe */, id /*: string */, variant /*: ?string */) {
  if (node.querySelector('.rossum-sa-extension-resource-id') != null) return;
  const span = document.createElement('span');
  span.className = 'rossum-sa-extension-resource-id' + (variant != null ? ` rossum-sa-extension-resource-id--${variant}` : '');
  span.textContent = id;
  span.title = 'Click to copy';
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard.writeText(id).then(() => {
      const original = span.textContent;
      span.textContent = '✓ copied';
      setTimeout(() => { span.textContent = original; }, 1000);
    });
  });
  node.appendChild(span);
}

const apiCache /*: { [string]: Promise<any> } */ = {};

function fetchRossumApi(path /*: string */) /*: Promise<any> */ {
  if (!apiCache[path]) {
    const token = window.localStorage.getItem('secureToken');
    const headers = token ? { Authorization: `Token ${token}` } : {};
    apiCache[path] = fetch(path, { headers }).then((r) => r.json());
  }
  return apiCache[path];
}

function isElementNode(node /*: any */) /*: node is Element */ {
  // https://developer.mozilla.org/en-US/docs/Web/API/Node
  // https://developer.mozilla.org/en-US/docs/Web/API/Element
  return node.nodeType === Node.ELEMENT_NODE;
}

const htmlBodyElement = document.querySelector('body');
if (htmlBodyElement == null) {
  throw new Error('No body element found');
}

const observeHtmlBody = (
  options /*: { +schemaAnnotationsEnabled: boolean, +expandFormulasEnabled: boolean, +expandReasoningFieldsEnabled: boolean, +scrollLockEnabled: boolean, +resourceIdsEnabled: boolean } */,
) => {
  const observer = new MutationObserver((mutations /*: Array<MutationRecord> */) => {
    const checkAddedNode = (addedNode /*: Node */) => {
      if (!isElementNode(addedNode)) {
        return;
      }

      if (options.schemaAnnotationsEnabled === true) {
        if (addedNode.hasAttribute('data-sa-extension-schema-id')) {
          displaySchemaID(addedNode);
        }
      }

      if (options.expandFormulasEnabled === true) {
        const button = document.querySelector('button[aria-label="Show source code"]');
        if (button != null) {
          button.click();
        }
      }

      if (options.expandReasoningFieldsEnabled === true) {
        const button = Array.from(document.querySelectorAll('button[data-sentry-source-file="ReasoningTiles.tsx"]')).find(button => button.textContent.trim() === 'Show options');
        if (button != null) {
          button.click();
        }
      }

      if (options.scrollLockEnabled === true) {
        const scrollableContainer = document.querySelector('#sidebar-scrollable');
        if (scrollableContainer != null && !scrollableContainer.__saScrollLockAttached) {
          initScrollLock(scrollableContainer);
        }
      }

      if (options.resourceIdsEnabled === true) {
        // Sidebar workspace IDs: name-matched via API
        if (addedNode.matches('[data-cy="workspace"]')) {
          const name = addedNode.querySelector('[data-cy="sidebar-heading"] span')?.textContent.trim();
          if (name) {
            fetchRossumApi('/api/v1/workspaces?page_size=100').then((data) => {
              const ws = data.results?.find((w) => w.name === name);
              if (ws) displayResourceId(addedNode, String(ws.id));
            });
          }
        }

        // Sidebar queue IDs: data-id attribute directly on the element
        if (addedNode.matches('[data-cy="sidebar-queue"]') && addedNode.dataset.id) {
          displayResourceId(addedNode, addedNode.dataset.id);
        }

        // Document list annotation IDs: row has data-id, label goes in the filename cell
        if (addedNode.matches('[data-field="original_file_name"]')) {
          const row = addedNode.closest('[data-cy="document-row"]');
          if (row instanceof HTMLElement && row.dataset.id) {
            displayResourceId(addedNode, row.dataset.id);
          }
        }

        // Automation screen queue IDs: extract from href="/queues/{id}/..."
        if (addedNode.matches('[data-cy="queue"]')) {
          const href = addedNode.getAttribute('href') ?? '';
          const match = href.match(/\/queues\/(\d+)/);
          if (match) {
            displayResourceId(addedNode, match[1]);
          }
        }

        // Extensions screen hook IDs: label on the name element, ID from parent anchor href
        if (addedNode.matches('[data-cy="extensions-list-name"]')) {
          const anchor = addedNode.closest('a[href*="/extensions/my-extensions/"]');
          if (anchor) {
            const match = (anchor.getAttribute('href') ?? '').match(/\/extensions\/my-extensions\/(\d+)/);
            if (match) {
              displayResourceId(addedNode, match[1], 'left-offset');
            }
          }
        }

        // Settings → Labels screen: name-matched via API
        if (addedNode.matches('[data-sentry-component="LabelChip"]')) {
          const nameEl = addedNode.querySelector('.MuiChip-label');
          const name = nameEl?.textContent.trim();
          if (name) {
            fetchRossumApi('/api/v1/labels?page_size=100').then((data) => {
              const label = data.results?.find((l) => l.name === name);
              if (label) displayResourceId(addedNode, String(label.id));
            });
          }
        }

        // Rule manager tiles: data-id directly on the tile
        if (addedNode.matches('[data-cy="rule-tile"]') && addedNode.dataset.id) {
          displayResourceId(addedNode, addedNode.dataset.id);
        }

        // Settings → Users screen: label on the name cell, ID from parent anchor href
        if (addedNode.matches('[data-field="name"]')) {
          const anchor = addedNode.closest('a[href*="/settings/users/"]');
          if (anchor) {
            const match = (anchor.getAttribute('href') ?? '').match(/\/settings\/users\/(\d+)/);
            if (match) {
              displayResourceId(addedNode, match[1]);
            }
          }
        }
      }

      for (const child of addedNode.children) {
        checkAddedNode(child);
      }
    };

    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        checkAddedNode(addedNode);
      }
    }
  });

  observer.observe(htmlBodyElement, {
    subtree: true,
    childList: true,
  });
};

function initScrollLock(element /*: Element */) {
  if (!(element instanceof HTMLElement)) return;

  const MIN_SCROLL_POSITION_FOR_LOCK = 50;
  const SCROLL_TOLERANCE_PX = 5;
  const USER_SCROLL_DETECTION_MS = 250;
  const ROUTE_CHANGE_LOCK_MS = 800;
  const CONTENT_CHANGE_LOCK_MS = 400;

  let savedScrollTop = 0;
  let lockUntil = 0;
  let isRestoring = false;
  let currentPathname = window.location.pathname;

  let userScrollUntil = 0;
  let userScrollTimer = null;

  element.__saScrollLockAttached = true;
  console.log('[SA Extension] Scroll lock initialized for #sidebar-scrollable, pathname:', currentPathname);

  requestAnimationFrame(() => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });

  const markUserScrollActive = () => {
    const now = Date.now();
    userScrollUntil = now + USER_SCROLL_DETECTION_MS;

    if (userScrollTimer) clearTimeout(userScrollTimer);
  };

  element.addEventListener('wheel', markUserScrollActive, { passive: true });
  element.addEventListener('touchstart', markUserScrollActive, { passive: true });
  element.addEventListener('mousedown', markUserScrollActive, { passive: true });
  element.addEventListener('keydown', markUserScrollActive, { passive: true });

  element.addEventListener(
    'scroll',
    () => {
      if (!(element instanceof HTMLElement)) return;

      markUserScrollActive();

      const now = Date.now();
      const cur = element.scrollTop;

      if (!isRestoring && now <= userScrollUntil) {
        savedScrollTop = cur;
        return;
      }

      if (!isRestoring && now < lockUntil && savedScrollTop > MIN_SCROLL_POSITION_FOR_LOCK) {
        if (Math.abs(cur - savedScrollTop) > SCROLL_TOLERANCE_PX) {
          isRestoring = true;
          element.scrollTop = savedScrollTop;
          setTimeout(() => {
            isRestoring = false;
          }, 0);
        }
      }
    },
    { passive: true },
  );

  const proto = Object.getPrototypeOf(element);
  const desc = Object.getOwnPropertyDescriptor(proto, 'scrollTop');
  if (desc && typeof desc.set === 'function' && typeof desc.get === 'function') {
    Object.defineProperty(element, 'scrollTop', {
      configurable: true,
      enumerable: true,
      get() { return desc.get.call(this); },
      set(v) {
        const now = Date.now();
        const desired = Number(v) || 0;

        if (now > userScrollUntil && now < lockUntil && savedScrollTop > MIN_SCROLL_POSITION_FOR_LOCK) {
          if (Math.abs(desired - savedScrollTop) > SCROLL_TOLERANCE_PX) {
            return desc.set.call(this, savedScrollTop);
          }
        }
        return desc.set.call(this, v);
      },
    });
  }

  const armLockWindow = (ms) => {
    if (savedScrollTop <= MIN_SCROLL_POSITION_FOR_LOCK) return; 
    lockUntil = Date.now() + ms;
    element.scrollTop = savedScrollTop;
    requestAnimationFrame(() => {
      if (element.scrollTop !== savedScrollTop) element.scrollTop = savedScrollTop;
    });
  };

  const contentObserver = new MutationObserver(() => {
    if (window.location.pathname !== currentPathname) {
      currentPathname = window.location.pathname;
      armLockWindow(ROUTE_CHANGE_LOCK_MS);
      return;
    }
    armLockWindow(CONTENT_CHANGE_LOCK_MS);
  });

  contentObserver.observe(element, { childList: true, subtree: true });

  let observerDisconnected = false;
  const cleanupObserver = () => {
    if (observerDisconnected) return;
    observerDisconnected = true;
    contentObserver.disconnect();
  };

  const monitorElementConnection = () => {
    if (observerDisconnected) return;
    if (!element.isConnected) {
      cleanupObserver();
      return;
    }
    requestAnimationFrame(monitorElementConnection);
  };

  requestAnimationFrame(monitorElementConnection);
}


function initFocusPatch() {
  if (!HTMLElement.prototype.__saFocusPatched) {
    const originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      try {
        if (args.length === 0) {
          return originalFocus.call(this, { preventScroll: true });
        }

        const firstArg = args[0];

        if (firstArg !== null && typeof firstArg === 'object') {
          const hasPreventScroll = Object.prototype.hasOwnProperty.call(firstArg, 'preventScroll');
          const mergedOptions = hasPreventScroll
            ? firstArg
            : Object.assign({}, firstArg, { preventScroll: true });

          const newArgs = [mergedOptions, ...args.slice(1)];
          return originalFocus.apply(this, newArgs);
        }

        return originalFocus.apply(this, args);
      } catch {
        return originalFocus.apply(this, args);
      }
    };
    HTMLElement.prototype.__saFocusPatched = true;
  }
}

chrome.storage.local.get(['schemaAnnotationsEnabled', 'expandFormulasEnabled', 'expandReasoningFieldsEnabled', 'scrollLockEnabled', 'resourceIdsEnabled']).then((result) => {

  if (result.scrollLockEnabled === true) {
    initFocusPatch();
  }

  observeHtmlBody({
    schemaAnnotationsEnabled: result.schemaAnnotationsEnabled,
    expandFormulasEnabled: result.expandFormulasEnabled,
    expandReasoningFieldsEnabled: result.expandReasoningFieldsEnabled,
    scrollLockEnabled: result.scrollLockEnabled,
    resourceIdsEnabled: result.resourceIdsEnabled,
  });
});

/**
 * Adds functionality to enable or disable `devFeaturesEnabled`/`devDebugEnabled` flag in the actual local storage.
 *
 * This functionality is invoked from the popup window when toggling the checkboxes.
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  // devFeaturesEnabled:
  if (message === 'get-dev-features-enabled-value') {
    sendResponse(window.localStorage.getItem('devFeaturesEnabled') === 'true');
  }

  if (message === 'toggle-dev-features-enabled') {
    if (window.localStorage.getItem('devFeaturesEnabled') === 'true') {
      window.localStorage.removeItem('devFeaturesEnabled');
    } else {
      window.localStorage.setItem('devFeaturesEnabled', true);
    }
    sendResponse(true);
  }

  // devDebugEnabled:
  if (message === 'get-dev-debug-enabled-value') {
    sendResponse(window.localStorage.getItem('devDebugEnabled') === 'true');
  }

  if (message === 'toggle-dev-debug-enabled') {
    if (window.localStorage.getItem('devDebugEnabled') === 'true') {
      window.localStorage.removeItem('devDebugEnabled');
    } else {
      window.localStorage.setItem('devDebugEnabled', true);
    }
    sendResponse(true);
  }
});
