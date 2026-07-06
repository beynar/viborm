// Select and include schema factories

import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

// =============================================================================
// SELECT SCHEMA
// =============================================================================

/**
 * Build select schema - boolean selection for each scalar field, nested select for relations
 */
type ModelStateOf<M extends AnyModel> = M["~"]["state"];

export type SelectSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromKeys<StringKeyOf<ModelStateOf<M>["scalars"]>[], V.Boolean>["entries"] &
    V.FromObject<F["relations"], "select">["entries"] & {
      _count: V.Object<
        {
          select: V.FromObject<
            F["relations"],
            "countFilter",
            { optional: true }
          >;
        },
        { optional: true }
      >;
    }
>;

export const getSelectSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): SelectSchema<M, F> => {
  // Scalar fields: simple boolean selection
  const scalarKeys = Object.keys(fieldSchemas.scalars) as StringKeyOf<
    ModelStateOf<M>["scalars"]
  >[];
  const optionalBoolean = v.boolean({ optional: true });
  const scalarEntries = v.fromKeys<
    StringKeyOf<ModelStateOf<M>["scalars"]>[],
    typeof optionalBoolean
  >(scalarKeys, optionalBoolean);

  // Relations: use relation's select schema (supports boolean or nested)
  const relationEntries = v.fromObject<F["relations"], "select">(
    fieldSchemas.relations,
    "select"
  );

  // _count entries: use a schema that accepts true or { where: ... }
  // This is different from the relation's select schema - we only need the filter capability
  const countSelectEntries = v.fromObject<
    F["relations"],
    "countFilter",
    { optional: true }
  >(fieldSchemas.relations, "countFilter", {
    optional: true,
  });

  return v.object({
    ...scalarEntries.entries,
    ...relationEntries.entries,
    _count: v.object(
      {
        select: countSelectEntries,
      },
      { optional: true }
    ),
  });
};

// =============================================================================
// INCLUDE SCHEMA
// =============================================================================

/**
 * Build include schema - nested include for each relation
 */

type RelationSchemaBundle = { relations: Record<string, any> };

export type IncludeSchema<F extends RelationSchemaBundle> = V.FromObject<
  F["relations"],
  "include",
  { optional: true }
>;

export const getIncludeSchema = <F extends RelationSchemaBundle>(
  schemas: F
): IncludeSchema<F> => {
  // Relations: use relation's include schema (supports boolean or nested with where/orderBy/etc.)
  return v.fromObject<F["relations"], "include", { optional: true }>(
    schemas.relations,
    "include",
    {
      optional: true,
    }
  );
};
