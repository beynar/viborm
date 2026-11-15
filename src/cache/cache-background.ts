import type { CacheEntry, WaitUntilFn } from "./driver";

export const REVALIDATING_SUFFIX = ":reval";
const REVALIDATING_TTL_MS = 30_000;

export function scheduleBackground(
  promise: Promise<unknown>,
  waitUntil: WaitUntilFn | undefined
): void {
  const observed = promise.catch(() => undefined);
  if (!waitUntil) return;
  try {
    waitUntil(observed);
  } catch {
    // Background scheduling cannot alter the authoritative query outcome.
  }
}

/** A driver's own storage primitives, unobserved, and its clock. */
export interface Backend {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, ttl: number, entry: CacheEntry): Promise<void>;
  delete(keys: string[]): Promise<void>;
  now(): number;
}

/**
 * Claim the refresh of the entry at `key` (whether this caller performs
 * it), or release the claim: a marker beside the entry, with a short TTL.
 */
export async function marker(
  backend: Backend,
  key: string,
  claim: boolean
): Promise<boolean> {
  const marked = `${key}${REVALIDATING_SUFFIX}`;
  if (!claim) {
    await backend.delete([marked]);
    return false;
  }
  const existing = await backend.get(marked);
  if (existing && backend.now() - existing.createdAt < existing.ttl)
    return false;
  await backend.set(marked, REVALIDATING_TTL_MS, {
    value: true,
    createdAt: backend.now(),
    ttl: REVALIDATING_TTL_MS,
  });
  return true;
}
