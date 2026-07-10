// Bridges the DevTools panel to the inspected Rossum tab: reads {token, domain,
// pathname} via chrome.devtools.inspectedWindow.eval and reports it whenever it
// changes (initial read + poll, since SPA nav does not fire onNavigated).
const EXPR =
  "JSON.stringify({token: localStorage.getItem('secureToken'), domain: location.origin, pathname: location.pathname, search: location.search})";

export function startBridge(onContext, opts = {}) {
  const chromeApi = opts.chromeApi || (typeof chrome !== 'undefined' ? chrome : undefined);
  const intervalMs = opts.intervalMs || 1000;
  const setIntervalFn = opts.setInterval || setInterval;
  const clearIntervalFn = opts.clearInterval || clearInterval;
  let lastKey = null;
  let stopped = false;

  const read = () => {
    if (stopped || !chromeApi || !chromeApi.devtools) return;
    chromeApi.devtools.inspectedWindow.eval(EXPR, (result, err) => {
      if (stopped || err || !result) return;
      let ctx;
      try { ctx = JSON.parse(result); } catch { return; }
      const key = `${ctx.domain}|${ctx.pathname}|${ctx.search || ''}|${ctx.token || ''}`;
      if (key !== lastKey) { lastKey = key; onContext(ctx); }
    });
  };

  read();
  const timer = setIntervalFn(read, intervalMs);
  return () => { stopped = true; clearIntervalFn(timer); };
}
