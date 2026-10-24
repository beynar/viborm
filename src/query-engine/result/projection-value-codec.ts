import {
  arrayCodec,
  nullableCodec,
  recordCodec,
  recursiveRelationCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "./cache-value-codecs";
import type { Leaf, ProjectionShape } from "./projection-shape";

/** One published shape, composed from the official structural codecs. */
export function compileProjectionValue(
  shape: ProjectionShape | Leaf,
  leafCodec: (leaf: Leaf) => ValueCodec
): ValueCodec {
  // biome-ignore lint/style/useDefaultSwitchClause: the published shape union is exhaustive; a default would be dead code.
  switch (shape.kind) {
    case "scalar":
      return leafCodec(shape);
    case "object": {
      const fields = new Map<string, ValueCodec>();
      for (const [name, field] of Object.entries(shape.fields))
        fields.set(name, compileProjectionValue(field, leafCodec));
      const record = recordCodec(fields);
      return shape.nullable === false ? record : nullableCodec(record);
    }
    case "collection":
      return arrayCodec(compileProjectionValue(shape.row, leafCodec));
    case "variants": {
      const arms = new Map<string, ValueCodec>();
      for (const [type, arm] of Object.entries(shape.arms))
        arms.set(
          type,
          compileProjectionValue(
            shape.many && arm.kind === "collection" ? arm.row : arm,
            leafCodec
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
        compileProjectionValue(shape.row, leafCodec)
      );
  }
}
