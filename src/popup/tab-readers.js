// Functions executed in the target tab's main world via runInTab. They run
// inside the page, NOT the popup, so they may only reference `window` and
// their own arguments — no closures over popup-side variables.

export function readAuthInfo() {
  return {
    token: window.localStorage.getItem('secureToken'),
    domain: window.location.origin,
  };
}

export function readCurrentContext() {
  const path = window.location.pathname;
  // DELIBERATE DUPLICATE of src/rossum/annotationUrl.js: this function is
  // serialized and injected into the page, so it cannot close over an import.
  // If the annotation-URL grammar changes there, change it here too.
  const docMatch = path.match(/\/document\/(\d+)/) || path.match(/\/annotations?\/(\d+)/);
  const queueMatch = path.match(/\/queues?\/(\d+)/);
  return {
    token: window.localStorage.getItem('secureToken'),
    domain: window.location.origin,
    annotationId: docMatch ? docMatch[1] : null,
    queueId: queueMatch ? queueMatch[1] : null,
  };
}

export function readPageFlag(key) {
  return window.localStorage.getItem(key) === 'true';
}

// Returns the flag's NEW value (not a bare `true`): the popup needs the
// authoritative direction, and its cached copy can still be un-filled while the
// first readPageFlag round-trip is in flight.
export function togglePageFlag(key) {
  if (window.localStorage.getItem(key) === 'true') {
    window.localStorage.removeItem(key);
  } else {
    window.localStorage.setItem(key, 'true');
  }
  return window.localStorage.getItem(key) === 'true';
}
