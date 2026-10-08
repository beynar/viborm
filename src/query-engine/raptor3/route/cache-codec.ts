import { CacheConfigurationError } from "@errors";
import type { CacheResultCodec } from "../../cache-flow";
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
} from "../../result/cache-value-codecs";
import type { PreparedRead } from "../commands";
import { EngineInvariantError } from "../shared/invariant";
import type { Leaf, ProjectionShape } from "../shared/query";

/**
 * The detached cache representation of one prepared read.
 *
 * Every value codec here comes from the OFFICIAL owner
 * (`src/query-engine/result/cache-value-codecs.ts`), addressed the way that
 * owner is addressed — by the declaring `Scalar` object, never by a leaf's type
 * name — so the candidate adds no scalar-meaning authority and a cached value
 * materializes exactly as a freshly parsed one does. The STRUCTURE comes from
 * the prepared read's own published facts (`shape`, `value`, `single`,
 * `empty`), which the read owner states beside the statement it decodes, so the
 * codec and the decoder cannot disagree about cardinality.
 */
export function cacheCodec(
  read: PreparedRead,
  requestedOperation: string
): CacheResultCodec {
  // The read owner's own publication for zero rows says whether the public
  // value may be absent: `null` for a located row, `[]`/`{}`/`0`/`false` for
  // the shapes that always publish a value.
  const value = shapeCodec(read.value, requestedOperation);
  const compiled = read.empty === null ? nullableCodec(value) : value;
  return Object.freeze({
    snapshot(input: unknown): unknown {
      try {
        return compiled.snapshot(input, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The operation result cannot be represented by the cache result codec.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "snapshot", operation: requestedOperation },
          }
        );
      }
    },
    materialize(snapshot: unknown): unknown {
      try {
        return compiled.materialize(snapshot, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The cached result snapshot is malformed.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "materialize", operation: requestedOperation },
          }
        );
      }
    },
  });
}

/** One published shape, composed from the official structural codecs. */
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
 * compiles it: `compileWidenedSumCodec` for a decimal `_sum` (which keeps the
 * field's scale and drops its precision), `compileScalarCodec` otherwise, with
 * the DECLARED nullability switched off because the projection's own
 * `nullable` is the fact — an aggregate over a non-null column still publishes
 * `null` for an empty window.
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
      `The Raptor 3 route cannot encode a cached '${leaf.type}' result for '${requestedOperation}': the leaf publishes no declaring scalar.`
    );
  return leaf.nullable ? nullableCodec(value) : value;
}
