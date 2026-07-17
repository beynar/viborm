/** Observe a callback result without allowing an async rejection to escape. */
export function ignoreObserverFailure(result: unknown): void {
  try {
    Promise.resolve(result).catch(() => undefined);
  } catch {
    // Observers cannot alter application behavior.
  }
}
