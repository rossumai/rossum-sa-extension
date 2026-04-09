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
  console.log('[SA Extension] Scroll lock initialized for #sidebar-scrollable, pathname:', currentPathname);

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

  const monitorElementConnection = () => {
    if (!element.isConnected) {
      contentObserver.disconnect();
      return;
    }
    requestAnimationFrame(monitorElementConnection);
  };

  requestAnimationFrame(monitorElementConnection);
}

export function initFocusPatch() {
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
          const options = hasPreventScroll
            ? firstArg
            : { ...firstArg, preventScroll: true };

          return originalFocus.call(this, options);
        }

        return originalFocus.apply(this, args);
      } catch {
        return originalFocus.apply(this, args);
      }
    };
    HTMLElement.prototype.__saFocusPatched = true;
  }
}
