import { domain } from './store.js';
import { buildDeeplink } from './deeplink.js';

// Render context for descriptor columns/detail: deep-links built from the origin.
export function makeCtx() {
  return {
    deeplink: (type: string, id: string | number) => buildDeeplink(domain.value, type, id),
  };
}
