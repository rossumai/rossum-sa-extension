// Restores #sidebar-scrollable's scroll position when Rossum re-renders the
// sidebar after user clicks (which would otherwise reset scrollTop to 0).
//
// Note: this runs in the content-script isolated world. We CANNOT intercept
// Rossum's main-world `element.scrollTop = 0` writes (Object.defineProperty
// from our world doesn't affect their wrapper). What we *can* do is detect
// when their write has happened (via the scroll event) and re-apply the
// saved value within a short lock window.
import { trackOnce } from '../../usage/track.js';

export function initScrollLock(element) {
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

  element.__saScrollLockAttached = true;
  trackOnce('sa_rossum_scroll_lock');

  requestAnimationFrame(() => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });

  const markUserScrollActive = () => {
    userScrollUntil = Date.now() + USER_SCROLL_DETECTION_MS;
  };

  element.addEventListener('wheel', markUserScrollActive, { passive: true });
  element.addEventListener('touchstart', markUserScrollActive, { passive: true });
  element.addEventListener('mousedown', markUserScrollActive, { passive: true });
  element.addEventListener('keydown', markUserScrollActive, { passive: true });

  element.addEventListener(
    'scroll',
    () => {
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
          queueMicrotask(() => {
            isRestoring = false;
          });
        }
      }
    },
    { passive: true },
  );

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

  const monitorInterval = setInterval(() => {
    if (!element.isConnected) {
      contentObserver.disconnect();
      clearInterval(monitorInterval);
    }
  }, 2000);
}
