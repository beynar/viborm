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
export class SavepointQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  /**
   * Enqueue a savepoint operation to be executed sequentially.
   * Operations enqueued in the same tick are batched and executed in order.
   *
   * @param fn - The async function to execute (creates savepoint, runs callback, releases/rollbacks)
   * @returns Promise that resolves with the function's return value
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
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
   */
  private async flush(): Promise<void> {
    while (this.queue.length > 0) {
      const op = this.queue.shift();
      if (op) {
        await op();
      }
    }
    this.processing = false;
  }
}
