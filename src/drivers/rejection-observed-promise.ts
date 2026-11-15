/**
 * Wrap a native promise so transaction scope tracking can distinguish a
 * handled nested rejection from fire-and-forget work. Await and catch both
 * supply a rejection handler through this Promise-compatible surface.
 */
export function observePromiseRejection<T>(
  promise: Promise<T>,
  onRejectionObserved: () => void
): Promise<T> {
  return new RejectionObservedPromise(promise, onRejectionObserved);
}

/**
 * `promise.then(onfulfilled)` that is no handler of its rejection: what
 * runs after a nested transaction committed, leaving the caller's own
 * handlers to say whether its failure was observed. The promise it makes
 * rejects with that failure, which the outer transaction reports unless the
 * caller observes it, so it leaves no unhandled rejection of its own.
 */
export function afterFulfilled<T, R>(
  promise: Promise<T>,
  onfulfilled: (value: T) => R | PromiseLike<R>
): Promise<R> {
  return promise instanceof RejectionObservedPromise
    ? promise.fulfilled(onfulfilled)
    : promise.then(onfulfilled);
}

class RejectionObservedPromise<T> implements Promise<T> {
  readonly [Symbol.toStringTag] = "Promise";
  private readonly onRejectionObserved: () => void;
  private readonly promise: Promise<T>;

  constructor(promise: Promise<T>, onRejectionObserved: () => void) {
    this.promise = promise;
    this.onRejectionObserved = onRejectionObserved;
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => PromiseLike<TResult1> | TResult1) | null,
    onrejected?: ((reason: unknown) => PromiseLike<TResult2> | TResult2) | null
  ): Promise<TResult1 | TResult2> {
    if (onrejected) this.onRejectionObserved();
    return new RejectionObservedPromise(
      this.promise.then(onfulfilled, onrejected),
      this.onRejectionObserved
    );
  }

  fulfilled<R>(onfulfilled: (value: T) => R | PromiseLike<R>): Promise<R> {
    const next = this.promise.then(onfulfilled);
    next.catch(() => undefined);
    return new RejectionObservedPromise(next, this.onRejectionObserved);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => PromiseLike<TResult> | TResult) | null
  ): Promise<T | TResult> {
    if (onrejected) this.onRejectionObserved();
    return new RejectionObservedPromise(
      this.promise.catch(onrejected),
      this.onRejectionObserved
    );
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return new RejectionObservedPromise(
      this.promise.finally(onfinally),
      this.onRejectionObserved
    );
  }
}
