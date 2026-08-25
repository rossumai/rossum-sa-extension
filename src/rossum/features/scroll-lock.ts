// Restores #sidebar-scrollable's scroll position when Rossum re-renders the
// sidebar after user clicks (which would otherwise reset scrollTop to 0).
//
// Note: this runs in the content-script isolated world. We CANNOT intercept
// Rossum's main-world `element.scrollTop = 0` writes (Object.defineProperty
// from our world doesn't affect their wrapper). What we *can* do is detect
// when their write has happened (via the scroll event) and re-apply the
// saved value within a short lock window.
import { trackOnce } from '../../usage/track.js';

export function initScrollLock(element: HTMLElement | null): void {
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

  (element as any).__saScrollLockAttached = true;

  requestAnimationFrame(() => {
    if (element instanceof HTMLElement) element.scrollTop = 0;
  });

  const markUserScrollActive = () => {
    userScrollUntil = Date.now() + USER_SCROLL_DETECTION_MS;
  };

  // The single place the position is put back, so both callers count the same
  // way. Counted where the feature has demonstrably ACTED — where it really
  // moved the position — not where it merely attached: attaching happens on
  // every Rossum page carrying a sidebar, so counting there measured "the
  // toggle is on", i.e. enablement, which this extension stopped reporting when
  // the daily config snapshot was deleted (2026-08-19).
  //
  // Skipping the write when the position already matches is behaviour-preserving:
  // assigning scrollTop its current value is a no-op and fires no scroll event.
  const restoreTo = (top: number) => {
    if (element.scrollTop === top) return;
    element.scrollTop = top;
    trackOnce('sa_rossum_scroll_lock');
  };

  element.addEventListener('wheel', markUserScrollActive, { passive: true });
  element.addEventListener('touchstart', markUserScrollActive, { passive: true });
  element.addEventListener('mousedown', markUserScrollActive, { passive: true });
  element.addEventListener('keydown', markUserScrollActive, { passive: true });

  element.addEventListener(
    'scroll',
    () => {
      const now = Date.now();
      const cur = element.scrollTop;

      // Read the user-activity window BEFORE touching it. Until 2026-08-19 this
      // handler called markUserScrollActive() FIRST, which set userScrollUntil
      // to now + 250 and made the check below unconditionally true — so this
      // listener only ever RECORDED the position and the restore branch was
      // dead code. The feature still worked, but only through armLockWindow's
      // pre-emptive write; a reset arriving later in the lock window (which is
      // the case the file header describes) was never corrected.
      //
      // Extending the window is still right for MOMENTUM scrolling, which keeps
      // firing scroll events with no further wheel/touch/key input — but only
      // when the run was already attributable to the user.
      const userDriven = now <= userScrollUntil;
      if (userDriven) markUserScrollActive();

      if (!isRestoring && userDriven) {
        savedScrollTop = cur;
        return;
      }

      if (!isRestoring && now < lockUntil && savedScrollTop > MIN_SCROLL_POSITION_FOR_LOCK) {
        if (Math.abs(cur - savedScrollTop) > SCROLL_TOLERANCE_PX) {
          isRestoring = true;
          restoreTo(savedScrollTop);
          queueMicrotask(() => {
            isRestoring = false;
          });
        }
      }
    },
    { passive: true },
  );

  const armLockWindow = (ms: number) => {
    if (savedScrollTop <= MIN_SCROLL_POSITION_FOR_LOCK) return;
    lockUntil = Date.now() + ms;
    restoreTo(savedScrollTop);
    requestAnimationFrame(() => restoreTo(savedScrollTop));
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
