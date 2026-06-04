import { domain } from './store.js';
import { buildDeeplink } from './deeplink.js';

// Render context for descriptor columns/detail: deep-links built from the origin.
export function makeCtx() {
  return {
    deeplink: (type, id) => buildDeeplink(domain.value, type, id),
  };
}
