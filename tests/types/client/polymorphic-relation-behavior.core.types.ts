/**
 * The unnamed-arm read, typed over the polymorphic relation behavior's own
 * schema and the exact selections its runtime cell reads
 * (`tests/contracts/drivers/behaviors/polymorphic-relation-schema.ts`).
 *
 * The runtime cell (polymorphic-relation-behavior.ts, "an arm the selection
 * leaves unnamed reads at its default projection") reads these rows; the
 * renderer cell in schema-introspection.core.test.ts renders the same
 * selections over the same schema object. Here the inferred client type says
 * the same thing: `video`, named nowhere, keeps its default scalar projection,
 * and the optional slot adds `null`.
 */

import type { OperationResult } from "@client/types";
import type {
  polymorphicRelationSchema,
  unnamedArmSelections,
} from "@tests/contracts/drivers/behaviors/polymorphic-relation-schema";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type Schema = typeof polymorphicRelationSchema;

type UnnamedArmUnion =
  | { readonly type: "post"; readonly data: { title: string } }
  | {
      readonly type: "video";
      readonly data: { id: number; slug: string; title: string };
    };

type RequiredRows = OperationResult<
  "findMany",
  Schema["requiredComment"],
  { select: typeof unnamedArmSelections.requiredComment }
>;
type _requiredSlotReadsTheUnnamedArmAtItsDefault = Expect<
  Equal<RequiredRows[number], { id: number; subject: UnnamedArmUnion }>
>;

type OptionalRow = OperationResult<
  "findUniqueOrThrow",
  Schema["comment"],
  { select: typeof unnamedArmSelections.comment }
>;
type _optionalSlotAddsNull = Expect<
  Equal<OptionalRow, { id: number; commentable: UnnamedArmUnion | null }>
>;
