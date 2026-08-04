import { ValidationError } from "@errors";
import { type InferOutput, parse, type VibSchema } from "@validation";
import type { Operation } from "../types";

/**
 * THE typed parse boundary (X2 — one home for validation). Every seam that turns a
 * user payload (or a sub-payload: a `where`, a `select`, a nested `create`) into a
 * validated value flows through here. It runs the schema, converts a validation
 * failure into V1's byte-identical {@link ValidationError} (operation name +
 * dotted issue path), and returns the schema's INFERRED output type — the `TOutput`
 * the `ObjectSchema` already computes — instead of erasing it to
 * `Record<string, unknown>`.
 *
 * The lone `as InferOutput<S>` below is the ONLY assertion the engine needs and the
 * ONLY one allowed outside a genuinely untyped I/O edge: after the issues guard the
 * schema has PROVEN `value` matches `S`, but `parse`'s conditional result type keeps
 * `value` erased, so the inferred output is re-attached here — the one place
 * inference cannot reach on its own. This is what makes the in-engine re-validation
 * branches (the `isRecord(result.value)` / `requireRecord` / `requires a … object`
 * guards this boundary replaced) dead: the schema layer already guarantees the shape.
 * The structural gate (parse-boundary-gate.test.ts) fails loudly if a future phase
 * reintroduces such a branch or an `as Record<string, unknown>` on a validated path.
 *
 * @param schema    a concrete operation/core schema (its `TOutput` is the return type)
 * @param value     the raw payload to validate
 * @param operation the operation name carried on the {@link ValidationError}
 * @param path      the dotted prefix for issue paths ("" for a whole-args validate;
 *                  a field name like "where"/"select"/"createMany" for a sub-payload)
 */
export function parseValidated<S extends VibSchema>(
  schema: S,
  value: unknown,
  operation: Operation,
  path: string
): InferOutput<S> {
  const result = parse(schema, value);
  if (result.issues) {
    const prefix = path ? [path] : [];
    throw new ValidationError(
      operation,
      result.issues.map((issue) => ({
        path:
          [...prefix, ...(issue.path?.map(String) ?? [])].join(".") || "root",
        message: issue.message,
      }))
    );
  }
  return result.value as InferOutput<S>;
}
