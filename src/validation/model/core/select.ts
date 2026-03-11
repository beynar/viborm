// Select and include schema factories

import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import { AnyFieldSchema, FieldSchemas } from "@validation/builder";
import { AnyModel } from "@schema/model";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
export type SelectSchema<T extends ModelState> = V.Object<
  V.FromKeys<StringKeyOf<T["scalars"]>[], V.Boolean>["entries"] &
    V.FromObject<T["relations"], "~.schemas.select">["entries"] & {
      _count: V.Object<
        {
          select: V.FromObject<
            T["relations"],
            "~.schemas.countFilter",
            { optional: true }
          >;
        },
        { optional: true }
      >;
    }
>;

export const getSelectSchema = <T extends ModelState>(
  state: T,
): SelectSchema<T> => {
  // Scalar fields: simple boolean selection
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];
  const optionalBoolean = v.boolean({ optional: true });
  const scalarEntries = v.fromKeys<
    StringKeyOf<T["scalars"]>[],
    typeof optionalBoolean
  >(scalarKeys, optionalBoolean);

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject<T["relations"], "~.schemas.select">(
    state.relations,
    "~.schemas.select",
  );

  // _count entries: use a schema that accepts true or { where: ... }
  // This is different from the relation's select schema - we only need the filter capability
  const countSelectEntries = v.fromObject<
    T["relations"],
    "~.schemas.countFilter",
    { optional: true }
  >(state.relations, "~.schemas.countFilter", {
    optional: true,
  });

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
    _count: v.object(
      {
        select: countSelectEntries,
      },
      { optional: true },
    ),
  });
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Build include schema - nested include for each relation
 */

export type IncludeSchema<F extends AnyFieldSchema> = V.FromObject<
  F["relations"],
  "include",
  { optional: true }
>;

export const getIncludeSchema = <F extends AnyFieldSchema>(
  schemas: F,
): IncludeSchema<F> => {
  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  return v.fromObject<F["relations"], "include", { optional: true }>(
    schemas.relations,
    "include",
    {
      optional: true,
    },
  );
};
