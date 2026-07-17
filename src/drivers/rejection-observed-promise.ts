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
