import { ValidationError } from "@errors";
import { type InferOutput, parse, type VibSchema } from "@validation";
import { readValidationFailureCause } from "@validation/parse-failure";
// The two leaves below are imported from their own modules rather than through the `v`
// namespace: this module is a transitive dependency of the schema builder, and the
// barrel is what the recorded import cycle runs through.
import { object } from "@validation/primitives/object";
import { anyValue, rawRecord } from "@validation/primitives/raw-record";
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
      })),
      { cause: readValidationFailureCause(result) }
    );
  }
  return result.value as InferOutput<S>;
}

/**
 * The `upsert` ENVELOPE, and only the envelope.
 *
 * `upsert` was the one write operation whose front line lived in the engine: a key gate
 * (`assertUpsertKeys`) plus three `requireRecord` narrowings. X2 kept them deliberately,
 * and its two reasons were sound — but both are about the ARMS, not the envelope:
 *
 *  · the arms are handed to `CreateOperation` / `UpdateOperation` sub-ops that parse the
 *    RAW payload FRESH, so a schema that TRANSFORMED them on the way past would make the
 *    second parse see the first parse's output (measured: a nested `createMany` whose
 *    re-parse answers `Expected string`);
 *  · an untaken arm's content must not run arm-specific validation, so a schema
 *    that descended into the arms would reject trees that never execute.
 *
 * This schema does neither. It is MODEL-BLIND — three required keys, five optional ones,
 * the object-ness of the three, and nothing else. No transform (the arms come back by
 * REFERENCE through {@link rawRecord}), no descent (the arms' contents are unread), and
 * no shape for the optional five ({@link anyValue}), whose own schemas own them one step
 * later. What is left is a SHAPE CHECK, and a shape check has one home.
 *
 * The key set mirrors the deleted `assertUpsertKeys` exactly, including the five optional
 * names. `cache` is absent from both: the client strips it before the engine
 * (`client.ts`), so it never arrives.
 */
export const upsertEnvelopeSchema = object(
  {
    where: rawRecord(),
    create: rawRecord(),
    update: rawRecord(),
    select: anyValue(),
    include: anyValue(),
    omit: anyValue(),
    targetWhere: anyValue(),
    setWhere: anyValue(),
  },
  { atLeast: ["where", "create", "update"] }
);

/** The envelope's validated output — the three arms typed, the five optional keys
 *  untouched. */
export type UpsertEnvelope = InferOutput<typeof upsertEnvelopeSchema>;
