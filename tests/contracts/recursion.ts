/**
 * Recursion in a shared suite, on a dialect that refuses it.
 *
 * SQL Server refuses `recurse` in a filter or a projection with a typed
 * FeatureNotSupportedError (T-SQL allows no WITH inside a subquery and no
 * UNION in a recursive member). A suite registered there keeps its
 * recursive tests: each runs its own body, which must fail with that
 * refusal and nothing else, so no test is skipped in silence and a dialect
 * that starts to recurse turns them red.
 */

import { FeatureNotSupportedError } from "@errors";
import { test } from "vitest";

export interface RecursionSupport {
  /** The dialect refuses `recurse` (SQL Server). */
  readonly refusesRecursion?: boolean;
}

/**
 * The dialect's refusal of `recurse`, thrown, or met by an assertion on what
 * a call rejects with (`expect(…).rejects`), whose `actual` it is.
 */
export const isRecursionRefusal = (error: unknown): boolean => {
  const refusal =
    error instanceof FeatureNotSupportedError
      ? error
      : (error as { actual?: unknown } | null)?.actual;
  return (
    refusal instanceof FeatureNotSupportedError &&
    (refusal.meta as { method?: string } | undefined)?.method === "recurse"
  );
};

/** `run` fails with the dialect's refusal of `recurse`. */
export async function expectRecursionRefused(
  run: () => unknown
): Promise<void> {
  const failure = await Promise.resolve()
    .then(run)
    .then(
      () => new Error("the body ran without being refused"),
      (error: unknown) => error
    );
  if (!isRecursionRefusal(failure)) throw failure;
}

/**
 * `test(name, body)`, or where `provider` refuses recursion, the same body
 * asserting that refusal.
 */
export function recursiveTest(
  provider: RecursionSupport,
  name: string,
  body: () => unknown,
  timeout?: number
): void {
  if (provider.refusesRecursion)
    test(
      `${name} (refused: the dialect has no recursion)`,
      () => expectRecursionRefused(body),
      timeout
    );
  else test(name, body as () => Promise<void>, timeout);
}
