// A promise memo for ONE annotation load (spec 2026-10-13-api-call-reduction-design.md
// §4.2). Every caller in the load shares one request per key: the loaders, the panels
// that call them on mount, and the attribution fallback. A rejection is kept too, so
// nobody in the load retries it, a 429 included. The next load creates a new scope,
// which is what makes reopening an annotation fetch again.
export type RequestScope = { get<T>(key: string, fn: () => Promise<T>): Promise<T> };

export function createRequestScope(): RequestScope {
  const memo = new Map<string, Promise<unknown>>();
  return {
    get<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let p = memo.get(key) as Promise<T> | undefined;
      if (!p) {
        p = fn();
        // Kept even when rejected; mark it handled so a caller that never awaits it
        // does not surface an unhandled rejection.
        p.catch(() => {});
        memo.set(key, p);
      }
      return p;
    },
  };
}
