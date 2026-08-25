// Bridges the DevTools panel to the inspected Rossum tab: reads {token, domain,
// pathname} via chrome.devtools.inspectedWindow.eval and reports it whenever it
// changes (initial read + poll, since SPA nav does not fire onNavigated).
const EXPR =
  "JSON.stringify({token: localStorage.getItem('secureToken'), domain: location.origin, pathname: location.pathname, search: location.search})";

/** What the inspected page reports. `search` is included so `?level=all` vs `?level=queue`
 *  on the same path re-detect. */
export type InspectedContext = { token: string | null; domain: string; pathname: string; search: string };

export type BridgeOptions = {
  chromeApi?: any;
  intervalMs?: number;
  /** Only ever called as `setInterval(read, intervalMs)`, so that is all a test seam has to
   *  supply — `typeof setInterval` would demand the whole DOM overload set from a stub. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: any) => void;
};

export function startBridge(onContext: (ctx: InspectedContext) => void, opts: BridgeOptions = {}) {
  const chromeApi = opts.chromeApi || (typeof chrome !== 'undefined' ? chrome : undefined);
  const intervalMs = opts.intervalMs || 1000;
  const setIntervalFn = opts.setInterval || setInterval;
  // Annotated so the handle stays opaque: `opts.clearInterval || clearInterval` would
  // otherwise union the injected seam with the DOM signature and demand a number.
  const clearIntervalFn: (handle: any) => void = opts.clearInterval || clearInterval;
  let lastKey: string | null = null;
  let stopped = false;

  const read = () => {
    if (stopped || !chromeApi || !chromeApi.devtools) return;
    chromeApi.devtools.inspectedWindow.eval(EXPR, (result: string, err: unknown) => {
      if (stopped || err || !result) return;
      let ctx: InspectedContext;
      try { ctx = JSON.parse(result); } catch { return; }
      const key = `${ctx.domain}|${ctx.pathname}|${ctx.search || ''}|${ctx.token || ''}`;
      if (key !== lastKey) { lastKey = key; onContext(ctx); }
    });
  };

  read();
  const timer = setIntervalFn(read, intervalMs);
  return () => { stopped = true; clearIntervalFn(timer); };
}
