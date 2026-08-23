import type { AnyModel, ModelState } from "@schema/model";
import type { RequiredScalarKeys as ModelRequiredScalarKeys } from "@schema/model/helper";
import { slotMayBeEmpty } from "@schema/relation/clearability";
import type {
  Cardinality,
  SlotMayBeEmpty,
} from "@schema/relation/static-membership";
import type { RelationState } from "@schema/relation/types";
import type { Scalar } from "@schema/scalars";
import type { ResolvedSlot } from "@schema/validation/relation-resolution";
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
type ModelRelations<M extends AnyModel> = ModelStateOf<M>["relations"];

/** The local half of every foreign key this model's own relations store. */
type ForeignKeyScalarKeys<M extends AnyModel> = {
  [K in keyof ModelRelations<M>]: ModelRelations<M>[K]["~"]["state"] extends {
    readonly foreignKey: {
      readonly fields: readonly (infer ScalarKey extends string)[];
    };
  }
    ? ScalarKey
    : never;
}[keyof ModelRelations<M>];

type RequiredForeignKeyMembers<
  M extends AnyModel,
  Members extends string,
> = Extract<Members, RequiredModelScalarKeys<M>>;

/**
 * One singular stored reference, as the key sets a create payload may satisfy
 * its non-produced columns with. An empty slot still needs every non-null member;
 * a nonempty slot needs the whole tuple. A column-producing relation input is the
 * other alternative in both cases.
 */
type CreateRequirementGroup<M extends AnyModel> = {
  [K in keyof ModelRelations<M>]: Cardinality<
    ModelRelations<M>[K]
  > extends "one"
    ? ModelRelations<M>[K]["~"]["state"] extends {
        readonly foreignKey: {
          readonly fields: readonly (infer ScalarKey extends string)[];
        };
      }
      ? [RequiredForeignKeyMembers<M, ScalarKey>] extends [never]
        ? never
        : readonly [
            readonly (SlotMayBeEmpty<M, K, ModelRelations<M>[K]> extends false
              ? ScalarKey
              : RequiredForeignKeyMembers<M, ScalarKey>)[],
            readonly [Extract<K, string>],
          ]
      : SlotMayBeEmpty<M, K, ModelRelations<M>[K]> extends false
        ? readonly [readonly [Extract<K, string>]]
        : never
    : never;
}[keyof ModelRelations<M>];
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
 * The entries are the create schema's, key for key, with ONE substitution — and
 * that substitution is now CARDINALITY-DISPATCHED, inside the `"createMany"`
 * family itself (`relations/polymorphic/index.ts`), not here:
 *
 *   - a direct polymorphic TO-ONE membership stays at the connect-only union
 *     (`relations/polymorphic/create-many.ts`). That is not a leftover. A row
 *     whose ONLY relation work is a direct polymorphic `connect` is still
 *     bulk-compatible, and the engine groups those connects into one probe per
 *     (relation, variant) across the whole payload
 *     (`bulk-polymorphic-connect.ts`); plan §5.1 keeps that route's SQL.
 *     Widening it to the full `"create"` union would make such a row
 *     relation-BEARING and route it to the record series a row at a time, which
 *     the plan does not ask for.
 *   - a polymorphic COLLECTION membership mounts the SAME family its `create`
 *     context does (plan §9.6). Its memberships are per-variant member junction
 *     rows that cannot exist before the owner row does, so the grouped INSERT
 *     could never express them; `routing.ts`'s `relationBearingRow` reads the
 *     collection half of the polymorphic set and routes the whole call to the
 *     relation-bearing record series.
 *
 * `getBulkCreate` itself is unchanged by that dispatch: it still asks
 * `v.fromObject(fieldSchemas.polymorphic, "createMany")` and the family key set
 * is still eight, so this function stays byte-identical across the change.
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
  fieldSchemas: F,
  slots: ReadonlyMap<string, ResolvedSlot>
): BulkCreateSchema<M, F> {
  const state = model["~"].state;
  const fkFields = getFkFields(state);
  const fkRequirementKeySets = getFkRequirementKeySets(state, slots);
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
 * The scalar keys this model's own relations store: the local half of every
 * foreign key it owns. A create payload may spell them directly or supply the
 * relation instead, which is what {@link getFkRequirementKeySets} arbitrates.
 */
function getFkFields(state: ModelState): Set<string> {
  const fkFields = new Set<string>();
  for (const relation of Object.values(state.relations)) {
    const foreignKey = relation["~"].state.foreignKey;
    if (!foreignKey) continue;
    for (const fk of foreignKey.fields) {
      fkFields.add(fk);
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
  return Object.keys(state.scalars).filter(
    (key) => !fkFields.has(key) && mustBeSuppliedOnCreate(state, key)
  );
}

/**
 * Must a create payload CARRY this scalar? Only when the row cannot produce it:
 * a default (and `.nullable()` installs one) means the statement supplies it.
 *
 * ONE predicate with two readers — the required-scalar list above and the
 * foreign-key requirement groups below. Both name a declared scalar of this
 * model: the first iterates `state.scalars` itself, and FK001 refuses a schema
 * whose `.fields(...)` names anything that is not one, so the lookup cannot
 * miss. Re-checking it here would make this a second owner of that invariant.
 */
function mustBeSuppliedOnCreate(state: ModelState, key: string): boolean {
  const scalarState = state.scalars[key]!["~"].state;
  return !(scalarState.hasDefault || scalarState.optional);
}

/**
 * "An edge required on create must arrive one way or the other."
 *
 * A stored reference contributes a group whenever at least one of its columns
 * must be supplied: an empty relation slot does not make a non-null compound
 * member optional. The payload may still supply that member through the relation
 * key, so the group keeps both alternatives. A carrier without columns contributes
 * a group only when the resolved slot may not be empty.
 *
 * A stored reference whose every local member is defaulted contributes NO
 * group: the statement produces the columns by itself, so there is nothing the
 * payload has to arrive with, and re-adding a requirement the FK exclusion
 * above only removed for convenience would refuse a legal row. A variant
 * singular slot has no spellable columns at all, so its own relation key is
 * the only way it can arrive.
 */
function getFkRequirementKeySets(
  state: ModelState,
  slots: ReadonlyMap<string, ResolvedSlot>
): readonly (readonly (readonly string[])[])[] {
  const groups: (readonly (readonly string[])[])[] = [];

  for (const [relationName, relation] of Object.entries(state.relations)) {
    const relState: RelationState = relation["~"].state;
    if (relState.cardinality !== "one") continue;
    const foreignKey = relState.foreignKey;
    if (foreignKey) {
      const requiredMembers = foreignKey.fields.filter((key) =>
        mustBeSuppliedOnCreate(state, key)
      );
      if (requiredMembers.length > 0) {
        const resolved = slots.get(relationName);
        const requiredKeySet =
          resolved && !slotMayBeEmpty(resolved)
            ? foreignKey.fields
            : requiredMembers;
        groups.push([requiredKeySet, [relationName]]);
      }
      continue;
    }
    const resolved = slots.get(relationName);
    if (resolved && !slotMayBeEmpty(resolved)) {
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
  fieldSchemas: F,
  slots: ReadonlyMap<string, ResolvedSlot>
): CreateSchema<M, F> => {
  const state = model["~"].state;
  // Identify FK fields - these should be optional when using connect/create
  const fkFields = getFkFields(state);
  const fkRequirementKeySets = getFkRequirementKeySets(state, slots);

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
