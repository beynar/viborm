import type { VibSchema } from "../types";
import { createSchema, fail } from "./helpers";

/**
 * A key that EXISTS on an object schema but accepts NOTHING.
 *
 * Leaving a key out already rejects it — with `Unknown key: gt`, which reads
 * like a typo. Some keys are absent for a reason worth telling the caller:
 * ordered comparison on an enum cannot answer the same on every provider
 * (see {@link file://../scalars/enum.ts}), `_distance` is only meaningful under
 * a vector order (see {@link file://../model/core/orderby.ts}). Spelling those
 * out as a refusal turns a shrug into an explanation, and keeps the key in the
 * schema where the reason can be read.
 *
 * Input and output are both `never`, so TypeScript refuses the key too —
 * the runtime refusal is the backstop for untyped callers.
 *
 * @param reason - the message the caller sees, stating WHY, not just "no"
 */
export function refused(reason: string): VibSchema<never, never> {
  return createSchema<never, never>("refused", () => fail(reason));
}
