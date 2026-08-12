import type { AnyModel, ModelState } from "@schema/model";
import type { RequiredScalarKeys as ModelRequiredScalarKeys } from "@schema/model/helper";
import type { RelationState } from "@schema/relation/types";
import type { Scalar } from "@schema/scalars";
import type { ObjectSchema } from "../../primitives/object";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";

// =============================================================================
// SCALAR CREATE
// =============================================================================

/**
 * Build scalar create schema - all scalar fields for create input
 */

type ModelStateOf<M extends AnyModel> = M["~"]["state"];
type ForeignKeyScalarKeys<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["relations"]]: ModelStateOf<M>["relations"][K]["~"]["state"] extends {
    type: "manyToOne" | "oneToOne";
    fields: readonly (infer ScalarKey extends string)[];
  }
    ? ScalarKey
    : never;
}[keyof ModelStateOf<M>["relations"]];
type CreateRequirementKeySetGroup<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["relations"]]: ModelStateOf<M>["relations"][K]["~"]["state"] extends {
    type: "manyToOne" | "oneToOne";
    fields: readonly (infer ScalarKey extends string)[];
  }
    ? ModelStateOf<M>["relations"][K]["~"]["state"] extends { optional: true }
      ? never
      : readonly [readonly ScalarKey[], readonly [Extract<K, string>]]
    : never;
}[keyof ModelStateOf<M>["relations"]];
type PolymorphicCreateRequirementKeySetGroup<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["polymorphicRelations"]]: ModelStateOf<M>["polymorphicRelations"][K]["~"]["state"] extends {
    optional: true;
  }
    ? never
    : readonly [readonly [Extract<K, string>]];
}[keyof ModelStateOf<M>["polymorphicRelations"]];
type CreateRequirementGroup<M extends AnyModel> =
  | CreateRequirementKeySetGroup<M>
  | PolymorphicCreateRequirementKeySetGroup<M>;
type OmittedRequiredKeyUnion<TKeys extends readonly string[] | undefined> =
  TKeys extends readonly (infer Key extends string)[] ? Key : never;
type ScalarCreateEntries<F extends { scalars: Record<string, unknown> }> =
  V.FromObject<F["scalars"], "create">["entries"];
type ScalarCreateInputShape<F extends { scalars: Record<string, unknown> }> = {
  [K in keyof ScalarCreateEntries<F>]: V.Input<ScalarCreateEntries<F>[K]>;
};
type RequireScalarKeys<T, K extends string> = {
  [P in keyof T as P extends K ? never : P]?: T[P];
} & {
  [P in keyof T as P extends K ? P : never]-?: T[P];
};
type RequiredModelScalarKeys<M extends AnyModel> = {
  [K in keyof ModelStateOf<M>["scalars"]]: ModelStateOf<M>["scalars"][K]["~"]["state"]["optional"] extends true
    ? never
    : Extract<K, string>;
}[keyof ModelStateOf<M>["scalars"]];
type RequiredScalarCreateKeys<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
  OmittedRequiredKeys extends string = never,
> = Extract<
  Exclude<RequiredModelScalarKeys<M>, OmittedRequiredKeys>,
  keyof ScalarCreateEntries<F>
>;
type NestedScalarCreateInput<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
  OmittedRequiredKeys extends string,
> = RequireScalarKeys<
  ScalarCreateInputShape<F>,
  RequiredScalarCreateKeys<M, F, OmittedRequiredKeys>
>;

type NestedRequiredScalarKeys<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = RequiredScalarCreateKeys<M, F, ForeignKeyScalarKeys<M>>;

export type ScalarCreateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<
  F["scalars"],
  "create",
  {
    atLeast: ModelRequiredScalarKeys<ModelStateOf<M>["shape"]>[];
  }
>;
export const getScalarCreate = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  scalarSchemas: F
): ScalarCreateSchema<M, F> => {
  const state = model["~"].state;
  const requiredScalars = Object.keys(state.scalars).filter((key) => {
    const scalar = state.shape[key] as Scalar;
    if (scalar["~"]["state"]["optional"]) {
      return false;
    }
    return true;
  }) as ModelRequiredScalarKeys<ModelStateOf<M>["shape"]>[];
  return v.fromObject<
    F["scalars"],
    "create",
    {
      atLeast: ModelRequiredScalarKeys<ModelStateOf<M>["shape"]>[];
    }
  >(scalarSchemas.scalars, "create", {
    atLeast: requiredScalars,
  });
};

