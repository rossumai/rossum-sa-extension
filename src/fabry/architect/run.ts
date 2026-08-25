// Concurrency-limited, abort-aware runner for Architect requirement checks.
// Pure: transport arrives injected (runOne), results stream out via onResult —
// the deepLoop.js precedent. A runOne throw is isolated to that requirement.

export async function runChecks(
  reqs: any[],
  {
    runOne,
    onResult,
    concurrency = 3,
    signal,
  }: {
    runOne: (r: any) => Promise<any>;
    onResult?: (id: string, result: any) => void;
    concurrency?: number;
    signal?: AbortSignal | null;
  } = {} as any,
) {
  const results = new Array(reqs.length).fill(null);
  let next = 0;

  async function worker() {
    for (;;) {
      if (signal && signal.aborted) return;
      const i = next;
      next += 1;
      if (i >= reqs.length) return;
      const req = reqs[i];
      let result;
      try {
        result = await runOne(req);
      } catch (err) {
        result = {
          verdict: 'uncertain',
          evidence: `Check could not complete: ${(err as Error)?.message || err}`,
          chatId: null,
          error: true,
        };
      }
      if (signal && signal.aborted) return;
      if (result == null) return; // aborted/stale mid-runOne
      results[i] = result;
      if (onResult) onResult(req.id, result);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, reqs.length)) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}
