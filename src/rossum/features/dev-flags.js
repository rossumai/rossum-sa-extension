const handlers = {
  'get-auth-info': (sendResponse) => {
    sendResponse({
      token: window.localStorage.getItem('secureToken'),
      domain: window.location.origin,
    });
  },
  'get-current-context': (sendResponse) => {
    const path = window.location.pathname;
    const docMatch = path.match(/\/document\/(\d+)/) || path.match(/\/annotations?\/(\d+)/);
    const queueMatch = path.match(/\/queues?\/(\d+)/);
    sendResponse({
      token: window.localStorage.getItem('secureToken'),
      domain: window.location.origin,
      annotationId: docMatch ? docMatch[1] : null,
      queueId: queueMatch ? queueMatch[1] : null,
    });
  },
  'get-dev-features-enabled-value': (sendResponse) => {
    sendResponse(window.localStorage.getItem('devFeaturesEnabled') === 'true');
  },
  'toggle-dev-features-enabled': (sendResponse) => {
    const key = 'devFeaturesEnabled';
    if (window.localStorage.getItem(key) === 'true') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, 'true');
    }
    sendResponse(true);
  },
  'get-dev-debug-enabled-value': (sendResponse) => {
    sendResponse(window.localStorage.getItem('devDebugEnabled') === 'true');
  },
  'toggle-dev-debug-enabled': (sendResponse) => {
    const key = 'devDebugEnabled';
    if (window.localStorage.getItem(key) === 'true') {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, 'true');
    }
    sendResponse(true);
  },
};

export function initDevFlags() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message];
    if (handler) handler(sendResponse);
  });
}