/**
 * Root `createMany` rows: the ORDINARY create data shape (plan §6 J1), minus the
 * one exclusion root `createMany` keeps.
 *
 * The entries are the create schema's, key for key, with ONE substitution: the
 * polymorphic memberships stay at mode `"createMany"` — the connect-only union
 * (`relations/polymorphic/create-many.ts`). That is not a leftover. A row whose
 * ONLY relation work is a direct polymorphic `connect` is still bulk-compatible,
 * and the engine groups those connects into one probe per (relation, variant)
 * across the whole payload (`bulk-polymorphic-connect.ts`); plan §5.1 keeps that
 * route's SQL. Widening the membership to the full `"create"` union would make
 * such a row relation-BEARING and route it to the record series a row at a time,
 * which the plan does not ask for.
 *
 * Everything else is `getCreateSchema` verbatim, including WHY: foreign-key
 * columns become optional (a row may spell the edge as a relation instead), and
 * `requiresOneOfKeySets` — the one owner of "an edge required on create must
 * arrive one way or the other" — replaces the blunt required-scalar list. The
 * required-polymorphic keys move into that same derivation, so a row that omits
 * one now fails with the create family's sentence rather than a second spelling
 * of it.
 */
export type BulkCreateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromObject<F["scalars"], "create">["entries"] &
    V.FromObject<F["relations"], "create">["entries"] &
    V.FromObject<F["polymorphic"], "createMany">["entries"],
  {
    atLeast: NestedRequiredScalarKeys<M, F>[];
    requiresOneOfKeySets: readonly CreateRequirementGroup<M>[];
  }
>;

export function getBulkCreate<M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): BulkCreateSchema<M, F> {
  const state = model["~"].state;
  const fkFields = getFkFields(state);
  const fkRequirementKeySets = getFkRequirementKeySets(state);
  const requiredScalars = getRequiredCreateScalars(state, fkFields);
  const scalarCreate = v.fromObject<F["scalars"], "create">(
    fieldSchemas.scalars,
    "create"
  );
  const relationCreate = v.fromObject<F["relations"], "create">(
    fieldSchemas.relations,
    "create"
  );
  const polymorphicCreateMany = v.fromObject<F["polymorphic"], "createMany">(
    fieldSchemas.polymorphic,
    "createMany"
  );
  return v.object(
    {
      ...scalarCreate.entries,
      ...relationCreate.entries,
      ...polymorphicCreateMany.entries,
    },
    {
      atLeast: requiredScalars,
      requiresOneOfKeySets: fkRequirementKeySets,
    }
  ) as unknown as BulkCreateSchema<M, F>;
}

/**
 * Build relation create schema - combines all relation create inputs
 */
export type RelationCreateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.FromObject<F["relations"], "create">;
export const getRelationCreate = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  fieldSchemas: F
): RelationCreateSchema<M, F> => {
  return v.fromObject<F["relations"], "create">(
    fieldSchemas.relations,
    "create"
  );
};

/**
 * Identify FK fields from relations.
 * FK fields are scalar fields that are referenced by manyToOne or oneToOne relations.
 */
function getFkFields(state: ModelState): Set<string> {
  const fkFields = new Set<string>();
  for (const relation of Object.values(state.relations)) {
    const relState = relation["~"].state as RelationState;
    // manyToOne and oneToOne relations have 'fields' pointing to FK columns
    if (
      (relState.type === "manyToOne" || relState.type === "oneToOne") &&
      relState.fields
    ) {
      for (const fk of relState.fields) {
        fkFields.add(fk);
      }
    }
  }
  return fkFields;
}

/**
 * The scalar keys a create payload must carry ITSELF: every scalar that is neither
 * optional, nor defaulted, nor an FK column (an FK may arrive through its relation
 * instead, which is what `requiresOneOfKeySets` then arbitrates).
 *
 * ONE derivation with two readers — {@link getCreateSchema} and {@link getBulkCreate}.
 * A root `createMany` row IS the ordinary create data shape, and "the entries are the
 * create schema's, key for key" is only true if the two families cannot drift on which
 * scalars are required; a second copy of this filter is exactly how they would.
 */
function getRequiredCreateScalars(
  state: ModelState,
  fkFields: Set<string>
): string[] {
  return Object.keys(state.scalars).filter((key) => {
    if (fkFields.has(key)) return false;
    const scalarState = state.scalars[key]!["~"].state;
    return !(scalarState.hasDefault || scalarState.optional);
  });
}

