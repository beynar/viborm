import type { VariantRelationState } from "@schema/relation";
import v from "@validation/primitives/v";
import type {
  CoreInputAt,
  CoreOutputAt,
  PolymorphicTargetSchemaGetters,
} from "./types";
import { polymorphicPublicTypes } from "./types";

/**
 * THE TAGGED TARGET PREDICATE — `{ type }`, `{ type, is }`, `{ type, isNot }`,
 * unioned over every configured public discriminator.
 *
 * One shape, three consumers, one owner:
 *  - the to-one `filter` family (`./filter.ts`), where it sits beside the
 *    null-presence arms an optional slot adds;
 *  - a collection's `{ some | every | none }` quantifiers, which have NO
 *    presence arm at all (an empty collection is not a null one);
 *  - a collection's filtered `_count` (`./count-filter.ts`).
 *
 * It is a FUNCTION of the state, not a shared singleton: `is`/`isNot` resolve
 * through the per-variant `where` thunk, so the schema each caller receives is
 * bound to that caller's target getters.
 *
 * `{ partial: false }` on every member is what makes `type` mandatory and the
 * union's arms mutually exclusive — `{ type, is, isNot }` matches none of them.
 */

type TaggedPredicateFor<Getters, PublicType extends keyof Getters, IsAt> =
  | { readonly type: PublicType; readonly is?: never; readonly isNot?: never }
  | {
      readonly type: PublicType;
      readonly is: IsAt;
      readonly isNot?: never;
    }
  | {
      readonly type: PublicType;
      readonly is?: never;
      readonly isNot: IsAt;
    };

/** The value a caller writes: one tagged arm per configured variant. */
export type TaggedPredicateInput<Getters> = {
  [PublicType in keyof Getters]: TaggedPredicateFor<
    Getters,
    PublicType,
    CoreInputAt<Getters, PublicType, "where">
  >;
}[keyof Getters];

/** The value the engine receives, with each variant's `where` parsed. */
export type TaggedPredicateOutput<Getters> = {
  [PublicType in keyof Getters]: TaggedPredicateFor<
    Getters,
    PublicType,
    CoreOutputAt<Getters, PublicType, "where">
  >;
}[keyof Getters];

export function taggedTargetPredicate<State extends VariantRelationState>(
  state: State,
  targetSchemas: PolymorphicTargetSchemaGetters<State>
) {
  const targetMembers = polymorphicPublicTypes(state).flatMap((publicType) => {
    const schemas = targetSchemas[publicType];
    return [
      v.object({ type: v.literal(publicType) }, { partial: false }),
      v.object(
        {
          type: v.literal(publicType),
          is: () => schemas().core.where,
        },
        { partial: false }
      ),
      v.object(
        {
          type: v.literal(publicType),
          isNot: () => schemas().core.where,
        },
        { partial: false }
      ),
    ];
  });
  return v.union(targetMembers);
}
