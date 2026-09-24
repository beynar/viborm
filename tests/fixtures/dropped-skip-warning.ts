import { afterAll, beforeAll, type MockInstance, vi } from "vitest";

/**
 * The warning an operation emits when it drops `createMany skipDuplicates`
 * because it holds no member rollback region (owner decision 2026-09-24,
 * "Warn, drop skipDuplicates"; `OperationContext.admitsSuppression`). It is
 * emitted once per client and model through `console.warn` when the client
 * routes no warnings to a logger.
 */
export function droppedSkipWarning(driver: string, target: string): string {
  return `[viborm] createMany skipDuplicates cannot skip rows involving nested writes on driver "${driver}" (no savepoint in this scope to undo a duplicate) in ${target}; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`;
}

/**
 * Capture `console.warn` for the enclosing suite and read back the dropped-skip
 * warnings one model has received. The capture spans the suite because the
 * warning is deduplicated per client and model, and a suite shares its client.
 */
export function captureDroppedSkipWarnings(): (model: string) => string[] {
  let warn: MockInstance<typeof console.warn> | undefined;
  beforeAll(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterAll(() => {
    warn?.mockRestore();
  });
  return (model) =>
    (warn?.mock.calls ?? [])
      .map(([message]) => message)
      .filter(
        (message): message is string =>
          typeof message === "string" &&
          message.startsWith("[viborm] createMany skipDuplicates") &&
          message.includes(` in ${model}.`)
      );
}
