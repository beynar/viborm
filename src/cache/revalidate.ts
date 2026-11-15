/**
 * Stale-while-revalidate, a value the cache is configured with
 * (`cache({ driver, swr: staleWhileRevalidate })`): a cache without it
 * carries none of this code, and refuses a view's `swr` option.
 */
import type { Refresh } from "./driver";
import { cacheOutcome, revalidation } from "./units";

/**
 * Refresh one stale entry in the background: claim the backend's marker
 * (best effort; another request holding it skips), replay the read's core
 * keeping its rows, store them, and always clear the marker. Nothing here
 * rejects: its `revalidate` unit presents a failure, the replay's primary
 * over the cleanup's, both retained.
 */
export async function staleWhileRevalidate({
  request,
  mark,
  store,
  clear,
}: Refresh): Promise<void> {
  try {
    if (!(await mark())) return;
  } catch {
    // A marker that cannot be claimed skips the refresh, never the read.
    return;
  }
  const { codec } = request;
  await revalidation(
    request.origin,
    request,
    request.database,
    async (failure) => {
      let terminal: ReturnType<typeof cacheOutcome>;
      try {
        await codec.run();
        await store(codec.snapshot());
        terminal = cacheOutcome("revalidate", "success", undefined, request);
      } catch (error) {
        failure.failed = true;
        failure.error = error;
        terminal = cacheOutcome("revalidate", "error", error, request);
      } finally {
        try {
          await clear();
        } catch (cleanupFailure) {
          failure.error = failure.failed
            ? new AggregateError(
                [failure.error, cleanupFailure],
                "Cache revalidation work and cleanup both failed.",
                { cause: failure.error }
              )
            : cleanupFailure;
          failure.failed = true;
        }
      }
      return terminal;
    }
  );
}
