/**
 * Stale-while-revalidate, a value the cache is configured with
 * (`cache({ driver, swr: staleWhileRevalidate })`): a cache without it
 * carries none of this code, and refuses a view's `swr` option.
 */
import { work } from "@extensions/observation";
import { note } from "@extensions/unit-words";
import { marker, scheduleBackground } from "./cache-background";
import type { Refresh, Revalidate } from "./driver";
import { cacheOutcome, revalidationStart } from "./units";

/**
 * A stale entry within its window is served, and refreshed in the
 * background: claim the backend's marker (best effort; another request
 * holding it skips), replay the read's core keeping its rows, store them,
 * and always clear the marker. Nothing here rejects: its `revalidate` unit
 * presents a failure, the replay's primary over the cleanup's, both
 * retained.
 */
export const staleWhileRevalidate: Revalidate = (refresh) => {
  const { request, entry, now } = refresh;
  const window = request.read.swr;
  if (
    window === false ||
    now - entry.createdAt >= window ||
    now >= entry.expiresAt!
  )
    return false;
  // Stale, served; refreshed in the background, where the read runs once
  // more after this serve returned: the core alone.
  scheduleBackground(refreshed(refresh), request.waitUntil);
  note(request.origin, cacheOutcome("hit", "stale"));
  return true;
};

async function refreshed({
  request,
  key,
  backend,
  store,
}: Refresh): Promise<void> {
  try {
    if (!(await marker(backend, key, true))) return;
  } catch {
    // A marker that cannot be claimed skips the refresh, never the read.
    return;
  }
  const { codec } = request;
  // Its own `cache` unit, whose terminal outcome is noted on it; a failure
  // of the replay is primary over the cleanup's, both retained.
  await work(
    request.origin,
    {
      kind: "cache",
      operation: "revalidate",
      note: revalidationStart(request, request.database),
    },
    async (unit) => {
      let failed = false;
      let failure: unknown;
      let terminal: ReturnType<typeof cacheOutcome>;
      try {
        await codec.run();
        await store(codec.snapshot());
        terminal = cacheOutcome("revalidate", "success", undefined, request);
      } catch (error) {
        failed = true;
        failure = error;
        terminal = cacheOutcome("revalidate", "error", error, request);
      }
      try {
        await marker(backend, key, false);
      } catch (cleanupFailure) {
        failure = failed
          ? new AggregateError(
              [failure, cleanupFailure],
              "Cache revalidation work and cleanup both failed.",
              { cause: failure }
            )
          : cleanupFailure;
        failed = true;
      }
      note(unit, terminal);
      if (failed) throw failure;
    }
  );
}
