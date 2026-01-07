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

function displaySchemaID(node /*: $FlowFixMe */) {
  const span = document.createElement('span');
  span.className = 'rossum-sa-extension-schema-id';
  span.innerHTML = node.getAttribute('data-sa-extension-schema-id');
  node.appendChild(span);
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
  options /*: { +schemaAnnotationsEnabled: boolean, +expandFormulasEnabled: boolean, +expandReasoningFieldsEnabled: boolean, +scrollLockEnabled: boolean } */,
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
  let lastScrollTop = 0;
  let previousScrollTop = 0;
  let isRestoring = false;

  element.__saScrollLockAttached = true;

  element.addEventListener(
    'scroll',
    () => {
      if (!isRestoring && element instanceof HTMLElement) {
        const currentScroll = element.scrollTop;
        
        // Only prevent async resets to top (not manual fast scrolling)
        // Async resets typically jump to 0 or very close to 0
        if (lastScrollTop > 200 && currentScroll < 20) {
          isRestoring = true;
          element.scrollTop = previousScrollTop;
          setTimeout(() => {
            isRestoring = false;
          }, 0);
        } else {
          previousScrollTop = lastScrollTop;
          lastScrollTop = currentScroll;
        }
      }
    },
    { passive: true }
  );
}

function initFocusPatch() {
  if (!HTMLElement.prototype.__saFocusPatched) {
    const originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      try {
        return originalFocus.call(this, { preventScroll: true });
      } catch {
        return originalFocus.apply(this, args);
      }
    };
    HTMLElement.prototype.__saFocusPatched = true;
  }
}

chrome.storage.local.get(['schemaAnnotationsEnabled', 'expandFormulasEnabled', 'expandReasoningFieldsEnabled', 'scrollLockEnabled']).then((result) => {
  
  if (result.scrollLockEnabled === true) {
    initFocusPatch();
  }

  observeHtmlBody({
    schemaAnnotationsEnabled: result.schemaAnnotationsEnabled,
    expandFormulasEnabled: result.expandFormulasEnabled,
    expandReasoningFieldsEnabled: result.expandReasoningFieldsEnabled,
    scrollLockEnabled: result.scrollLockEnabled,
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
