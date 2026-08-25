import { describe, it, expect, vi } from 'vitest';
import { startBridge } from '../src/devtools/inspected.js';

function fakeChrome(evalImpl: any) {
  return { devtools: { inspectedWindow: { eval: evalImpl } } };
}
const CTX = (pathname: any, search = '') =>
  JSON.stringify({ token: 'TKN', domain: 'https://acme.rossum.app', pathname, search });

describe('startBridge', () => {
  it('reads context once on start and reports it', () => {
    const evalFn = vi.fn((expr, cb) => cb(CTX('/queues/1'), null));
    const onContext = vi.fn();
    const stop = startBridge(onContext, {
      chromeApi: fakeChrome(evalFn),
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext.mock.calls[0][0]).toEqual({
      token: 'TKN',
      domain: 'https://acme.rossum.app',
      pathname: '/queues/1',
      search: '',
    });
    stop();
  });

  it('reports again only when the context key changes (poll)', () => {
    let path = '/queues/1';
    const evalFn = vi.fn((expr, cb) => cb(CTX(path), null));
    const onContext = vi.fn();
    let tick: any;
    const stop = startBridge(onContext, {
      chromeApi: fakeChrome(evalFn),
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    expect(onContext).toHaveBeenCalledTimes(1);
    tick(); // same path → no new report
    expect(onContext).toHaveBeenCalledTimes(1);
    path = '/queues/2';
    tick(); // changed → report
    expect(onContext).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores eval errors', () => {
    const evalFn = vi.fn((expr, cb) => cb(null, { isError: true }));
    const onContext = vi.fn();
    const stop = startBridge(onContext, {
      chromeApi: fakeChrome(evalFn),
      setInterval: () => 0,
      clearInterval: () => {},
    });
    expect(onContext).not.toHaveBeenCalled();
    stop();
  });

  it('reports again when only the token changes (session refresh)', () => {
    let token = 'TKN1';
    const evalFn = vi.fn((expr, cb) =>
      cb(JSON.stringify({ token, domain: 'https://acme.rossum.app', pathname: '/queues/1' }), null),
    );
    const onContext = vi.fn();
    let tick: any;
    const stop = startBridge(onContext, {
      chromeApi: fakeChrome(evalFn),
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    expect(onContext).toHaveBeenCalledTimes(1);
    tick();
    expect(onContext).toHaveBeenCalledTimes(1);
    token = 'TKN2';
    tick();
    expect(onContext).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stop() clears the poll interval', () => {
    const evalFn = vi.fn((expr, cb) => cb(CTX('/queues/1'), null));
    const clearFn = vi.fn();
    const stop = startBridge(vi.fn(), {
      chromeApi: fakeChrome(evalFn),
      setInterval: () => 42,
      clearInterval: clearFn,
    });
    stop();
    expect(clearFn).toHaveBeenCalledWith(42);
  });

  it('reports again when only the search (query) changes', () => {
    let search = '?level=queue&filtering=a';
    const evalFn = vi.fn((expr, cb) => cb(CTX('/documents', search), null));
    const onContext = vi.fn();
    let tick: any;
    const stop = startBridge(onContext, {
      chromeApi: fakeChrome(evalFn),
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {},
    });
    expect(onContext).toHaveBeenCalledTimes(1);
    tick();
    expect(onContext).toHaveBeenCalledTimes(1); // same → no refire
    search = '?level=queue&filtering=b';
    tick();
    expect(onContext).toHaveBeenCalledTimes(2); // search changed → refire
    stop();
  });
});
