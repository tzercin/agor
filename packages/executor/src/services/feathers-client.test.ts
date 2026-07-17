import { describe, expect, it, vi } from 'vitest';
import {
  type LiveAuthErrorContext,
  recoverFromLiveAuthError,
  singleFlight,
} from './feathers-client.js';

/** A deferred promise whose resolution the test controls explicitly. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('singleFlight', () => {
  it('coalesces concurrent calls into one underlying invocation', async () => {
    const gate = deferred<boolean>();
    const fn = vi.fn(() => gate.promise);
    const wrapped = singleFlight(fn);

    // A single token expiry rejects many acks at once — simulate the burst.
    const a = wrapped();
    const b = wrapped();
    const c = wrapped();

    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve(true);
    // Every concurrent caller observes the REAL shared outcome, not an
    // optimistic "already in progress" value.
    await expect(Promise.all([a, b, c])).resolves.toEqual([true, true, true]);
  });

  it('re-runs after the in-flight promise settles (later expiry)', async () => {
    let n = 0;
    const wrapped = singleFlight(async () => {
      n += 1;
      return n;
    });

    await expect(wrapped()).resolves.toBe(1);
    await expect(wrapped()).resolves.toBe(2);
  });

  it('releases the slot even when the underlying call rejects', async () => {
    let attempt = 0;
    const wrapped = singleFlight(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return attempt;
    });

    await expect(wrapped()).rejects.toThrow('boom');
    // Slot released after rejection, so the next call runs again.
    await expect(wrapped()).resolves.toBe(2);
  });
});

function makeContext(overrides: Partial<LiveAuthErrorContext>): LiveAuthErrorContext {
  return {
    path: 'sessions',
    method: 'patch',
    service: {} as LiveAuthErrorContext['service'],
    params: {},
    error: { code: 401, name: 'NotAuthenticated' },
    ...overrides,
  };
}

describe('recoverFromLiveAuthError', () => {
  it('passes through non-auth errors untouched', async () => {
    const reauth = vi.fn(async () => true);
    const context = makeContext({ error: { code: 500, name: 'GeneralError' } });

    await recoverFromLiveAuthError(context, reauth);

    expect(reauth).not.toHaveBeenCalled();
    expect(context.error).toEqual({ code: 500, name: 'GeneralError' });
    expect(context.result).toBeUndefined();
  });

  it('never intercepts the authentication service (would recurse)', async () => {
    const reauth = vi.fn(async () => true);
    const context = makeContext({ path: 'authentication' });

    await recoverFromLiveAuthError(context, reauth);

    expect(reauth).not.toHaveBeenCalled();
    expect(context.error).toEqual({ code: 401, name: 'NotAuthenticated' });
  });

  it('re-authenticates and replays the original call once, clearing the error', async () => {
    const patch = vi.fn(async () => ({ id: 's1', status: 'ok' }));
    const reauth = vi.fn(async () => true);
    const onExpired = vi.fn();
    const context = makeContext({
      method: 'patch',
      id: 's1',
      data: { status: 'ok' },
      params: { query: { keep: 1 } },
      service: { patch } as unknown as LiveAuthErrorContext['service'],
    });

    await recoverFromLiveAuthError(context, reauth, onExpired);

    expect(onExpired).toHaveBeenCalledWith('sessions.patch');
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
    // Retry carries the original params plus the one-shot retry flag.
    expect(patch).toHaveBeenCalledWith(
      's1',
      { status: 'ok' },
      {
        query: { keep: 1 },
        __executorReauthRetried: true,
      }
    );
    expect(context.error).toBeNull();
    expect(context.result).toEqual({ id: 's1', status: 'ok' });
  });

  it('does not retry a request that was already retried once', async () => {
    const reauth = vi.fn(async () => true);
    const patch = vi.fn();
    const context = makeContext({
      params: { __executorReauthRetried: true },
      service: { patch } as unknown as LiveAuthErrorContext['service'],
    });

    await recoverFromLiveAuthError(context, reauth);

    expect(reauth).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(context.error).toEqual({ code: 401, name: 'NotAuthenticated' });
  });

  it('surfaces the original error when re-authentication fails', async () => {
    const patch = vi.fn();
    const reauth = vi.fn(async () => false);
    const context = makeContext({
      service: { patch } as unknown as LiveAuthErrorContext['service'],
    });

    await recoverFromLiveAuthError(context, reauth);

    expect(reauth).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(context.error).toEqual({ code: 401, name: 'NotAuthenticated' });
  });

  it('surfaces the retry error if the replayed call also fails', async () => {
    const retryError = Object.assign(new Error('still bad'), { code: 403 });
    const patch = vi.fn(async () => {
      throw retryError;
    });
    const reauth = vi.fn(async () => true);
    const context = makeContext({
      service: { patch } as unknown as LiveAuthErrorContext['service'],
    });

    await recoverFromLiveAuthError(context, reauth);

    expect(context.error).toBe(retryError);
    expect(context.result).toBeUndefined();
  });

  it('does not blind-retry unknown/custom methods', async () => {
    const reauth = vi.fn(async () => true);
    const context = makeContext({ method: 'customThing', service: {} as never });

    await recoverFromLiveAuthError(context, reauth);

    // Re-auth still runs, but the custom method is not replayed.
    expect(reauth).toHaveBeenCalledTimes(1);
    expect(context.error).toEqual({ code: 401, name: 'NotAuthenticated' });
  });

  it('recognizes a 401 by name even without a numeric code', async () => {
    const get = vi.fn(async () => ({ id: 'x' }));
    const reauth = vi.fn(async () => true);
    const context = makeContext({
      method: 'get',
      id: 'x',
      error: { name: 'NotAuthenticated' },
      service: { get } as unknown as LiveAuthErrorContext['service'],
    });

    await recoverFromLiveAuthError(context, reauth);

    expect(get).toHaveBeenCalledWith('x', { __executorReauthRetried: true });
    expect(context.error).toBeNull();
  });

  it('drives exactly one re-auth for a burst of concurrent 401s (single-flight)', async () => {
    const gate = deferred<boolean>();
    const rawReauth = vi.fn(() => gate.promise);
    const reauthenticate = singleFlight(rawReauth);

    const patch = vi.fn(async () => ({ ok: true }));
    const makeCall = () =>
      recoverFromLiveAuthError(
        makeContext({ service: { patch } as unknown as LiveAuthErrorContext['service'] }),
        () => reauthenticate()
      );

    // Three acks rejected by the same token expiry, all in flight together.
    const calls = [makeCall(), makeCall(), makeCall()];
    // Let the microtasks reach the awaited reauthenticate().
    await Promise.resolve();
    expect(rawReauth).toHaveBeenCalledTimes(1);

    gate.resolve(true);
    const results = await Promise.all(calls);

    // One shared re-auth, but each request is independently replayed.
    expect(rawReauth).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(3);
    for (const context of results) {
      expect(context.error).toBeNull();
      expect(context.result).toEqual({ ok: true });
    }
  });
});