function getFkRequirementKeySets(state: ModelState): string[][][] {
  const groups: string[][][] = [];

  for (const [relationName, relation] of Object.entries(state.relations)) {
    const relState = relation["~"].state as RelationState;

    // Prisma parity: optional relations require nothing on create
    if (
      (relState.type === "manyToOne" || relState.type === "oneToOne") &&
      relState.fields &&
      !relState.optional
    ) {
      groups.push([relState.fields, [relationName]]);
    }
  }

  for (const [relationName, relation] of Object.entries(
    state.polymorphicRelations
  )) {
    if (!relation["~"].state.optional) {
      groups.push([[relationName]]);
    }
  }

  return groups;
}

export type NestedScalarCreateWithOmittedRequiredKeys<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
  OmittedRequiredKeys extends readonly string[] | undefined,
> = ObjectSchema<
  ScalarCreateEntries<F>,
  {
    atLeast: RequiredScalarCreateKeys<
      M,
      F,
      OmittedRequiredKeyUnion<OmittedRequiredKeys>
    >[];
  },
  NestedScalarCreateInput<M, F, OmittedRequiredKeyUnion<OmittedRequiredKeys>>
>;

export const getNestedScalarCreateWithOmittedRequiredKeys = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
  const OmittedRequiredKeys extends readonly string[] | undefined,
>(
  model: M,
  fieldSchemas: F,
  omittedRequiredKeys: OmittedRequiredKeys
): NestedScalarCreateWithOmittedRequiredKeys<M, F, OmittedRequiredKeys> => {
  const state = model["~"].state;
  const omittedRequiredKeySet = new Set(omittedRequiredKeys ?? []);

  // Get required scalar field names, excluding only caller-derived keys.
  const requiredScalars = Object.keys(state.scalars).filter((key) => {
    if (omittedRequiredKeySet.has(key)) return false;
    // Check if scalar has default or is optional
    const scalarState = state.scalars[key]!["~"].state;
    return !(scalarState.hasDefault || scalarState.optional);
  }) as RequiredScalarCreateKeys<
    M,
    F,
    OmittedRequiredKeyUnion<OmittedRequiredKeys>
  >[];

  const scalarCreate = v.fromObject<F["scalars"], "create">(
    fieldSchemas.scalars,
    "create"
  );

  return v.object(
    {
      ...scalarCreate.entries,
    },
    {
      atLeast: requiredScalars,
    }
  ) as unknown as NestedScalarCreateWithOmittedRequiredKeys<
    M,
    F,
    OmittedRequiredKeys
  >;
};

/**
 * Build full create schema - scalar + relation creates
 *
 * FK fields (like authorId) are optional because they can be derived from
 * nested relation operations (connect, create).
 */
export type CreateSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromObject<F["scalars"], "create">["entries"] &
    V.FromObject<F["relations"], "create">["entries"] &
    V.FromObject<F["polymorphic"], "create">["entries"],
  {
    atLeast: NestedRequiredScalarKeys<M, F>[];
    requiresOneOfKeySets: readonly CreateRequirementGroup<M>[];
  }
>;
export const getCreateSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  model: M,
  fieldSchemas: F
): CreateSchema<M, F> => {
  const state = model["~"].state;
  // Identify FK fields - these should be optional when using connect/create
  const fkFields = getFkFields(state);
  const fkRequirementKeySets = getFkRequirementKeySets(state);

  // Get required scalar field names (non-FK fields without defaults or optional)
  const requiredScalars = getRequiredCreateScalars(
    state,
    fkFields
  ) as ModelRequiredScalarKeys<ModelStateOf<M>["shape"]>[];

  // Build scalar schema with FK fields as optional
  const scalarCreate = v.fromObject<F["scalars"], "create">(
    fieldSchemas.scalars,
    "create"
  );

  // Relation create is optional (you don't have to use connect/create)
  const relationCreate = v.fromObject<F["relations"], "create">(
    fieldSchemas.relations,
    "create"
  );
  const polymorphicCreate = v.fromObject<F["polymorphic"], "create">(
    fieldSchemas.polymorphic,
    "create"
  );

  return v.object(
    {
      ...scalarCreate.entries,
      ...relationCreate.entries,
      ...polymorphicCreate.entries,
    },
    {
      atLeast: requiredScalars as NestedRequiredScalarKeys<M, F>[],
      requiresOneOfKeySets:
        fkRequirementKeySets as unknown as readonly CreateRequirementGroup<M>[],
    }
  );
};
