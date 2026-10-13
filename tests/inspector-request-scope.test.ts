import { describe, it, expect, vi } from 'vitest';
import { createRequestScope } from '../src/inspector/requestScope.js';

describe('createRequestScope', () => {
  it('shares one run between concurrent callers of a key', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => [1]);
    const [a, b] = await Promise.all([scope.get('hooks:3', fn), scope.get('hooks:3', fn)]);
    expect(a).toEqual([1]);
    expect(b).toBe(a);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reuses a settled success for a later caller', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => 'v');
    await scope.get('k', fn);
    await scope.get('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reuses a failure too, so nobody in the load retries it', async () => {
    const scope = createRequestScope();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('throttled'), { status: 429 });
    });
    await expect(scope.get('k', fn)).rejects.toMatchObject({ status: 429 });
    await expect(scope.get('k', fn)).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs different keys separately, and separate scopes never share', async () => {
    const one = createRequestScope();
    const two = createRequestScope();
    const fn = vi.fn(async () => 'v');
    await one.get('a', fn);
    await one.get('b', fn);
    await two.get('a', fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
