import type { WaitUntilFn } from "./driver";

export const REVALIDATING_SUFFIX = ":reval";
export const REVALIDATING_TTL_MS = 30_000;

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
