/**
 * SavepointQueue - Serializes savepoint operations to prevent stack conflicts.
 *
 * PostgreSQL savepoints are stack-based: if you create savepoint A, then B,
 * you must release B before A. When multiple nested transactions are started
 * concurrently (e.g., via Promise.all), they can interleave and break.
 *
 * This queue ensures all savepoint operations within the same transaction
 * execute sequentially, even if they're initiated concurrently.
 *
 * @example
 * ```typescript
 * // Without queue - breaks due to interleaved savepoints
 * await Promise.all([
 *   tx.$transaction(async () => {}),  // SAVEPOINT A
 *   tx.$transaction(async () => {}),  // SAVEPOINT B
 * ]);
 * // Release order is unpredictable
 *
 * // With queue - works correctly
 * // All operations are serialized: A completes fully, then B
 * ```
 */
export interface QueueWaitBound {
  /** Milliseconds a job may sit in the queue before it is given up on. */
  readonly maxWaitMs: number;
  /** Builds the rejection for a job that waited too long. */
  readonly onMaxWaitExceeded: () => Error;
}

export class SavepointQueue {
  private queue: Array<() => Promise<void>> = [];
  private head = 0;
  private processing = false;

  /**
   * Enqueue a savepoint operation to be executed sequentially.
   * Operations enqueued in the same tick are batched and executed in order.
   *
   * With a `wait` bound, a job that has not *started* within `maxWaitMs` is
   * rejected and skipped: `fn` is never invoked, so a bounded-out transaction
   * cannot have opened anything that would need rolling back. Jobs already
   * running are untouched — the bound is on waiting, not on execution.
   *
   * @param fn - The async function to execute (creates savepoint, runs callback, releases/rollbacks)
   * @param wait - Optional bound on how long this job may wait to start
   * @returns Promise that resolves with the function's return value
   */
  enqueue<T>(fn: () => Promise<T>, wait?: QueueWaitBound): Promise<T> {
    return new Promise((resolve, reject) => {
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (wait) {
        timer = setTimeout(() => {
          abandoned = true;
          reject(wait.onMaxWaitExceeded());
        }, wait.maxWaitMs);
      }
      this.queue.push(async () => {
        if (timer) clearTimeout(timer);
        if (abandoned) return;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      this.scheduleFlush();
    });
  }

  /**
   * Run one statement now when nothing holds the queue, else enqueue it.
   *
   * An idle queue has no job to order this one after, so the microtask hop,
   * the job wrapper and the flush loop only cost time. The queue is held while
   * `fn` runs, so anything enqueued meanwhile still waits for it, in order.
   */
  run<T>(fn: () => Promise<T>, wait?: QueueWaitBound): Promise<T> {
    if (this.processing) return this.enqueue(fn, wait);
    this.processing = true;
    const result = fn();
    const release = () => this.flush();
    result.then(release, release);
    return result;
  }

  /**
   * Schedule queue processing at the end of the current microtask.
   * Only schedules if not already processing.
   */
  private scheduleFlush(): void {
    if (!this.processing) {
      this.processing = true;
      queueMicrotask(() => this.flush());
    }
  }

  /**
   * Process all queued operations sequentially.
   * Each operation completes fully before the next starts.
   * Uses index-based iteration to avoid O(n) shift() operations.
   */
  private async flush(): Promise<void> {
    while (this.head < this.queue.length) {
      const op = this.queue[this.head++];
      if (op) {
        await op();
      }
    }
    // Reset queue after processing to free memory
    this.queue = [];
    this.head = 0;
    this.processing = false;
  }
}
