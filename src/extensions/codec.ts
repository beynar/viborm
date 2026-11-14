/**
 * `codec(run)`: what detaches the core's answer to one prepared call and
 * restores it. `snapshot(value)` returns detached JSON data; `materialize`
 * checks the exact shape and returns a fresh graph on every call, as a fresh
 * read would. A value that does not follow the shape throws.
 *
 * Every value codec comes from the result owner
 * (`query-engine/result/cache-value-codecs.ts`), addressed by the declaring
 * `Scalar` object, never by a leaf's type name, so a restored value is
 * exactly a freshly parsed one. The STRUCTURE comes from the prepared read's
 * own published facts (`value`, `empty`), which the read owner states beside
 * the statement it decodes, so the codec and the decoder cannot disagree.
 * It holds for the core's answer only, not for one an inner part changed:
 * a record refuses a key it does not know.
 */
import { UnsupportedOperationError } from "@errors";
import type { PreparedOperation } from "@query-engine/raptor3/commands";
import { EngineInvariantError } from "@query-engine/raptor3/shared/invariant";
import type { Leaf, ProjectionShape } from "@query-engine/raptor3/shared/query";
import {
  arrayCodec,
  booleanCodec,
  compileScalarCodec,
  compileWidenedSumCodec,
  countCodec,
  nullableCodec,
  numberCodec,
  recordCodec,
  recursiveRelationCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "@query-engine/result/cache-value-codecs";
import type { Run } from "./contract";
import { callOf } from "./origin";

/** What detaches one prepared call's answer and restores it. */
export interface Codec {
  snapshot(value: unknown): unknown;
  materialize(stored: unknown): unknown;
}

/** One codec per prepared call: its shape does not change. */
const codecs = new WeakMap<PreparedOperation, Codec>();

/**
 * The codec of the answer `run` prepares. A call that is not one read (a
 * raw statement, a write) has none, and is refused.
 */
export function codec(run: Run<unknown, unknown>): Codec {
  const of = callOf(run)?.of;
  if (of === undefined)
    throw new UnsupportedOperationError(
      "codec() takes the run of a model's read: a raw statement has no codec."
    );
  return codecOf(of.prepared());
}

/** The codec of one prepared operation, made once. */
export function codecOf(prepared: PreparedOperation): Codec {
  const known = codecs.get(prepared);
  if (known !== undefined) return known;
  const { read, requested } = prepared;
  if (read === undefined)
    throw new UnsupportedOperationError(
      `Cannot detach '${requested.operation}' on model '${requested.model}': the operation has no readable result.`,
      { meta: { ...requested } }
    );
  // The read owner's own publication for zero rows says whether the public
  // value may be absent: `null` for a located row, `[]`/`{}`/`0`/`false` for
  // the shapes that always publish a value.
  const value = shapeCodec(read.value, requested.operation);
  const compiled = read.empty === null ? nullableCodec(value) : value;
  const made: Codec = Object.freeze({
    snapshot: (input: unknown) =>
      compiled.snapshot(input, new WeakSet<object>()),
    materialize: (stored: unknown) =>
      compiled.materialize(stored, new WeakSet<object>()),
  });
  codecs.set(prepared, made);
  return made;
}

/** One published shape, composed from the structural codecs. */
function shapeCodec(
  shape: ProjectionShape | Leaf,
  requestedOperation: string
): ValueCodec {
  // biome-ignore lint/style/useDefaultSwitchClause: the published shape union is exhaustive; a default would be dead code.
  switch (shape.kind) {
    case "scalar":
      return leafCodec(shape, requestedOperation);
    case "object": {
      const fields = new Map<string, ValueCodec>();
      for (const [name, field] of Object.entries(shape.fields))
        fields.set(name, shapeCodec(field, requestedOperation));
      const record = recordCodec(fields);
      return shape.nullable === false ? record : nullableCodec(record);
    }
    case "collection":
      return arrayCodec(shapeCodec(shape.row, requestedOperation));
    case "variants": {
      const arms = new Map<string, ValueCodec>();
      for (const [type, arm] of Object.entries(shape.arms))
        arms.set(
          type,
          shapeCodec(
            shape.many && arm.kind === "collection" ? arm.row : arm,
            requestedOperation
          )
        );
      const tagged = taggedRelationCodec(arms);
      return shape.many ? arrayCodec(tagged) : nullableCodec(tagged);
    }
    case "recursive":
      // The decoder published every occurrence; the entry keeps them as they
      // were published. The node is the ordinary row codec, and the structural
      // owner reads only the slot's own prepared facts — never an identity,
      // never the cycle policy the decoder already applied.
      return recursiveRelationCodec(
        {
          relation: shape.relation,
          many: shape.many,
          optional: shape.optional,
          depth: shape.recurrence.depth,
        },
        shapeCodec(shape.row, requestedOperation)
      );
  }
}

/**
 * One leaf's value codec.
 *
 * A leaf that a column declares carries that `Scalar`, and the official owner
 * compiles it: `compileWidenedSumCodec` for a decimal, bigint, number or int
 * `_sum` (which answers outside the field's domain), `compileScalarCodec`
 * otherwise, with the DECLARED nullability switched off because the
 * projection's own `nullable` is the fact — an aggregate over a non-null
 * column still publishes `null` for an empty window.
 *
 * The leaves with no declaring scalar are the read owner's OWN values, not a
 * column's meaning: `_count` (including a relation count), `exist`, and the
 * number a non-decimal `_avg` or a `_distance` publishes. Naming those three is
 * not a second scalar authority.
 *
 * Those three exhaust the scalar-less leaves `Queries` constructs, so the last
 * arm names a state this engine cannot be in when it is right: an INVARIANT,
 * not a refusal a caller can reach (N4, plan §4). `Leaf.type` is a `string`
 * because it also carries every declared scalar's type name, so the compiler
 * cannot close the set here; the assertion states the fact the leaf builder
 * upstream established.
 */
function leafCodec(leaf: Leaf, requestedOperation: string): ValueCodec {
  const declared = leaf.scalar;
  let value: ValueCodec;
  if (declared) {
    value = leaf.widened
      ? compileWidenedSumCodec(declared)
      : compileScalarCodec(declared, false);
  } else if (leaf.type === "boolean") value = booleanCodec();
  else if (leaf.type === "int") value = countCodec();
  else if (leaf.type === "number") value = numberCodec();
  else
    throw new EngineInvariantError(
      `Cannot detach a '${leaf.type}' result for '${requestedOperation}': its scalar declaration is missing.`
    );
  return leaf.nullable ? nullableCodec(value) : value;
}
