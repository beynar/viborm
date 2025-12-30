// Select and include schema factories

import type { ModelState } from "../../model";
import type { StringKeyOf } from "@schema/model/helper";
import v from "../../../../validation";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
export const getSelectSchema = <T extends ModelState>(state: T) => {
  // Scalar fields: simple boolean selection
  const scalarKeys = Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[];
  const optionalBoolean = v.boolean({ optional: true });
  const scalarEntries = v.fromKeys<
    StringKeyOf<T["scalars"]>[],
    typeof optionalBoolean
  >(scalarKeys, optionalBoolean);

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject<
    T["relations"],
    "~.schemas.select",
    { optional: true }
  >(state.relations, "~.schemas.select", {
    optional: true,
  });

  // _count entries: use a schema that accepts true or { where: ... }
  // This is different from the relation's select schema - we only need the filter capability
  const countSelectEntries = v.fromObject<
    T["relations"],
    "~.schemas.countFilter",
    { optional: true }
  >(state.relations, "~.schemas.countFilter", {
    optional: true,
  });
  const countSchema = v.object(
    {
      select: v.object(countSelectEntries.entries),
    },
    { optional: true }
  );

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
    _count: countSchema,
  });
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Build include schema - nested include for each relation
 */
export const getIncludeSchema = <T extends ModelState>(state: T) => {
  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  const relationEntries = v.fromObject<
    T["relations"],
    "~.schemas.include",
    { optional: true }
  >(state.relations, "~.schemas.include", {
    optional: true,
  });

  return v.object({
    ...relationEntries.entries,
  });
};
