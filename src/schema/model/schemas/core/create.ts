import type { ModelState } from "../../model";
import v from "../../../../validation";
import type { RequiredFieldKeys, StringKeyOf } from "@schema/model/helper";

// =============================================================================
// SCALAR CREATE
// =============================================================================

/**
 * Build scalar create schema - all scalar fields for create input
 */
export const getScalarCreate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["scalars"], "~.schemas.create", { partial: false }>(
    state.scalars,
    "~.schemas.create",
    { partial: false }
  );
};

/**
 * Build relation create schema - combines all relation create inputs
 */
export const getRelationCreate = <T extends ModelState>(state: T) => {
  return v.fromObject<T["relations"], "~.schemas.create">(
    state.relations,
    "~.schemas.create"
  );
};

/**
 * Identify FK fields from relations.
 * FK fields are scalar fields that are referenced by manyToOne or oneToOne relations.
 */
function getFkFields<T extends ModelState>(state: T): Set<string> {
  const fkFields = new Set<string>();
  for (const relation of Object.values(state.relations)) {
    const relState = (relation as any)["~"]?.state;
    if (!relState) continue;
    // manyToOne and oneToOne relations have 'fields' pointing to FK columns
    if (
      (relState.type === "manyToOne" || relState.type === "oneToOne") &&
      relState.fields
    ) {
      const fields = Array.isArray(relState.fields)
        ? relState.fields
        : [relState.fields];
      for (const fk of fields) {
        fkFields.add(fk);
      }
    }
  }
  return fkFields;
}

/**
 * Build full create schema - scalar + relation creates
 *
 * FK fields (like authorId) are optional because they can be derived from
 * nested relation operations (connect, create).
 */
export const getCreateSchema = <T extends ModelState>(state: T) => {
  // Identify FK fields - these should be optional when using connect/create
  const fkFields = getFkFields(state);

  // Get required scalar field names (non-FK fields without defaults or optional)
  const requiredScalars = (
    Object.keys(state.scalars) as StringKeyOf<T["scalars"]>[]
  ).filter((key) => {
    // FK fields are optional (can use connect instead)
    if (fkFields.has(key)) return false;
    // Check if field has default or is optional
    const field = state.scalars[key] as any;
    const fieldState = field?.["~"]?.state;
    return !fieldState.hasDefault && !fieldState.optional;
  }) as RequiredFieldKeys<T["fields"]>[];

  // Build scalar schema with FK fields as optional
  const scalarCreate = v.fromObject<
    T["scalars"],
    "~.schemas.create",
    {
      partial: true;
      atLeast: RequiredFieldKeys<T["fields"]>[];
      name: "create";
    }
  >(state.scalars, "~.schemas.create", {
    partial: true,
    atLeast: requiredScalars,
    name: "create",
  });

  // Relation create is optional (you don't have to use connect/create)
  const relationCreate = v.fromObject<T["relations"], "~.schemas.create">(
    state.relations,
    "~.schemas.create"
  );

  return scalarCreate.extend(relationCreate.entries);
};
