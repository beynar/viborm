import v, { type V } from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";

/**
 * Ordering a parent BY a polymorphic slot.
 *
 * A COLLECTION offers exactly one thing to order by: how many members it has.
 * That is the same offer an ordinary to-many relation makes
 * (`toManyOrderByFactory`), and it is deliberately the same shape — the engine
 * lowers both through one summed-count expression, so a second spelling here
 * would be a second thing to keep in step.
 *
 * Ordering by a member's COLUMN is not offered and cannot be: which table the
 * column lives in is decided per row by the discriminator, so `orderBy:
 * { items: { title: "asc" } }` names a column that exists for some members and
 * not others. The plan does not add root ordering through a to-one slot either,
 * for the same reason — hence the named refusal below rather than an omitted
 * key, so the caller reads WHY instead of "Unknown key".
 */
export type PolymorphicCollectionOrderBySchema = V.Object<{
  _count: V.Enum<["asc", "desc"]>;
}>;

export const polymorphicCollectionOrderByFactory =
  (): PolymorphicCollectionOrderBySchema =>
    v.object({
      _count: v.enum(["asc", "desc"]),
    });

export const polymorphicToOneOrderByRefusal = (): VibSchema<never, never> =>
  v.refused(
    "A polymorphic to-one slot cannot be ordered on: the target model is chosen per row, so there is no single column to sort by."
  );
